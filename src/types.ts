export type NoteType = "checklist" | "direction" | "descriptor" | "idea";

// top level of the tree, holds the columns
export type Board = {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  archivedAt?: string;
};

// a column on a board
export type Category = {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
  createdAt: string;
  archivedAt?: string;
};

// the sub steps that give a checklist its progress
export type ChecklistItem = {
  id: string;
  text: string;
  completed: boolean;
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
