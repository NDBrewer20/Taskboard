// The board's half of the agent integration.
//
// The bridge holds ops the agent has queued. This pulls them, applies them through the same
// builders the UI uses so positions and types stay right, and posts back the board plus a
// line about what each op did. Everything still lives in the browser, nothing is exported.

import { allItems, buildBoard, buildChecklist, buildColumn, buildItem, buildNote, columnColors, database,
  dropNoteItem, mapItems, moveColumn, moveNote, noteItems, rollUpNote, setBoardArchived, setColumnArchived,
  setNoteArchived, sweepNote, updateBoard, updateColumn, updateNote } from "./db";
import type { Board, Category, Checklist, ChecklistItem, Note, NoteType } from "./types";

// the connector runs inside the agent on this machine, so there is only ever one place
// to look. loopback, never anywhere else
export const BRIDGE = "http://127.0.0.1:4319";

export type BridgeOp = {
  id: string;
  type: string;
  name?: string;
  board?: string;
  column?: string;
  task?: string;
  step?: string;
  under?: string;
  checklist?: string;
  title?: string;
  text?: string;
  description?: string;
  steps?: string[];
  done?: boolean;
  // an archive op that is putting something back rather than taking it off the board. it
  // also decides which pool the thing is looked for in, since what is archived is filtered
  // out of the live one
  restore?: boolean;
  color?: string;
  noteType?: string;
  index?: number;
};

// message is the line the walkthrough logs, data is for the ops that are a question
// rather than a change - the board an agent asked to read comes back in here
export type OpResult = { id: string; ok: boolean; message: string; data?: unknown };

export type BridgeHealth = { ok: boolean; port?: number; root?: string; listening?: boolean; mcp?: boolean; waits?: boolean; message?: string };

// what the board looks like to the agent. names, not ids, are how it addresses things
type StepView = { id: string; text: string; done: boolean; steps: StepView[] };
type TaskView = { id: string; title: string; type: string; done: boolean; description: string; checklists: { name: string; steps: StepView[] }[] };
type BoardView = { board: string; boardId: string; columns: { name: string; tasks: TaskView[] }[]; boards: string[] };

const stepView = (item: ChecklistItem): StepView =>
  ({ id: item.id, text: item.text, done: item.completed, steps: item.items.map(stepView) });

export function snapshot(board: Board, boards: Board[], columns: Category[], notes: Note[]): BoardView {
  return {
    board: board.name,
    boardId: board.id,
    boards: boards.filter((row) => !row.archivedAt).map((row) => row.name),
    columns: columns.map((column) => ({
      name: column.name,
      tasks: notes
        .filter((note) => note.categoryId === column.id && !note.archivedAt)
        .sort((a, b) => a.position - b.position)
        .map((note) => ({
          id: note.id, title: note.title, type: note.type, done: note.completed, description: note.content,
          checklists: note.checklists.map((list) => ({ name: list.name, steps: list.items.map(stepView) })),
        })),
    })),
  };
}

/* an agent says "the login task", not a uuid, so everything is matched by name. an exact
   match wins, otherwise a single partial one does, and anything ambiguous is an error
   rather than a guess at which one was meant. */

type Found<Row> = { row?: Row; error?: string };

function pick<Row>(rows: Row[], needle: string | undefined, label: (row: Row) => string, what: string): Found<Row> {
  if (!needle) return { error: `Which ${what}?` };
  const wanted = needle.trim().toLowerCase();
  const exact = rows.filter((row) => label(row).toLowerCase() === wanted || (row as { id?: string }).id === needle);
  const near = exact.length ? exact : rows.filter((row) => label(row).toLowerCase().includes(wanted));

  if (!near.length) return { error: `No ${what} called "${needle}".` };
  if (near.length > 1) return { error: `"${needle}" matches ${near.length} ${what}s: ${near.map(label).join(", ")}. Be more specific.` };
  return { row: near[0] };
}

// finds a step anywhere on a task, however deep it sits
const findStep = (note: Note, needle: string) =>
  pick(note.checklists.flatMap((list) => allItems(list.items)), needle, (item) => item.text, "step");

const stamp = () => new Date().toISOString();

