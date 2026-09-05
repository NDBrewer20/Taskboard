// Taking boards out of the browser and putting them back. The database is three flat
// tables, but a board only means anything with its columns and their notes attached, so
// everything in here works on that tree rather than the tables.

import { database, newId } from "./db";
import type { Board, Category, Checklist, ChecklistItem, Note, NoteType } from "./types";

export type TransferFormat = "json" | "csv" | "markdown";

// one board, self contained. this is what gets written out and read back in
export type BoardBundle = { board: Board; columns: { column: Category; notes: Note[] }[] };

// the wrapper a json export carries, so a file can say what it is before we trust it
export type TransferFile = { app: "taskboard"; version: number; exportedAt: string; boards: BoardBundle[] };

// 2 added updatedAt on boards and columns. nothing on the way back in checks this, an
// older file just falls back field by field like it always did - it is here so a file can
// say which shape it was written in
export const FILE_VERSION = 2;

// json is the only one that comes back in, the other two are for reading and for
// spreadsheets. that trade is spelled out on the format cards rather than left to be found
export const transferFormats: { id: TransferFormat; name: string; extension: string; mime: string; blurb: string }[] = [
  { id: "json", name: "JSON", extension: "json", mime: "application/json",
    blurb: "Everything, exactly as it is. The only one that imports back in." },
  { id: "csv", name: "CSV", extension: "csv", mime: "text/csv",
    blurb: "A row per task for a spreadsheet. Steps ride along as text." },
  { id: "markdown", name: "Markdown", extension: "md", mime: "text/markdown",
    blurb: "A readable write up. Good for pasting into notes or a repo." },
];

export const formatMeta = (format: TransferFormat) =>
  transferFormats.find((row) => row.id === format) ?? transferFormats[0];

/* ---------- on the way out ---------- */

// pulls the picked boards together with what hangs off them, in the order the board draws
// them. archived columns and tasks only come along if you asked for them
export function gather(
  boards: Board[], categories: Category[], notes: Note[],
  picked: Set<string>, includeArchived: boolean,
): BoardBundle[] {
  const byPosition = <Row extends { position: number }>(rows: Row[]) => [...rows].sort((a, b) => a.position - b.position);

  return byPosition(boards.filter((board) => picked.has(board.id))).map((board) => ({
    board,
    columns: byPosition(categories.filter((category) =>
      category.boardId === board.id && (includeArchived || !category.archivedAt)))
      .map((column) => ({
        column,
        notes: byPosition(notes.filter((note) =>
          note.categoryId === column.id && (includeArchived || !note.archivedAt))),
      })),
  }));
}

// what the summary line under the format cards counts
export function tally(bundles: BoardBundle[]) {
  const columns = bundles.flatMap((bundle) => bundle.columns);
  return {
    boards: bundles.length,
    columns: columns.length,
    notes: columns.reduce((sum, row) => sum + row.notes.length, 0),
  };
}

// every step in a checklist, flattened, with how deep it sat
const walk = (items: ChecklistItem[], depth = 0): { item: ChecklistItem; depth: number }[] =>
  items.flatMap((item) => [{ item, depth }, ...walk(item.items, depth + 1)]);

const countSteps = (lists: Checklist[]) => {
  const steps = lists.flatMap((list) => walk(list.items));
  return { done: steps.filter((step) => step.item.completed).length, total: steps.length };
};

export function serialize(bundles: BoardBundle[], format: TransferFormat) {
  if (format === "csv") return toCsv(bundles);
  if (format === "markdown") return toMarkdown(bundles);
  const file: TransferFile = { app: "taskboard", version: FILE_VERSION, exportedAt: new Date().toISOString(), boards: bundles };
  return JSON.stringify(file, null, 2);
}

