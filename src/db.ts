import Dexie, { type Table } from "dexie";
import type { Board, Category, Checklist, ChecklistItem, Deletion, Note, NoteType } from "./types";
import type { BoardTemplate } from "./templates";

// crypto.randomUUID only exists in a secure context. localhost counts as one, a plain
// http LAN hostname does not, so self hosting would leave it undefined and nothing could
// be created. getRandomValues has no such restriction, so fall back to building the v4
// ourselves rather than depending on how the app happens to be served.
export function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// what v5 briefly stored, a step that carried whole checklists rather than plain sub steps
type SubListItem = ChecklistItem & { checklists?: Checklist[] };

class TaskboardDatabase extends Dexie {
  boards!: Table<Board, string>;
  categories!: Table<Category, string>;
  deletions!: Table<Deletion, string>;
  notes!: Table<Note, string>;

  constructor() {
    super("taskboard");

    this.version(1).stores({
      categories: "id, position",
      notes: "id, categoryId, completed, position, updatedAt",
    });

    // v2 adds the board level above categories and gives every note an items array
    this.version(2).stores({
      boards: "id, position",
      categories: "id, boardId, position",
      notes: "id, categoryId, completed, position, updatedAt",
    }).upgrade(async (tx) => {
      const categories = tx.table<Category, string>("categories");
      if (!(await categories.count())) return;

      // old data had no board, so everything that exists lands under one. v7 backfills the
      // updatedAt on it either way, this just saves it a pass
      const boardId = newId();
      const madeAt = new Date().toISOString();
      await tx.table<Board, string>("boards").add({
        id: boardId, name: "Taskboard", position: 0, createdAt: madeAt, updatedAt: madeAt,
      });
      await categories.toCollection().modify((category) => { category.boardId = boardId; });
      // v2 era rows still carried a flat items array, v4 below is what folds it into a checklist
      await tx.table("notes").toCollection().modify((note) => { (note as { items?: ChecklistItem[] }).items ??= []; });
    });

    // v3 used to wipe every table here - everything before it was demo data for testing the
    // base functions. That has long since run, and what it does now is sit waiting for a
    // database still on v1 or v2 to open the app and lose everything in it. A board served
    // over a different origin is exactly that, since IndexedDB is per origin and one that
    // has not been opened in a while never moved past v2. The upgrade is gone, the version
    // stays so the chain from v2 up still lines up.
    this.version(3).stores({
      boards: "id, position",
      categories: "id, boardId, position",
      notes: "id, categoryId, completed, position, updatedAt",
    });

    // v4 turns the flat items array into named checklists, a note can hold several
    this.version(4).stores({
      boards: "id, position",
      categories: "id, boardId, position",
      notes: "id, categoryId, completed, position, updatedAt",
    }).upgrade(async (tx) => {
      await tx.table("notes").toCollection().modify((note) => {
        const legacy = (note as { items?: ChecklistItem[] }).items;
        note.checklists = legacy?.length ? [{ id: newId(), name: "Checklist", items: legacy }] : [];
        delete (note as { items?: ChecklistItem[] }).items;
      });
    });

    // v5 gave every step its own checklists array, sub steps were a group of their own then
    this.version(5).stores({
      boards: "id, position",
      categories: "id, boardId, position",
      notes: "id, categoryId, completed, position, updatedAt",
    }).upgrade(async (tx) => {
      await tx.table("notes").toCollection().modify((note) => {
        for (const list of (note.checklists ?? []) as Checklist[]) {
          for (const item of list.items) (item as SubListItem).checklists ??= [];
        }
      });
    });

    // v6 drops that. a step owns its sub steps directly now, so whatever sat in the groups
    // hanging off a step gets pulled up into the step itself, in the order it was in
    this.version(6).stores({
      boards: "id, position",
      categories: "id, boardId, position",
      notes: "id, categoryId, completed, position, updatedAt",
    }).upgrade(async (tx) => {
      const foldIn = (items: ChecklistItem[]) => {
        for (const item of items) {
          const legacy = (item as SubListItem).checklists;
          delete (item as SubListItem).checklists;
          item.items = legacy?.flatMap((list) => list.items) ?? item.items ?? [];
          foldIn(item.items);
        }
      };
      await tx.table("notes").toCollection().modify((note) => {
        for (const list of (note.checklists ?? []) as Checklist[]) foldIn(list.items);
      });
    });

    // v7 is the server storage groundwork. boards and columns get their own updatedAt,
    // which is what decides whose copy is newer, and deletions holds a row id after the
    // row itself is gone so the delete can travel instead of the row coming back.
    this.version(7).stores({
      boards: "id, position, updatedAt",
      categories: "id, boardId, position, updatedAt",
      notes: "id, categoryId, completed, position, updatedAt",
      deletions: "id, kind, deletedAt",
    }).upgrade(async (tx) => {
      // nothing carried one before, so when the row was made is the honest answer. now()
      // would say every board on the machine was edited the moment you upgraded, and the
      // first sync would hand all of it to the server as the newer side
      await tx.table("boards").toCollection().modify((row) => { row.updatedAt ??= row.createdAt; });
      await tx.table("categories").toCollection().modify((row) => { row.updatedAt ??= row.createdAt; });
    });
  }
}