// a tick from an agent should land the same way a click does, so it follows the same setting
function rollUpWanted() {
  try {
    const raw = localStorage.getItem("taskboard:settings");
    return raw ? JSON.parse(raw).rollUpSteps !== false : true;
  } catch { return true; }
}

async function boardFor(name?: string, archivedToo = false): Promise<Found<Board>> {
  const all = await database.boards.orderBy("position").toArray();
  const live = all.filter((row) => !row.archivedAt);

  // no name given means whatever board is open, which is the first live one. an archived
  // board is never that, however it was asked for
  if (!name) {
    if (!live.length) return { error: "There are no boards yet." };
    return { row: live[0] };
  }

  // putting a board back means finding it first, and an archived one is exactly what the
  // live list leaves out
  const pool = archivedToo ? all : live;
  if (!pool.length) return { error: "There are no boards yet." };
  return pick(pool, name, (row) => row.name, "board");
}

async function columnsOf(boardId: string) {
  return (await database.categories.where("boardId").equals(boardId).toArray())
    .filter((row) => !row.archivedAt)
    .sort((a, b) => a.position - b.position);
}

// every live task on a board, which is the pool a task name is matched against
async function tasksOf(boardId: string) {
  const columns = await columnsOf(boardId);
  const ids = new Set(columns.map((column) => column.id));
  return (await database.notes.toArray()).filter((note) => ids.has(note.categoryId) && !note.archivedAt);
}

/* Putting something back has to be able to find it, and what is archived is exactly what the
   two above leave out. So a restore looks in these instead - the same rows, unfiltered. */

const everyColumnOf = async (boardId: string) =>
  (await database.categories.where("boardId").equals(boardId).toArray()).sort((a, b) => a.position - b.position);

async function everyTaskOf(boardId: string) {
  const ids = new Set((await everyColumnOf(boardId)).map((column) => column.id));
  return (await database.notes.toArray()).filter((note) => ids.has(note.categoryId));
}

// puts a step on a task, either at the top of a checklist or under an existing step
function withStep(note: Note, listId: string, parent: ChecklistItem | null, step: ChecklistItem) {
  const under = (items: ChecklistItem[]): ChecklistItem[] => items.map((item) => item.id === parent?.id
    ? { ...item, items: [...item.items, step] }
    : { ...item, items: under(item.items) });

  return note.checklists.map((list) => list.id !== listId ? list
    : { ...list, items: parent ? under(list.items) : [...list.items, step] });
}

