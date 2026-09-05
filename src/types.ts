export type NoteType = "checklist" | "direction" | "descriptor" | "idea";

// top level of the tree, holds the columns. updatedAt is what sync compares to work out
// which side is newer, so every level carries one now rather than only the note
export type Board = {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

// a column on a board. width is only set once it has been dragged wider or narrower,
// unset means it sits at whatever the stylesheet calls the default
export type Category = {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
  width?: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

// the sub steps that give a checklist its progress. a step holds steps of its own, so
// anything that needs breaking down further just indents under it instead of a new group
export type ChecklistItem = {
  id: string;
  text: string;
  completed: boolean;
  items: ChecklistItem[];
};

// a named group of steps, a note can carry several of them
export type Checklist = {
  id: string;
  name: string;
  items: ChecklistItem[];
};

// a row inside a column
export type Note = {
  id: string;
  categoryId: string;
  title: string;
  content: string;
  type: NoteType;
  checklists: Checklist[];
  completed: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
};

// what is left behind when a row is deleted for good. a delete is otherwise just an
// absence, and an absence is indistinguishable from a row the other side has not seen
// yet - so without this the next pull hands the deleted row straight back
export type Deletion = {
  id: string;
  kind: "board" | "category" | "note";
  deletedAt: string;
};
