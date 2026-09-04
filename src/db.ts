import Dexie, { type Table } from "dexie";
import type { Board, Category, Checklist, ChecklistItem, Note, NoteType } from "./types";
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

class TaskboardDatabase extends Dexie {
  boards!: Table<Board, string>;
  categories!: Table<Category, string>;
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

      // old data had no board, so everything that exists lands under one
      const boardId = newId();
      await tx.table<Board, string>("boards").add({
        id: boardId, name: "Taskboard", position: 0, createdAt: new Date().toISOString(),
      });
      await categories.toCollection().modify((category) => { category.boardId = boardId; });
      // v2 era rows still carried a flat items array, v4 below is what folds it into a checklist
      await tx.table("notes").toCollection().modify((note) => { (note as { items?: ChecklistItem[] }).items ??= []; });
    });

    // one time wipe, everything before this was demo data for testing the base functions
    this.version(3).stores({
      boards: "id, position",
      categories: "id, boardId, position",
      notes: "id, categoryId, completed, position, updatedAt",
    }).upgrade(async (tx) => {
      await tx.table("notes").clear();
      await tx.table("categories").clear();
      await tx.table("boards").clear();
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
  }
}

export const database = new TaskboardDatabase();

export const columnColors = ["coral", "teal", "gold", "violet", "sky"];

export function buildBoard(name: string, position: number): Board {
  return { id: newId(), name, position, createdAt: new Date().toISOString() };
}

export function buildColumn(boardId: string, name: string, position: number): Category {
  return {
    id: newId(), boardId, name,
    color: columnColors[position % columnColors.length], position,
    createdAt: new Date().toISOString(),
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
  return { id: newId(), text, completed: false };
}

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

// drops a note into a column at a given index and renumbers what it lands among
export async function moveNote(noteId: string, toCategoryId: string, toIndex: number) {
  await database.transaction("rw", database.notes, async () => {
    const note = await database.notes.get(noteId);
    if (!note) return;

    const ordered = async (categoryId: string) =>
      (await database.notes.where("categoryId").equals(categoryId).toArray())
        .filter((row) => row.id !== noteId)
        .sort((a, b) => a.position - b.position);

    // only the moved note counts as touched, the rest just shuffle up or down
    const renumber = (rows: Note[], categoryId: string) =>
      Promise.all(rows.map((row, index) => row.position === index && row.categoryId === categoryId
        ? undefined
        : database.notes.update(row.id, { position: index, categoryId })));

    if (note.categoryId === toCategoryId) {
      const rows = await ordered(toCategoryId);
      rows.splice(Math.max(0, Math.min(toIndex, rows.length)), 0, note);
      await renumber(rows, toCategoryId);
      return;
    }

    const source = await ordered(note.categoryId);
    const target = await ordered(toCategoryId);
    target.splice(Math.max(0, Math.min(toIndex, target.length)), 0, note);
    await renumber(source, note.categoryId);
    await renumber(target, toCategoryId);
    await database.notes.update(noteId, { updatedAt: new Date().toISOString() });
  });
}

// reorders a column inside its board and renumbers the rest
export async function moveColumn(categoryId: string, toIndex: number) {
  await database.transaction("rw", database.categories, async () => {
    const category = await database.categories.get(categoryId);
    if (!category) return;

    const rows = (await database.categories.where("boardId").equals(category.boardId).toArray())
      .filter((row) => row.id !== categoryId)
      .sort((a, b) => a.position - b.position);

    rows.splice(Math.max(0, Math.min(toIndex, rows.length)), 0, category);
    await Promise.all(rows.map((row, index) =>
      row.position === index ? undefined : database.categories.update(row.id, { position: index })));
  });
}

// archiving just stamps a date, so nothing is lost and the schema does not change.
// dexie treats an undefined value as delete the property, which is what restores it.
const archiveStamp = (archived: boolean) => ({ archivedAt: archived ? new Date().toISOString() : undefined });

export const setBoardArchived = (id: string, archived: boolean) =>
  database.boards.update(id, archiveStamp(archived));

export const setColumnArchived = (id: string, archived: boolean) =>
  database.categories.update(id, archiveStamp(archived));

export const setNoteArchived = (id: string, archived: boolean) =>
  database.notes.update(id, archiveStamp(archived));

// deleting a board takes its columns and their notes with it
export async function deleteBoardForever(boardId: string) {
  await database.transaction("rw", database.boards, database.categories, database.notes, async () => {
    const columns = await database.categories.where("boardId").equals(boardId).toArray();
    for (const column of columns) await database.notes.where("categoryId").equals(column.id).delete();
    await database.categories.where("boardId").equals(boardId).delete();
    await database.boards.delete(boardId);
  });
}

// and a column takes its notes
export async function deleteColumnForever(categoryId: string) {
  await database.transaction("rw", database.categories, database.notes, async () => {
    await database.notes.where("categoryId").equals(categoryId).delete();
    await database.categories.delete(categoryId);
  });
}

export const deleteNoteForever = (noteId: string) => database.notes.delete(noteId);