// a cell only needs quoting if it holds a comma, a quote or a newline, and a quote inside
// one gets doubled. anything opening with a formula character gets an apostrophe in front
// of it first, so a task called "=SUM(A1)" lands in a spreadsheet as text, not a formula
function cell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// one row per task. a column with nothing in it still gets a row, otherwise it drops out
// of the file and the shape of the board goes with it
function toCsv(bundles: BoardBundle[]) {
  const header = ["Board", "Column", "Task", "Type", "Completed", "Archived", "Description", "Steps done", "Steps total", "Steps", "Created", "Updated"];
  const rows = [header.join(",")];
  const yesNo = (value: unknown) => (value ? "yes" : "no");
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");

  for (const { board, columns } of bundles) {
    for (const { column, notes } of columns) {
      if (!notes.length) {
        rows.push([board.name, column.name, "", "", "", yesNo(column.archivedAt || board.archivedAt), "", "", "", "", day(column.createdAt), ""]
          .map(cell).join(","));
        continue;
      }

      for (const note of notes) {
        const steps = countSteps(note.checklists);
        rows.push([
          board.name, column.name, note.title, note.type,
          yesNo(note.completed), yesNo(note.archivedAt || column.archivedAt || board.archivedAt),
          note.content, String(steps.done), String(steps.total), stepText(note.checklists),
          day(note.createdAt), day(note.updatedAt),
        ].map(cell).join(","));
      }
    }
  }

  return rows.join("\r\n");
}

// the checklists of one note as plain indented text, so the cell still reads like a list
function stepText(lists: Checklist[]) {
  return lists.map((list) => [
    list.name,
    ...walk(list.items).map(({ item, depth }) => `${"  ".repeat(depth + 1)}[${item.completed ? "x" : " "}] ${item.text}`),
  ].join("\n")).join("\n\n");
}

// a board as a document. headings down to the task, steps as task list items, which is
// what github and most editors render as real tick boxes
function toMarkdown(bundles: BoardBundle[]) {
  const out: string[] = [];
  const stamp = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  for (const { board, columns } of bundles) {
    const all = columns.flatMap((row) => row.notes);
    out.push(`# ${board.name}`);
    out.push(`_${columns.length} columns · ${all.length} tasks · ${all.filter((note) => note.completed).length} done · exported ${stamp}_`);

    for (const { column, notes } of columns) {
      out.push(`## ${column.name}${column.archivedAt ? " (archived)" : ""}`);
      if (!notes.length) out.push("_Nothing here yet._");

      for (const note of notes) {
        const tags = [note.type, note.completed ? "done" : "", note.archivedAt ? "archived" : ""].filter(Boolean);
        out.push(`### ${note.completed ? `~~${note.title}~~` : note.title}`);
        out.push(`_${tags.join(" · ")}_`);
        if (note.content) out.push(note.content);

        for (const list of note.checklists) {
          const steps = walk(list.items);
          out.push(`**${list.name}** (${steps.filter((step) => step.item.completed).length} of ${steps.length})`);
          if (steps.length) out.push(steps
            .map(({ item, depth }) => `${"  ".repeat(depth)}- [${item.completed ? "x" : " "}] ${item.text}`)
            .join("\n"));
        }
      }
    }
  }

  return `${out.join("\n\n")}\n`;
}

// taskboard-project-alpha-2026-09-05.json, or the count once it is more than one board
export function fileName(bundles: BoardBundle[], format: TransferFormat) {
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const base = bundles.length === 1 ? slug(bundles[0].board.name) || "board" : `${bundles.length}-boards`;
  return `taskboard-${base}-${new Date().toISOString().slice(0, 10)}.${formatMeta(format).extension}`;
}

/* ---------- getting it to you ---------- */

// blobs work over plain http, unlike the clipboard, so this is the path that always works
export function saveFile(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// clipboard writes need a secure context, and this gets self hosted over plain http, so
// fall back to the old execCommand trick rather than have the button quietly do nothing
export async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  try {
    const holder = document.createElement("textarea");
    holder.value = text;
    holder.style.cssText = "position:fixed;top:-9999px;opacity:0";
    document.body.appendChild(holder);
    holder.select();
    const done = document.execCommand("copy");
    document.body.removeChild(holder);
    return done;
  } catch { return false; }
}

/* ---------- on the way back in ---------- */

const noteTypes: NoteType[] = ["checklist", "direction", "descriptor", "idea"];
const asText = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const asDate = (value: unknown) => (typeof value === "string" && value ? value : new Date().toISOString());
const asStamp = (value: unknown) => (typeof value === "string" && value ? { archivedAt: value } : {});

// a file written before boards and columns had an updatedAt falls back to when the row was
// made, not to now. now would say every row in an old export was edited the second it was
// read, and on the first sync all of it would beat whatever the server already held
const asEdited = (value: unknown, created: unknown) =>
  (typeof value === "string" && value ? value : asDate(created));
const objects = (source: unknown) => (Array.isArray(source) ? source : [])
  .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");