export const database = new TaskboardDatabase();

// dexie types an update by walking every key path on the row, and a checklist that can
// hold checklists sends that walk in circles. writes go through a loose view of the table
// so the walk stops, everything reading a note still gets the real shape back
const noteWrites = database.notes as unknown as Table<Record<string, unknown>, string>;

export const updateNote = (id: string, changes: Partial<Note>) => noteWrites.update(id, changes);

// boards and columns go through these rather than the table, so a write cannot land
// without moving updatedAt with it. sync reads that stamp and only that stamp, so a row
// changed behind its back looks unchanged and the edit never leaves the browser
export const updateBoard = (id: string, changes: Partial<Board>) =>
  database.boards.update(id, { ...changes, updatedAt: new Date().toISOString() });

export const updateColumn = (id: string, changes: Partial<Category>) =>
  database.categories.update(id, { ...changes, updatedAt: new Date().toISOString() });

// a row deleted for good leaves one of these behind. the row is gone either way - this is
// what tells the other side it went, rather than letting it look like a row never seen
const remember = (rows: { id: string; kind: Deletion["kind"] }[]) => {
  const deletedAt = new Date().toISOString();
  return database.deletions.bulkPut(rows.map((row) => ({ ...row, deletedAt })));
};

export const columnColors = ["coral", "teal", "gold", "violet", "sky"];

// a column is 302px until you drag its edge, and it cannot go under what a checklist row
// actually needs. that floor is the column padding and border (26) + the note's (26) +
// the indent the checklist sits at (52) + the group's own border and padding (22) + the
// row itself, which is about 100px of fold, handle, box and buttons before any text (170).
// go under it and the row runs past the edge of the column and gets cut off
export const defaultColumnWidth = 302;
export const columnWidthRange = { min: 296, max: 900 };

export const clampColumnWidth = (width: number) =>
  Math.round(Math.max(columnWidthRange.min, Math.min(columnWidthRange.max, width)));

export function buildBoard(name: string, position: number): Board {
  const now = new Date().toISOString();
  return { id: newId(), name, position, createdAt: now, updatedAt: now };
}

export function buildColumn(boardId: string, name: string, position: number): Category {
  const now = new Date().toISOString();
  return {
    id: newId(), boardId, name,
    color: columnColors[position % columnColors.length], position,
    createdAt: now, updatedAt: now,
  };
}

// notes default to idea, a checklist note starts with one empty group
export function buildNote(categoryId: string, position: number, type: NoteType = "idea"): Note {
  const now = new Date().toISOString();
  return {
    id: newId(), categoryId, title: type === "checklist" ? "New checklist" : "New task",
    content: "", type, checklists: type === "checklist" ? [buildChecklist("Checklist")] : [],
    completed: false, position, createdAt: now, updatedAt: now,
  };
}

export function buildChecklist(name: string, items: string[] = []): Checklist {
  return { id: newId(), name, items: items.map(buildItem) };
}

export function buildItem(text: string): ChecklistItem {
  return { id: newId(), text, completed: false, items: [] };
}

/* a step holds sub steps, so nothing below can assume one level. all of it rebuilds the
   branch it touches rather than mutating, which is what gets written back to dexie. */

// runs every step under these ones through a change, however deep they go
export function mapItems(items: ChecklistItem[], change: (item: ChecklistItem) => ChecklistItem): ChecklistItem[] {
  return items.map((item) => change({ ...item, items: mapItems(item.items, change) }));
}

// every step in a note, nested ones included. the counts run off this
export function allItems(items: ChecklistItem[]): ChecklistItem[] {
  return items.flatMap((item) => [item, ...allItems(item.items)]);
}