export async function applyOp(op: BridgeOp): Promise<OpResult> {
  const said = (ok: boolean, message: string) => ({ id: op.id, ok, message });

  if (op.type === "createBoard") {
    if (!op.name?.trim()) return said(false, "A board needs a name.");
    const boards = await database.boards.toArray();
    await database.boards.add(buildBoard(op.name.trim(), boards.length));
    return said(true, `Added the board "${op.name.trim()}".`);
  }

  // what an agent asked for rather than changed. the line still says what happened, so
  // the walkthrough's log stays readable instead of filling up with the board as json
  const handed = (message: string, data: unknown) => ({ id: op.id, ok: true, message, data });

  // every board with its columns and what is in them. this is how a name is found without
  // having to be on the board already, which is the thing reading one board cannot do
  if (op.type === "listBoards") {
    const boards = (await database.boards.orderBy("position").toArray()).filter((row) => !row.archivedAt);
    const notes = await database.notes.toArray();
    const listed = await Promise.all(boards.map(async (row) => ({
      name: row.name,
      columns: (await columnsOf(row.id)).map((column) => {
        const own = notes.filter((note) => note.categoryId === column.id && !note.archivedAt);
        return { name: column.name, tasks: own.length, done: own.filter((note) => note.completed).length };
      }),
    })));
    // which one an op that leaves out the board lands on, so it never has to be guessed at
    return handed(`${listed.length} board${listed.length === 1 ? "" : "s"}.`,
      { boards: listed, default: listed[0]?.name ?? null });
  }

  const board = await boardFor(op.board, op.restore === true);
  if (board.error) return said(false, board.error);
  const boardId = board.row!.id;

  // the same shape the open board is pushed up in, for whichever board was asked for.
  // it has to come through the tab like this - the connector only ever caches the open one
  if (op.type === "readBoard") {
    const boards = await database.boards.orderBy("position").toArray();
    const notes = await database.notes.orderBy("position").toArray();
    return handed(`Read the board "${board.row!.name}".`,
      snapshot(board.row!, boards, await columnsOf(boardId), notes));
  }

  if (op.type === "createColumn") {
    if (!op.name?.trim()) return said(false, "A column needs a name.");
    const columns = await columnsOf(boardId);
    await database.categories.add(buildColumn(boardId, op.name.trim(), columns.length));
    return said(true, `Added the column "${op.name.trim()}" to ${board.row!.name}.`);
  }

  if (op.type === "renameBoard") {
    if (!op.name?.trim()) return said(false, "A board needs a name.");
    const was = board.row!.name;
    await updateBoard(boardId, { name: op.name.trim() });
    return said(true, `Renamed the board "${was}" to "${op.name.trim()}".`);
  }

  if (op.type === "archiveBoard") {
    await setBoardArchived(boardId, !op.restore);
    return said(true, op.restore
      ? `Put the board "${board.row!.name}" back.`
      : `Archived the board "${board.row!.name}", with its columns and their tasks.`);
  }

  // the column ops, which all need one found first
  if (op.type === "updateColumn" || op.type === "archiveColumn" || op.type === "moveColumn") {
    const pool = op.restore ? await everyColumnOf(boardId) : await columnsOf(boardId);
    const found = pick(pool, op.column, (row) => row.name, "column");
    if (found.error) return said(false, found.error);
    const column = found.row!;

    if (op.type === "archiveColumn") {
      await setColumnArchived(column.id, !op.restore);
      return said(true, op.restore
        ? `Put the column "${column.name}" back.`
        : `Archived the column "${column.name}" and the tasks in it.`);
    }

    if (op.type === "moveColumn") {
      if (!Number.isFinite(op.index)) return said(false, "Which position should it go to?");
      // an agent counts positions among the columns it was shown, which leaves out anything
      // archived, so turn its number into the column the moved one should land in front of
      const rest = pool.filter((row) => row.id !== column.id && !row.archivedAt);
      await moveColumn(column.id, rest[Math.max(0, Math.trunc(op.index!))]?.id ?? null);
      return said(true, `Moved the column "${column.name}".`);
    }

    const changes: Partial<Category> = {};
    if (op.name?.trim()) changes.name = op.name.trim();
    if (op.color) {
      if (!columnColors.includes(op.color)) {
        return said(false, `"${op.color}" is not one of the colours: ${columnColors.join(", ")}.`);
      }
      changes.color = op.color;
    }
    if (!Object.keys(changes).length) return said(false, "Nothing to change on that column.");

    await updateColumn(column.id, changes);
    return said(true, `Changed the column "${column.name}".`);
  }

  if (op.type === "createTask") {
    if (!op.title?.trim()) return said(false, "A task needs a title.");
    const column = pick(await columnsOf(boardId), op.column, (row) => row.name, "column");
    if (column.error) return said(false, column.error);

    const rows = (await database.notes.toArray()).filter((note) => note.categoryId === column.row!.id);
    const steps = op.steps?.filter((step) => step.trim()) ?? [];
    const note = buildNote(column.row!.id, rows.length, steps.length ? "checklist" : "idea");

    await database.notes.add({
      ...note,
      title: op.title.trim(),
      content: op.description?.trim() ?? "",
      checklists: steps.length ? [buildChecklist(op.checklist?.trim() || "Checklist", steps)] : [],
    });

    const tail = steps.length ? ` with ${steps.length} step${steps.length === 1 ? "" : "s"}` : "";
    return said(true, `Added "${op.title.trim()}" to ${column.row!.name}${tail}.`);
  }

  // everything below works on a task, so find it once
  const task = pick(await (op.restore ? everyTaskOf(boardId) : tasksOf(boardId)), op.task, (row) => row.title, "task");
  if (task.error) return said(false, task.error);
  const note = task.row!;

  if (op.type === "addStep") {
    if (!op.text?.trim()) return said(false, "A step needs some text.");

    // a task with no checklist yet gets one, which is what makes it a checklist task
    let checklists: Checklist[] = note.checklists;
    if (!checklists.length) checklists = [buildChecklist(op.checklist?.trim() || "Checklist")];

    const list = op.checklist
      ? pick(checklists, op.checklist, (row) => row.name, "checklist")
      : { row: checklists[0] };
    if (list.error) return said(false, list.error);

    const parent = op.under ? findStep({ ...note, checklists }, op.under) : null;
    if (parent?.error) return said(false, parent.error);

    const step = buildItem(op.text.trim());
    const next = withStep({ ...note, checklists }, list.row!.id, parent?.row ?? null, step);
    await updateNote(note.id, { checklists: next, type: "checklist", updatedAt: stamp() });

    const where = op.under ? ` under "${parent!.row!.text}"` : "";
    return said(true, `Added the step "${step.text}" to "${note.title}"${where}.`);
  }

  if (op.type === "complete") {
    const done = op.done ?? true;

    // a step was named, so tick that rather than the task
    if (op.step) {
      const found = findStep(note, op.step);
      if (found.error) return said(false, found.error);

      // the step and everything under it, all the way down
      const sweep = (items: ChecklistItem[]): ChecklistItem[] =>
        items.map((item) => ({ ...item, completed: done, items: sweep(item.items) }));

      const flip = (items: ChecklistItem[]): ChecklistItem[] => items.map((item) => item.id === found.row!.id
        ? { ...item, completed: done, items: sweep(item.items) }
        : { ...item, items: flip(item.items) });

      const ticked = note.checklists.map((list) => ({ ...list, items: flip(list.items) }));
      const checklists = rollUpWanted() ? rollUpNote(ticked) : ticked;
      await updateNote(note.id, { checklists, updatedAt: stamp() });
      return said(true, `${done ? "Ticked" : "Unticked"} "${found.row!.text}" on "${note.title}".`);
    }

    // the steps come with it, so what the agent reads back next time cannot contradict itself
    const steps = noteItems(note.checklists).length;
    await updateNote(note.id, {
      completed: done, completedAt: done ? stamp() : undefined, updatedAt: stamp(),
      checklists: sweepNote(note.checklists, done),
    });

    const tail = steps ? ` and ${done ? "ticked" : "unticked"} its ${steps} step${steps === 1 ? "" : "s"}` : "";
    return said(true, `${done ? "Ticked off" : "Reopened"} "${note.title}"${tail}.`);
  }

  if (op.type === "updateTask") {
    const changes: Partial<Note> = {};
    if (op.title?.trim()) changes.title = op.title.trim();
    // a description is the one thing you might want to clear, so an empty string counts
    if (typeof op.description === "string") changes.content = op.description.trim();
    if (op.noteType) {
      const types: NoteType[] = ["checklist", "direction", "descriptor", "idea"];
      if (!types.includes(op.noteType as NoteType)) {
        return said(false, `"${op.noteType}" is not one of the types: ${types.join(", ")}.`);
      }
      changes.type = op.noteType as NoteType;
    }
    if (!Object.keys(changes).length) return said(false, "Nothing to change on that task.");

    await updateNote(note.id, { ...changes, updatedAt: stamp() });
    return said(true, `Changed "${note.title}".`);
  }

  if (op.type === "moveTask") {
    // staying in the same column and just moving up or down is a move too, so the column
    // is optional and defaults to the one it is already in
    let categoryId = note.categoryId;
    if (op.column) {
      const found = pick(await columnsOf(boardId), op.column, (row) => row.name, "column");
      if (found.error) return said(false, found.error);
      categoryId = found.row!.id;
    }

    // same as the column above, and in position order - the table hands rows back in id
    // order, so counting a position off an unsorted list would land it anywhere
    const sitting = (await database.notes.toArray())
      .filter((row) => row.categoryId === categoryId && !row.archivedAt && row.id !== note.id)
      .sort((a, b) => a.position - b.position);

    // no position asked for means the end of the column, which is what null is
    const before = Number.isFinite(op.index) ? sitting[Math.max(0, Math.trunc(op.index!))]?.id ?? null : null;
    await moveNote(note.id, categoryId, before);
    const where = op.column ? ` to ${op.column}` : "";
    return said(true, `Moved "${note.title}"${where}.`);
  }

  if (op.type === "addChecklist") {
    const name = op.checklist?.trim() || op.name?.trim();
    if (!name) return said(false, "A checklist needs a name.");
    if (note.checklists.some((list) => list.name.toLowerCase() === name.toLowerCase())) {
      return said(false, `"${note.title}" already has a checklist called "${name}".`);
    }

    await updateNote(note.id, {
      checklists: [...note.checklists, buildChecklist(name)], type: "checklist", updatedAt: stamp(),
    });
    return said(true, `Added the checklist "${name}" to "${note.title}".`);
  }

  if (op.type === "updateStep") {
    if (!op.text?.trim()) return said(false, "A step needs some text.");
    const found = findStep(note, op.step ?? "");
    if (found.error) return said(false, found.error);

    const was = found.row!.text;
    const checklists = note.checklists.map((list) => ({
      ...list,
      items: mapItems(list.items, (item) => (item.id === found.row!.id ? { ...item, text: op.text!.trim() } : item)),
    }));

    await updateNote(note.id, { checklists, updatedAt: stamp() });
    return said(true, `Changed "${was}" to "${op.text.trim()}" on "${note.title}".`);
  }

  // the one thing here that really goes. a step is part of its task rather than a row of
  // its own, so there is no archive for it to sit in - same as the x on it in the board
  if (op.type === "removeStep") {
    const found = findStep(note, op.step ?? "");
    if (found.error) return said(false, found.error);

    const under = found.row!.items.length;
    const checklists = dropNoteItem(note.checklists, found.row!.id);
    await updateNote(note.id, { checklists, updatedAt: stamp() });

    const tail = under ? ` and the ${under} step${under === 1 ? "" : "s"} under it` : "";
    return said(true, `Removed "${found.row!.text}"${tail} from "${note.title}". That one is not recoverable.`);
  }

  if (op.type === "archiveTask") {
    await setNoteArchived(note.id, !op.restore);
    return said(true, op.restore
      ? `Put "${note.title}" back on the board.`
      : `Archived "${note.title}". It is in the archive if you want it back.`);
  }

  return said(false, `Nothing here knows how to "${op.type}".`);
}