// a file can be hand edited, or from a build that is not this one, so nothing in it is
// trusted. every row gets rebuilt field by field and anything missing or the wrong shape
// falls back rather than stopping the import
function readItems(source: unknown): ChecklistItem[] {
  return objects(source).map((row) => ({
    id: newId(), text: asText(row.text), completed: row.completed === true, items: readItems(row.items),
  }));
}

function readChecklists(source: unknown): Checklist[] {
  return objects(source).map((row) => ({
    id: newId(), name: asText(row.name, "Checklist"), items: readItems(row.items),
  }));
}

// pulls the boards out of a file. throws with something worth reading, since whatever
// comes back gets shown as the error under the drop zone
export function readTransfer(text: string): BoardBundle[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("That is not JSON. Pick the .json file, not the CSV or the Markdown."); }

  const file = (parsed ?? {}) as Record<string, unknown>;
  if (!Array.isArray(file.boards)) throw new Error("No boards in that file. It has to be a Taskboard JSON export.");

  const bundles = objects(file.boards).map((row) => {
    const board = (row.board ?? {}) as Record<string, unknown>;

    return {
      board: {
        id: newId(), name: asText(board.name, "Imported board"), position: 0,
        createdAt: asDate(board.createdAt), updatedAt: asEdited(board.updatedAt, board.createdAt),
        ...asStamp(board.archivedAt),
      },
      columns: objects(row.columns).map((entry) => {
        const column = (entry.column ?? {}) as Record<string, unknown>;

        return {
          column: {
            id: newId(), boardId: "", name: asText(column.name, "Column"),
            color: asText(column.color, "coral"), position: 0,
            ...(typeof column.width === "number" ? { width: column.width } : {}),
            createdAt: asDate(column.createdAt), updatedAt: asEdited(column.updatedAt, column.createdAt),
            ...asStamp(column.archivedAt),
          },
          notes: objects(entry.notes).map((note) => ({
            id: newId(), categoryId: "", title: asText(note.title, "Untitled"), content: asText(note.content),
            type: (noteTypes.includes(note.type as NoteType) ? note.type : "idea") as NoteType,
            checklists: readChecklists(note.checklists),
            completed: note.completed === true, position: 0,
            createdAt: asDate(note.createdAt), updatedAt: asDate(note.updatedAt),
            ...(typeof note.completedAt === "string" ? { completedAt: note.completedAt } : {}),
            ...asStamp(note.archivedAt),
          })),
        };
      }),
    };
  });

  if (!bundles.length) throw new Error("That file has no boards in it.");
  return bundles;
}

// a name already on the sidebar comes in as "Name (imported)", then (imported) 2 and up,
// so importing back onto the computer it came from does not leave you guessing which is which
function freeName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name;
  const suffixed = `${name} (imported)`;
  if (!taken.has(suffixed)) return suffixed;
  for (let n = 2; ; n += 1) if (!taken.has(`${suffixed} ${n}`)) return `${suffixed} ${n}`;
}

// everything lands as new boards with fresh ids, so an import never overwrites what is
// already here. positions carry on from the end of the sidebar
export async function importBoards(bundles: BoardBundle[]) {
  const boards: Board[] = [];
  const columns: Category[] = [];
  const notes: Note[] = [];

  await database.transaction("rw", database.boards, database.categories, database.notes, async () => {
    const existing = await database.boards.toArray();
    const taken = new Set(existing.map((board) => board.name));
    let position = existing.length;

    for (const bundle of bundles) {
      const name = freeName(bundle.board.name, taken);
      taken.add(name);
      const board = { ...bundle.board, id: newId(), name, position: position++ };
      boards.push(board);

      bundle.columns.forEach((entry, columnIndex) => {
        const column = { ...entry.column, id: newId(), boardId: board.id, position: columnIndex };
        columns.push(column);
        entry.notes.forEach((note, noteIndex) => {
          notes.push({ ...note, id: newId(), categoryId: column.id, position: noteIndex });
        });
      });
    }

    await database.boards.bulkAdd(boards);
    await database.categories.bulkAdd(columns);
    // same reason as the update in db.ts, a checklist that can hold checklists sends
    // dexie's key path walk in circles, so the write goes through a loose view
    await (database.notes as unknown as { bulkAdd(rows: Record<string, unknown>[]): Promise<unknown> })
      .bulkAdd(notes as unknown as Record<string, unknown>[]);
  });

  return { boards: boards.length, columns: columns.length, notes: notes.length, firstBoardId: boards[0]?.id ?? "" };
}
