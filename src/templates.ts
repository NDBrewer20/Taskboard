import type { NoteType } from "./types";

// the shape a board starts out as, picked when you create it
export type TemplateChecklist = { name: string; items: string[] };
export type TemplateNote = { title: string; type: NoteType; content?: string; checklists?: TemplateChecklist[] };
export type TemplateColumn = { name: string; notes: TemplateNote[] };
export type BoardTemplate = {
  id: string;
  name: string;
  board: string;
  description: string;
  columns: TemplateColumn[];
};

export const boardTemplates: BoardTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    board: "New board",
    description: "Nothing to start with. Build the columns yourself.",
    columns: [],
  },
  {
    id: "sprints",
    name: "Sprints",
    board: "Project Alpha",
    description: "A column per sprint, each one holding the work to get through.",
    columns: [
      {
        name: "Sprint 1",
        notes: [
          { title: "Checklist", type: "checklist", content: "The small, finishable steps that keep the sprint moving.", checklists: [
            { name: "Build", items: ["First step", "Second step", "Third step"] },
            { name: "Review", items: ["Check it over", "Ship it"] },
          ] },
          { title: "Idea", type: "idea", content: "Somewhere to drop a thought before it turns into work." },
        ],
      },
      {
        name: "Sprint 2",
        notes: [
          { title: "Checklist", type: "checklist", content: "What carries over.", checklists: [
            { name: "Carry over", items: ["Pull forward anything unfinished"] },
          ] },
        ],
      },
    ],
  },
  {
    id: "kanban",
    name: "Kanban",
    board: "Workflow",
    description: "Backlog, in progress and done. Move rows across as they land.",
    columns: [
      { name: "Backlog", notes: [{ title: "New task", type: "idea", content: "" }] },
      { name: "In progress", notes: [] },
      { name: "Done", notes: [] },
    ],
  },
  {
    id: "weekly",
    name: "Weekly",
    board: "This week",
    description: "One column per working day for the short horizon stuff.",
    columns: [
      { name: "Monday", notes: [] },
      { name: "Tuesday", notes: [] },
      { name: "Wednesday", notes: [] },
      { name: "Thursday", notes: [] },
      { name: "Friday", notes: [] },
    ],
  },
];