/* --- the loop the open tab runs while agent access is on --- */

// is the connector up. nothing is running when no agent is, which is normal
export async function findBridge(): Promise<{ base: string; info: BridgeHealth } | null> {
  try {
    const info = await (await fetch(`${BRIDGE}/health`)).json() as BridgeHealth;
    if (info?.ok) return { base: BRIDGE, info };
  } catch { /* not up */ }

  return null;
}

// the board the agent sees, read straight out of dexie so it is never a render behind
export async function currentView(boardId: string): Promise<BoardView | null> {
  const boards = await database.boards.orderBy("position").toArray();
  const live = boards.filter((row) => !row.archivedAt);
  const board = live.find((row) => row.id === boardId) ?? live[0];
  if (!board) return null;

  const columns = await columnsOf(board.id);
  const notes = await database.notes.orderBy("position").toArray();
  return snapshot(board, boards, columns, notes);
}

// one round of it: take what is queued, apply it, hand back the board and what happened.
//
// waitMs asks the connector to hold the line for that long rather than answer empty handed.
// a tab you are not looking at gets its timers cut to about one a minute, so polling on a
// timer is what makes an agent time out on a board buried in tabs. a held request is not a
// timer. only the pull carries the signal - cutting the sync short would lose what happened
export async function pump(base: string, boardId: string, waitMs = 0, signal?: AbortSignal): Promise<OpResult[]> {
  const held = waitMs > 0 ? `?wait=${waitMs}` : "";
  const pulled = await (await fetch(`${base}/ops${held}`, { signal })).json() as { ops?: BridgeOp[]; wantState?: boolean };
  const results: OpResult[] = [];

  // one at a time, a later op can depend on what an earlier one made
  for (const op of pulled.ops ?? []) {
    try { results.push(await applyOp(op)); }
    catch (error) { results.push({ id: op.id, ok: false, message: (error as Error).message }); }
  }

  const state = pulled.wantState || results.length ? await currentView(boardId) : null;
  await fetch(`${base}/sync`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, results }),
  });

  return results;
}