export const noteItems = (lists: Checklist[]) => lists.flatMap((list) => allItems(list.items));

export const findItem = (lists: Checklist[], itemId: string) =>
  noteItems(lists).find((item) => item.id === itemId);

// pulling a step out takes its sub steps with it
export function dropItem(items: ChecklistItem[], itemId: string): ChecklistItem[] {
  return items
    .filter((item) => item.id !== itemId)
    .map((item) => ({ ...item, items: dropItem(item.items, itemId) }));
}

export const insertAt = <Row,>(rows: Row[], index: number, row: Row) =>
  [...rows.slice(0, index), row, ...rows.slice(index)];

// owner is a checklist or a step, whichever the pointer was over when it landed
export function placeItem(items: ChecklistItem[], ownerId: string, moving: ChecklistItem, index: number): ChecklistItem[] {
  return items.map((item) => item.id === ownerId
    ? { ...item, items: insertAt(item.items, index, moving) }
    : { ...item, items: placeItem(item.items, ownerId, moving, index) });
}

// a step that has sub steps is only done when they all are, worked out from the bottom up
export function rollUp(items: ChecklistItem[]): ChecklistItem[] {
  return items.map((item) => {
    const nested = rollUp(item.items);
    return { ...item, items: nested, completed: nested.length ? nested.every((step) => step.completed) : item.completed };
  });
}

export const rollUpNote = (lists: Checklist[]) => lists.map((list) => ({ ...list, items: rollUp(list.items) }));

// the other direction: ticking the note itself settles every step under it, however deep.
// a done task with half its steps unticked reads as unfinished to anything parsing the
// board, so the flag and the steps have to agree
export function sweepNote(lists: Checklist[], completed: boolean): Checklist[] {
  const sweep = (items: ChecklistItem[]): ChecklistItem[] =>
    items.map((item) => ({ ...item, completed, items: sweep(item.items) }));
  return lists.map((list) => ({ ...list, items: sweep(list.items) }));
}

// same two, lifted to the note so a step can move between its checklists as well
export const dropNoteItem = (lists: Checklist[], itemId: string) =>
  lists.map((list) => ({ ...list, items: dropItem(list.items, itemId) }));

export const placeNoteItem = (lists: Checklist[], ownerId: string, moving: ChecklistItem, index: number) =>
  lists.map((list) => list.id === ownerId
    ? { ...list, items: insertAt(list.items, index, moving) }
    : { ...list, items: placeItem(list.items, ownerId, moving, index) });

// builds the whole board -> column -> note tree from a template in one shot
export async function createBoardFromTemplate(template: BoardTemplate, name: string, position: number) {
  const board = buildBoard(name, position);

  await database.transaction("rw", database.boards, database.categories, database.notes, async () => {
    await database.boards.add(board);

    for (const [columnIndex, column] of template.columns.entries()) {
      const category = buildColumn(board.id, column.name, columnIndex);
      await database.categories.add(category);
      if (!column.notes.length) continue;

      await database.notes.bulkAdd(column.notes.map((note, noteIndex) => ({
        ...buildNote(category.id, noteIndex, note.type),
        title: note.title,
        content: note.content ?? "",
        checklists: (note.checklists ?? []).map((list) => buildChecklist(list.name, list.items)),
      })));
    }
  });

  return board;
}

/* Where something lands is given as the row it should go in front of, and null for the
   end of the list. Not a number: the board draws only what is live, and a search or active
   only can be hiding more on top of that, so a slot counted off the screen does not line up
   with the rows in the table. Renumbering still runs over all of them, archived included,
   so an archived row keeps its place in the order for when it comes back. */

const slotFor = (rows: { id: string }[], beforeId: string | null) => {
  const at = beforeId ? rows.findIndex((row) => row.id === beforeId) : -1;
  return at === -1 ? rows.length : at;
};

