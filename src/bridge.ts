// The board's half of the agent integration.
//
// The bridge holds ops the agent has queued. This pulls them, applies them through the same
// builders the UI uses so positions and types stay right, and posts back the board plus a
// line about what each op did. Everything still lives in the browser, nothing is exported.

import { allItems, buildBoard, buildChecklist, buildColumn, buildItem, buildNote, database, noteItems, rollUpNote,
  setNoteArchived, sweepNote, updateNote } from "./db";
import type { Board, Category, Checklist, ChecklistItem, Note } from "./types";

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
};

export type OpResult = { id: string; ok: boolean; message: string };

export type BridgeHealth = { ok: boolean; port?: number; root?: string; listening?: boolean; mcp?: boolean; message?: string };

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

async function boardFor(name?: string): Promise<Found<Board>> {
  const boards = (await database.boards.orderBy("position").toArray()).filter((row) => !row.archivedAt);
  if (!boards.length) return { error: "There are no boards yet." };
  // no name given means whatever board is open, which is the first live one
  if (!name) return { row: boards[0] };
  return pick(boards, name, (row) => row.name, "board");
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

  const board = await boardFor(op.board);
  if (board.error) return said(false, board.error);
  const boardId = board.row!.id;

  if (op.type === "createColumn") {
    if (!op.name?.trim()) return said(false, "A column needs a name.");
    const columns = await columnsOf(boardId);
    await database.categories.add(buildColumn(boardId, op.name.trim(), columns.length));
    return said(true, `Added the column "${op.name.trim()}" to ${board.row!.name}.`);
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
  const task = pick(await tasksOf(boardId), op.task, (row) => row.title, "task");
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

  if (op.type === "archiveTask") {
    await setNoteArchived(note.id, true);
    return said(true, `Archived "${note.title}". It is in the archive if you want it back.`);
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

// one round of it: take what is queued, apply it, hand back the board and what happened
export async function pump(base: string, boardId: string): Promise<OpResult[]> {
  const pulled = await (await fetch(`${base}/ops`)).json() as { ops?: BridgeOp[]; wantState?: boolean };
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