// drops a note into a column in front of a given row and renumbers what it lands among
export async function moveNote(noteId: string, toCategoryId: string, beforeId: string | null) {
  await database.transaction("rw", database.notes, async () => {
    const note = await database.notes.get(noteId);
    if (!note) return;

    const ordered = async (categoryId: string) =>
      (await database.notes.where("categoryId").equals(categoryId).toArray())
        .filter((row) => row.id !== noteId)
        .sort((a, b) => a.position - b.position);

    // a row that did not actually shift is left alone. one that did carries a new stamp:
    // position is synced state like anything else, and the server only takes a row that
    // says it is newer, so without this a reorder never leaves the browser it was done in
    const renumber = (rows: Note[], categoryId: string) => {
      const now = new Date().toISOString();
      return Promise.all(rows.map((row, index) => row.position === index && row.categoryId === categoryId
        ? undefined
        : updateNote(row.id, { position: index, categoryId, updatedAt: now })));
    };

    if (note.categoryId === toCategoryId) {
      const rows = await ordered(toCategoryId);
      rows.splice(slotFor(rows, beforeId), 0, note);
      await renumber(rows, toCategoryId);
      return;
    }

    const source = await ordered(note.categoryId);
    const target = await ordered(toCategoryId);
    target.splice(slotFor(target, beforeId), 0, note);
    await renumber(source, note.categoryId);
    await renumber(target, toCategoryId);
  });
}

// reorders a board in the sidebar and renumbers the rest
export async function moveBoard(boardId: string, beforeId: string | null) {
  await database.transaction("rw", database.boards, async () => {
    const board = await database.boards.get(boardId);
    if (!board) return;

    const rows = (await database.boards.toArray())
      .filter((row) => row.id !== boardId)
      .sort((a, b) => a.position - b.position);

    rows.splice(slotFor(rows, beforeId), 0, board);
    await Promise.all(rows.map((row, index) =>
      row.position === index ? undefined : updateBoard(row.id, { position: index })));
  });
}

// reorders a column inside its board and renumbers the rest
export async function moveColumn(categoryId: string, beforeId: string | null) {
  await database.transaction("rw", database.categories, async () => {
    const category = await database.categories.get(categoryId);
    if (!category) return;

    const rows = (await database.categories.where("boardId").equals(category.boardId).toArray())
      .filter((row) => row.id !== categoryId)
      .sort((a, b) => a.position - b.position);

    rows.splice(slotFor(rows, beforeId), 0, category);
    await Promise.all(rows.map((row, index) =>
      row.position === index ? undefined : updateColumn(row.id, { position: index })));
  });
}

// archiving just stamps a date, so nothing is lost and the schema does not change.
// dexie treats an undefined value as delete the property, which is what restores it.
const archiveStamp = (archived: boolean) => ({
  archivedAt: archived ? new Date().toISOString() : undefined,
  updatedAt: new Date().toISOString(),
});

export const setBoardArchived = (id: string, archived: boolean) =>
  database.boards.update(id, archiveStamp(archived));

export const setColumnArchived = (id: string, archived: boolean) =>
  database.categories.update(id, archiveStamp(archived));

export const setNoteArchived = (id: string, archived: boolean) =>
  updateNote(id, archiveStamp(archived));

// deleting a board takes its columns and their notes with it. every id that goes is
// written down first, in the same transaction, so a delete that lands here cannot come
// back on the next pull as a row the server still has
export async function deleteBoardForever(boardId: string) {
  await database.transaction("rw", database.boards, database.categories, database.notes, database.deletions, async () => {
    const columns = await database.categories.where("boardId").equals(boardId).toArray();
    const notes = await database.notes.where("categoryId").anyOf(columns.map((column) => column.id)).toArray();

    await remember([
      { id: boardId, kind: "board" },
      ...columns.map((column) => ({ id: column.id, kind: "category" as const })),
      ...notes.map((note) => ({ id: note.id, kind: "note" as const })),
    ]);

    await database.notes.where("categoryId").anyOf(columns.map((column) => column.id)).delete();
    await database.categories.where("boardId").equals(boardId).delete();
    await database.boards.delete(boardId);
  });
}

// and a column takes its notes
export async function deleteColumnForever(categoryId: string) {
  await database.transaction("rw", database.categories, database.notes, database.deletions, async () => {
    const notes = await database.notes.where("categoryId").equals(categoryId).toArray();

    await remember([
      { id: categoryId, kind: "category" },
      ...notes.map((note) => ({ id: note.id, kind: "note" as const })),
    ]);

    await database.notes.where("categoryId").equals(categoryId).delete();
    await database.categories.delete(categoryId);
  });
}

export async function deleteNoteForever(noteId: string) {
  await database.transaction("rw", database.notes, database.deletions, async () => {
    await remember([{ id: noteId, kind: "note" }]);
    await database.notes.delete(noteId);
  });
}
