import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowDownUp, ArrowLeft, Check, CloudUpload, ChevronDown, ChevronRight, Circle, Columns3, Filter, GripVertical, Layers3, ListChecks, ListTree, Pencil, PlugZap, Plus, Search, Settings2, Sparkles, Square, SquareCheckBig, TextAlignStart, Trash2, X } from "lucide-react";
import Connect from "./Connect";
import { useStayAwake } from "./awake";
import ImportExport from "./ImportExport";
import Sync from "./Sync";
import { findBridge, pump } from "./bridge";
import type { BridgeHealth, OpResult } from "./bridge";
import { allItems, buildChecklist, buildColumn, buildItem, buildNote, clampColumnWidth, createBoardFromTemplate,
  database, defaultColumnWidth, deleteBoardForever, deleteColumnForever, deleteNoteForever, dropNoteItem, findItem,
  mapItems, moveColumn, moveNote, noteItems, placeNoteItem, rollUpNote, setBoardArchived, setColumnArchived,
  setNoteArchived, sweepNote, updateColumn, updateNote } from "./db";
import { boardTemplates } from "./templates";
import type { SyncStatus } from "./server";
import { describeSync, holdSync, readKey, startSync, subscribe } from "./server";
import type { Board, Category, Checklist, ChecklistItem, Note, NoteType } from "./types";

const typeLabels: Record<NoteType, string> = { checklist: "Checklist", direction: "Direction", descriptor: "Descriptor", idea: "Idea" };

// everything a search should reach inside a note, sub steps as well as the top ones
const listText = (lists: Checklist[]) => lists
  .map((list) => `${list.name} ${allItems(list.items).map((item) => item.text).join(" ")}`)
  .join(" ");

// what is currently swapped out for a text box
type Editing = { kind: "column" | "note" | "body" | "list" | "item" | "newColumn" | "newStep" | "newList"; id: string };

// the board, the archive and the walkthrough are three pages that take turns in the pane.
// one value rather than a flag each, so two of them can never end up drawn on top of
// each other the way they did when leaving one did not turn the other off
type View = "board" | "archive" | "connect" | "sync";

// notes move between columns, steps and whole checklists within a note, columns across the board
type DragKind = "note" | "item" | "column" | "list";

// one text box that commits on enter or blur and backs out on escape
function InlineInput({ value = "", placeholder, multiline = false, onCommit, onCancel }: {
  value?: string; placeholder?: string; multiline?: boolean; onCommit: (text: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const settled = useRef(false);

  // enter, escape and blur all race each other, so only the first one counts
  function finish(commit: boolean) {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(text); else onCancel();
  }

  // in a description enter makes a new line, so ctrl+enter is what saves
  if (multiline) return <textarea className="inline-input" autoFocus value={text} placeholder={placeholder} rows={3}
    onChange={(event) => setText(event.target.value)}
    onBlur={() => finish(true)}
    onKeyDown={(event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    }} />;

  return <input className="inline-input" autoFocus value={text} placeholder={placeholder}
    onChange={(event) => setText(event.target.value)}
    onBlur={() => finish(true)}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    }} />;
}

// how the board looks and behaves. per device like the folds, so localStorage not dexie
type Settings = {
  collapsedDescription: boolean;
  collapsedSteps: boolean;
  rollUpSteps: boolean;
  compactRows: boolean;
  agentAccess: boolean;
  tabAwake: boolean;
  screenAwake: boolean;
};

const defaultSettings: Settings = {
  collapsedDescription: true,
  collapsedSteps: true,
  rollUpSteps: true,
  compactRows: false,
  // off until you walk through Connect Agents, nothing reaches out on its own
  agentAccess: false,
  // and both off until you ask. one puts a speaker icon on the tab, the other stops the
  // screen locking itself, and neither is a thing to switch on for somebody
  tabAwake: false,
  screenAwake: false,
};

const SETTINGS_KEY = "taskboard:settings";

// anything missing falls back to its default, so adding a setting needs no migration.
// renaming one does though - agentAccess used to be claudeAccess, and reading the old name
// carries the switch over rather than quietly turning it off
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const saved = (raw ? JSON.parse(raw) : {}) as Partial<Settings> & { claudeAccess?: boolean };
    if (saved.agentAccess === undefined && saved.claudeAccess !== undefined) saved.agentAccess = saved.claudeAccess;
    delete saved.claudeAccess;
    return { ...defaultSettings, ...saved };
  } catch { return { ...defaultSettings }; }
}

// what a folded task shows of its description. cut back to a word so it does not stop
// halfway through one, and the newlines go flat so it stays on its two lines
function shorten(text: string, limit = 130) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,.;:!?-]+$/, "")}\u2026`;
}

// which things are folded up. view state, so it lives in the browser not the database
const COLLAPSE_KEY = "taskboard:collapsed";

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set<string>(raw ? JSON.parse(raw) as string[] : []);
  } catch { return new Set<string>(); }
}

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeBoardId, setActiveBoardId] = useState("");
  const [query, setQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftTemplate, setDraftTemplate] = useState(boardTemplates[0].id);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [view, setView] = useState<View>("board");
  // only whether there is one, never the key itself. Sync is where it is read and shown
  const [syncKey, setSyncKey] = useState(readKey());
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const [bridge, setBridge] = useState<BridgeHealth | null>(null);
  const [bridgeLog, setBridgeLog] = useState<OpResult[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ kind: DragKind; id: string; noteId: string; title: string; x: number; y: number; width: number; height: number; container: string; index: number } | null>(null);
  const [sizing, setSizing] = useState<{ id: string; width: number } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ kind: DragKind; id: string; noteId: string; title: string; width: number; height: number; startX: number; startY: number; active: boolean } | null>(null);
  const target = useRef<{ container: string; index: number } | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  async function refresh() {
    const [nextBoards, nextCategories, nextNotes] = await Promise.all([
      database.boards.orderBy("position").toArray(),
      database.categories.orderBy("position").toArray(),
      database.notes.orderBy("position").toArray(),
    ]);
    setBoards(nextBoards); setCategories(nextCategories); setNotes(nextNotes);
    const live = nextBoards.filter((board) => !board.archivedAt);
    setActiveBoardId((current) => (live.some((board) => board.id === current) ? current : live[0]?.id ?? ""));
  }

  useEffect(() => { database.open().then(refresh); }, []);

  // boards keep themselves level with the server from here on: an edit settles then goes
  // up, and what the other devices did comes down on a timer and whenever the tab is
  // looked at again. the button in Sync is the same call, just asked for by hand
  useEffect(() => subscribe(setSync), []);
  useEffect(() => startSync(() => { void refreshRef.current(); }), []);

  // a drag renumbers a whole column, so nothing is applied underneath one in flight
  useEffect(() => { holdSync(Boolean(drag)); }, [drag]);

  // which board changes land on, read at tick time rather than captured when the loop started
  const openBoardRef = useRef("");
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // with agent access on, the board asks the bridge for work and applies whatever is
  // waiting. nothing leaves the browser except the board it sends back.
  //
  // one round at a time rather than an interval, because how long to leave before the next
  // one depends on what the last one did. while you are looking at the tab it is the couple
  // of seconds it always was. while you are not, the connector holds the poll open instead,
  // since a background tab has its timers cut to roughly one a minute and an agent waiting
  // on a board buried in a pile of tabs would time out long before the next one fired
  useEffect(() => {
    if (!settings.agentAccess) { setBridge(null); return; }

    let stopped = false;
    let busy = false;
    let timer = 0;
    let held: AbortController | null = null;

    async function round() {
      if (stopped || busy) return;
      busy = true;
      let soon = 2000;

      try {
        const found = await findBridge();
        if (stopped) return;
        setBridge(found?.info ?? null);
        if (!found) return;

        // only hold the line when the tab is hidden. that is when the throttling happens,
        // and when nobody is watching the walkthrough's chips go stale for half a minute.
        // an older connector does not know how to hold one, so it says so in its health
        const wait = found.info.waits && document.visibilityState !== "visible" ? 25_000 : 0;
        held = new AbortController();
        const done = await pump(found.base, openBoardRef.current, wait, held.signal);
        if (stopped) return;

        // a held poll has done the waiting already, so the next one goes straight back out
        soon = wait ? 0 : 2000;
        if (!done.length) return;
        setBridgeLog((current) => [...done].reverse().concat(current).slice(0, 20));
        refreshRef.current();
      } catch {
        // coming back to the tab cuts a held poll short on purpose, which is not a fault
        if (held?.signal.aborted) soon = 0; else setBridge(null);
      } finally {
        held = null;
        busy = false;
        if (!stopped) timer = window.setTimeout(round, soon);
      }
    }

    // the tab you have just clicked back to should be up to date now, not in another
    // half minute of held poll or, worse, whenever a throttled timer next gets a turn
    function catchUp() {
      if (stopped || document.visibilityState !== "visible") return;
      held?.abort();
      window.clearTimeout(timer);
      round();
    }

    round();
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    return () => {
      stopped = true;
      held?.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
    };
  }, [settings.agentAccess]);

  // both only mean anything while there is something running to keep awake for, so they
  // follow agent access rather than standing on their own
  const awake = useStayAwake(settings.agentAccess && settings.tabAwake, settings.agentAccess && settings.screenAwake);

  // the topbar shows a ctrl+k hint, so make the key actually jump to search
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setIsCreating(false); setShowSettings(false); setShowTransfer(false); setConfirming(""); return; }
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      searchInput.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // archived things drop out of the board until they are restored
  const liveBoards = boards.filter((board) => !board.archivedAt);
  const activeBoard = liveBoards.find((board) => board.id === activeBoardId) ?? liveBoards[0];

  openBoardRef.current = activeBoard?.id ?? "";

  const archivedBoards = boards.filter((board) => board.archivedAt);
  const archivedColumns = categories.filter((category) => category.archivedAt);
  const archivedNotes = notes.filter((note) => note.archivedAt);
  const archivedCount = archivedBoards.length + archivedColumns.length + archivedNotes.length;

  // the columns of the open board, already in position order
  const columns = useMemo(
    () => categories.filter((category) => category.boardId === activeBoard?.id && !category.archivedAt),
    [categories, activeBoard?.id]);

  // search reaches the checklist names and their steps as well as the note itself
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes.filter((note) => {
      if (note.archivedAt) return false;
      if (!showCompleted && note.completed) return false;
      if (!needle) return true;
      return `${note.title} ${note.content} ${listText(note.checklists)}`.toLowerCase().includes(needle);
    });
  }, [notes, query, showCompleted]);

  // with active only on, a column whose every task is done drops out of the board
  const shownColumns = useMemo(() => columns.filter((category) => {
    if (showCompleted) return true;
    const own = notes.filter((note) => note.categoryId === category.id);
    return !own.length || own.some((note) => !note.completed);
  }), [columns, notes, showCompleted]);

  // the column being dragged leaves the row, so the slot index lines up with what is drawn
  const laidOutColumns = shownColumns.filter((category) => !(drag?.kind === "column" && category.id === drag.id));

  const rowsFor = (categoryId: string) => matches.filter((note) => note.categoryId === categoryId);
  const boardNotes = notes.filter((note) => columns.some((column) => column.id === note.categoryId));

  const isCollapsed = (id: string) => collapsed.has(id);

  // boards, columns, notes and checklists all fold up, and it sticks across reloads
  function toggleCollapse(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* private mode, fine */ }
      return next;
    });
  }

  function saveSettings(next: Settings) {
    setSettings(next);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode, fine */ }
  }

  const toggleSetting = (key: keyof Settings) => saveSettings({ ...settings, [key]: !settings[key] });

  // unfolds everything on every board, the way out of a board you have folded to nothing
  function expandEverything() {
    setCollapsed(new Set());
    try { localStorage.setItem(COLLAPSE_KEY, "[]"); } catch { /* private mode, fine */ }
  }

  // drops the width off every column, so they all go back to the default
  async function resetColumnWidths() {
    await database.categories.toCollection().modify((row) => { delete row.width; });
    refresh();
  }

  // adding a sub list to a folded step would drop it out of sight, so open it back up
  function expand(id: string) {
    setCollapsed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* private mode, fine */ }
      return next;
    });
  }

  const isEditing = (kind: Editing["kind"], id: string) => editing?.kind === kind && editing.id === id;
  const startEdit = (kind: Editing["kind"], id: string) => { setConfirming(""); setEditing({ kind, id }); };
  const cancelEdit = () => setEditing(null);

  function measure(event: React.PointerEvent, selector: string) {
    const box = (event.currentTarget as HTMLElement).closest<HTMLElement>(selector)?.getBoundingClientRect();
    return { width: box?.width ?? 0, height: box?.height ?? 0 };
  }

  // a press only becomes a drag after it actually moves, so clicks still land
  function beginNoteDrag(event: React.PointerEvent, note: Note, fromHandle: boolean) {
    if (event.button !== 0) return;
    // touch scrolling stays intact, on touch you drag with the handle
    if (!fromHandle && (event.pointerType === "touch" || (event.target as HTMLElement).closest("button, input, textarea"))) return;
    pending.current = { kind: "note", id: note.id, noteId: note.id, title: note.title, ...measure(event, "[data-note-id]"), startX: event.clientX, startY: event.clientY, active: false };
  }

  function beginItemDrag(event: React.PointerEvent, note: Note, itemId: string, text: string) {
    if (event.button !== 0) return;
    // measure the row, not the wrapper, so the slot stays step sized even when the step
    // is dragging a stack of sub steps along with it
    pending.current = { kind: "item", id: itemId, noteId: note.id, title: text, ...measure(event, ".check-item"), startX: event.clientX, startY: event.clientY, active: false };
  }

  function beginListDrag(event: React.PointerEvent, note: Note, list: Checklist) {
    if (event.button !== 0) return;
    pending.current = { kind: "list", id: list.id, noteId: note.id, title: list.name, ...measure(event, "[data-checklist-id]"), startX: event.clientX, startY: event.clientY, active: false };
  }

  // the width a column is drawn at, mid drag that is the live one rather than the stored one.
  // clamped on the way out too, so a width saved under an older floor gets pulled back up
  const widthOf = (category: Category) =>
    clampColumnWidth((sizing?.id === category.id ? sizing.width : category.width) ?? defaultColumnWidth);

  // dragging the edge sizes the column live and only writes when you let go, so the board
  // is not saving on every pixel
  function beginResize(event: React.PointerEvent, category: Category) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = widthOf(category);
    const widthAt = (clientX: number) => clampColumnWidth(startWidth + clientX - startX);

    const onMove = (moved: PointerEvent) => setSizing({ id: category.id, width: widthAt(moved.clientX) });
    const onUp = async (ended: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const width = widthAt(ended.clientX);
      setSizing(null);
      if (width === (category.width ?? defaultColumnWidth)) return;
      await updateColumn(category.id, { width });
      refresh();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // double click the edge and the column goes back to the default width
  async function resetWidth(category: Category) {
    if (category.width === undefined) return;
    await updateColumn(category.id, { width: undefined });
    refresh();
  }

  function beginColumnDrag(event: React.PointerEvent, category: Category) {
    if (event.button !== 0) return;
    pending.current = { kind: "column", id: category.id, noteId: "", title: category.name, ...measure(event, "[data-column-id]"), startX: event.clientX, startY: event.clientY, active: false };
  }

  function insertionPoint(rows: HTMLElement[], position: number, axis: "x" | "y") {
    const index = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return axis === "y" ? position < box.top + box.height / 2 : position < box.left + box.width / 2;
    });
    return index === -1 ? rows.length : index;
  }

  // works out what the pointer is over and where the dragged thing would slot in
  function findTarget(held: { kind: DragKind; id: string; noteId: string }, x: number, y: number) {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;

    if (held.kind === "column") {
      const board = element.closest<HTMLElement>("[data-board-id]");
      if (!board) return null;
      const rows = [...board.querySelectorAll<HTMLElement>("[data-column-id]")].filter((row) => row.dataset.columnId !== held.id);
      return { container: board.dataset.boardId!, index: insertionPoint(rows, x, "x") };
    }

    if (held.kind === "note") {
      const column = element.closest<HTMLElement>("[data-column-id]");
      if (!column || column.classList.contains("collapsed")) return null;
      const rows = [...column.querySelectorAll<HTMLElement>("[data-note-id]")].filter((row) => row.dataset.noteId !== held.id);
      return { container: column.dataset.columnId!, index: insertionPoint(rows, y, "y") };
    }

    if (held.kind === "list") {
      const owner = element.closest<HTMLElement>("[data-note-id]");
      if (!owner || owner.dataset.noteId !== held.noteId) return null;
      const rows = [...owner.querySelectorAll<HTMLElement>("[data-checklist-id]")].filter((row) => row.dataset.checklistId !== held.id);
      return { container: owner.dataset.noteId!, index: insertionPoint(rows, y, "y") };
    }

    // a step drops into whatever holds steps, a checklist or another step, anywhere on its
    // own note but never onto a different one. the row under the pointer decides which
    // container is in play, so passing over a step reorders its siblings instead of diving in
    // over a row it is that row's own container, anywhere else it is whatever the pointer
    // is sitting in, which is how the indent under a step counts as dropping into it
    const row = element.closest<HTMLElement>(".check-item")?.parentElement;
    const owner = (row ?? element).closest<HTMLElement>("[data-step-owner]");
    if (!owner || owner.classList.contains("collapsed")) return null;
    if (owner.closest<HTMLElement>("[data-note-id]")?.dataset.noteId !== held.noteId) return null;
    const rows = [...owner.querySelectorAll<HTMLElement>("[data-item-id]")]
      .filter((step) => step.dataset.itemId !== held.id && step.parentElement?.closest("[data-step-owner]") === owner);
    return { container: owner.dataset.stepOwner!, index: insertionPoint(rows, y, "y") };
  }

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const held = pending.current;
      if (!held) return;
      pointer.current = { x: event.clientX, y: event.clientY };

      if (!held.active) {
        if (Math.hypot(event.clientX - held.startX, event.clientY - held.startY) < 5) return;
        held.active = true;
        setEditing(null); setConfirming("");
      }

      event.preventDefault();
      const spot = findTarget(held, event.clientX, event.clientY);
      // a note or column keeps its last slot, so releasing in the gap between columns still lands.
      // steps and checklists are locked to their own note, so leaving it cancels instead of
      // quietly applying wherever the slot happened to be last
      if (spot) target.current = spot;
      else if (held.kind === "item" || held.kind === "list") target.current = null;
      const shown = target.current;
      setDrag({
        kind: held.kind, id: held.id, noteId: held.noteId, title: held.title,
        x: event.clientX, y: event.clientY, width: held.width, height: held.height,
        container: shown?.container ?? "", index: shown?.index ?? 0,
      });
    }

    async function onUp() {
      const held = pending.current;
      const spot = target.current;
      pending.current = null; target.current = null;
      setDrag(null);
      if (!held?.active || !spot) return;

      if (held.kind === "column") {
        await moveColumn(held.id, spot.index);
        refresh();
        return;
      }

      if (held.kind === "note") {
        await moveNote(held.id, spot.container, spot.index);
        refresh();
        return;
      }

      if (held.kind === "list") {
        const owner = await database.notes.get(held.noteId);
        const moving = owner?.checklists.find((list) => list.id === held.id);
        if (!owner || !moving) return;
        const rest = owner.checklists.filter((list) => list.id !== held.id);
        const checklists = [...rest.slice(0, spot.index), moving, ...rest.slice(spot.index)];
        await updateNote(owner.id, { checklists, updatedAt: new Date().toISOString() });
        refresh();
        return;
      }

      // read the note back rather than trusting a value captured when the listener was set up
      const note = await database.notes.get(held.noteId);
      const item = note && findItem(note.checklists, held.id);
      if (!note || !item) return;

      // pull the step out of wherever it sat, then put it back under what it was dropped
      // on. its own sub steps ride along on the object being moved
      const checklists = placeNoteItem(dropNoteItem(note.checklists, held.id), spot.container, item, spot.index);
      await updateNote(note.id, { checklists, updatedAt: new Date().toISOString() });
      refresh();
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // a long checklist runs past the bottom of its column, so a drag nudges things into view
  const dragKind = drag?.kind ?? "";
  useEffect(() => {
    if (!dragKind) return;
    let frame = 0;
    function step() {
      const { x, y } = pointer.current;
      const board = boardRef.current;
      if (board && dragKind === "note") {
        const box = board.getBoundingClientRect();
        if (x < box.left + 80) board.scrollLeft -= 14;
        else if (x > box.right - 80) board.scrollLeft += 14;
      }
      const scroller = document.elementFromPoint(x, y)?.closest<HTMLElement>(".column-rows");
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (y < box.top + 44) scroller.scrollTop -= 12;
        else if (y > box.bottom - 44) scroller.scrollTop += 12;
      }
      frame = requestAnimationFrame(step);
    }
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [dragKind]);

  function openCountFor(boardId: string) {
    const ids = categories.filter((category) => category.boardId === boardId && !category.archivedAt).map((category) => category.id);
    return notes.filter((note) => ids.includes(note.categoryId) && !note.completed && !note.archivedAt).length;
  }

  function openBoardDialog() {
    const template = boardTemplates[0];
    setDraftTemplate(template.id); setDraftName(template.board); setIsCreating(true);
  }

  // picking a template swaps in its suggested name, unless you already typed your own
  function pickTemplate(id: string) {
    const previous = boardTemplates.find((template) => template.id === draftTemplate);
    const next = boardTemplates.find((template) => template.id === id);
    if (!next) return;
    setDraftTemplate(id);
    if (!draftName.trim() || draftName === previous?.board) setDraftName(next.board);
  }

  async function createBoard() {
    const template = boardTemplates.find((item) => item.id === draftTemplate);
    if (!template) return;
    const board = await createBoardFromTemplate(template, draftName.trim() || template.board, boards.length);
    setIsCreating(false); setActiveBoardId(board.id); refresh();
  }

  async function addColumn(name: string) {
    cancelEdit();
    if (!activeBoard || !name.trim()) return;
    await database.categories.add(buildColumn(activeBoard.id, name.trim(), columns.length)); refresh();
  }

  async function renameColumn(category: Category, name: string) {
    cancelEdit();
    if (!name.trim() || name.trim() === category.name) return;
    await updateColumn(category.id, { name: name.trim() }); refresh();
  }

  // position is scoped to the column, so only count the rows already in this one
  async function addNote(category: Category, type: NoteType) {
    const position = notes.filter((note) => note.categoryId === category.id).length;
    const note = buildNote(category.id, position, type);
    await database.notes.add(note);
    await refresh();
    startEdit("note", note.id);
  }

  async function renameNote(note: Note, title: string) {
    cancelEdit();
    if (!title.trim() || title.trim() === note.title) return;
    await updateNote(note.id, { title: title.trim(), updatedAt: new Date().toISOString() }); refresh();
  }

  // the description is free text, so an empty one just clears it
  async function saveBody(note: Note, content: string) {
    cancelEdit();
    if (content.trim() === note.content) return;
    await updateNote(note.id, { content: content.trim(), updatedAt: new Date().toISOString() }); refresh();
  }

  // the note flag carries its checklists with it, both ways, the same as ticking a step
  // carries its sub steps. a done task with unticked steps left behind reads as unfinished
  async function toggleNote(note: Note) {
    const now = new Date().toISOString();
    const completed = !note.completed;
    await updateNote(note.id, {
      completed, completedAt: completed ? now : undefined, updatedAt: now,
      checklists: sweepNote(note.checklists, completed),
    });
    refresh();
  }

  // everything currently in the archive, in the order the view draws it
  const archivedIds = () => [
    ...archivedBoards.map((board) => board.id),
    ...archivedColumns.map((category) => category.id),
    ...archivedNotes.map((note) => note.id),
  ];

  // a selection can outlive what it pointed at, so only count what is still there
  const selection = archivedIds().filter((id) => picked.has(id));
  const allPicked = selection.length > 0 && selection.length === archivedIds().length;

  function togglePicked(id: string) {
    setConfirming("");
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleAllPicked() {
    setConfirming("");
    setPicked(allPicked ? new Set() : new Set(archivedIds()));
  }

  // changing page drops the archive selection, since it only means anything in there
  function openView(next: View) {
    setView(next); setPicked(new Set()); setConfirming("");
  }

  const showBoard = view === "board";

  // boards go first, so a cascade cleans up anything else that was picked underneath.
  // deleting a row that a cascade already removed is a no op, which keeps this simple.
  async function deletePicked() {
    const chosen = new Set(selection);
    for (const board of archivedBoards.filter((row) => chosen.has(row.id))) await deleteBoardForever(board.id);
    for (const category of archivedColumns.filter((row) => chosen.has(row.id))) await deleteColumnForever(category.id);
    for (const note of archivedNotes.filter((row) => chosen.has(row.id))) await deleteNoteForever(note.id);
    setPicked(new Set()); setConfirming(""); refresh();
  }

  async function restorePicked() {
    const chosen = new Set(selection);
    for (const board of archivedBoards.filter((row) => chosen.has(row.id))) await setBoardArchived(board.id, false);
    for (const category of archivedColumns.filter((row) => chosen.has(row.id))) await setColumnArchived(category.id, false);
    for (const note of archivedNotes.filter((row) => chosen.has(row.id))) await setNoteArchived(note.id, false);
    setPicked(new Set()); setConfirming(""); refresh();
  }

  // archiving is reversible and lives under the Archive entry in the sidebar
  async function archiveBoard(board: Board) { setConfirming(""); await setBoardArchived(board.id, true); refresh(); }
  async function archiveColumn(category: Category) { setConfirming(""); await setColumnArchived(category.id, true); refresh(); }
  async function archiveNote(note: Note) { setConfirming(""); await setNoteArchived(note.id, true); refresh(); }

  async function restoreBoard(board: Board) { await setBoardArchived(board.id, false); setActiveBoardId(board.id); refresh(); }
  async function restoreColumn(category: Category) { await setColumnArchived(category.id, false); refresh(); }
  async function restoreNote(note: Note) { await setNoteArchived(note.id, false); refresh(); }

  // deleting is the permanent one, and it takes everything underneath with it
  async function destroyBoard(board: Board) { setConfirming(""); await deleteBoardForever(board.id); refresh(); }
  async function destroyColumn(category: Category) { setConfirming(""); await deleteColumnForever(category.id); refresh(); }
  async function destroyNote(note: Note) { setConfirming(""); await deleteNoteForever(note.id); refresh(); }

  const columnNameFor = (categoryId: string) =>
    categories.find((category) => category.id === categoryId)?.name ?? "a deleted column";

  const plural = (count: number, word: string) => `${count} ${count === 1 ? word : word + "s"}`;

  const shortDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  // one row shape for boards, columns and tasks alike
  const archiveRow = (id: string, title: string, meta: string, onRestore: () => void, onDelete: () => void) =>
    <div className={`archive-row ${picked.has(id) ? "picked" : ""}`} key={id}>
      <button className="check-box" onClick={() => togglePicked(id)} aria-label={`${picked.has(id) ? "Deselect" : "Select"} ${title}`}>
        {picked.has(id) ? <SquareCheckBig size={16} /> : <Square size={16} />}
      </button>
      <div className="archive-what"><strong>{title}</strong><span>{meta}</span></div>
      {confirming === id
        ? <div className="archive-actions">
            <span className="archive-warn">Delete for good?</span>
            <button className="danger-button" onClick={onDelete}>Delete</button>
            <button className="ghost-button small" onClick={() => setConfirming("")}>Cancel</button>
          </div>
        : <div className="archive-actions">
            <button className="ghost-button small" onClick={onRestore}><ArchiveRestore size={14} />Restore</button>
            <button className="row-action" onClick={() => setConfirming(id)} aria-label={`Delete ${title} for good`}><Trash2 size={14} /></button>
          </div>}
    </div>;

  const boardNameFor = (categoryId: string) => {
    const owner = categories.find((category) => category.id === categoryId);
    return boards.find((board) => board.id === owner?.boardId)?.name ?? "a deleted board";
  };

  async function saveChecklists(note: Note, checklists: Checklist[]) {
    await updateNote(note.id, { checklists, updatedAt: new Date().toISOString() }); refresh();
  }

  const withList = (note: Note, listId: string, change: (list: Checklist) => Checklist) =>
    note.checklists.map((list) => (list.id === listId ? change(list) : list));

  // ids are unique across the note, so this reaches a step however deep it sits
  const withItem = (note: Note, itemId: string, change: (item: ChecklistItem) => ChecklistItem) =>
    note.checklists.map((list) => ({
      ...list, items: mapItems(list.items, (item) => (item.id === itemId ? change(item) : item)),
    }));

  // a note can carry several named checklists, and gaining one makes it a checklist note
  async function addChecklist(note: Note, name: string) {
    cancelEdit();
    if (!name.trim()) return;
    const list = buildChecklist(name.trim());
    await updateNote(note.id, { checklists: [...note.checklists, list], type: "checklist", updatedAt: new Date().toISOString() });
    await refresh();
    startEdit("newStep", list.id);
  }

  async function renameChecklist(note: Note, list: Checklist, name: string) {
    cancelEdit();
    if (!name.trim() || name.trim() === list.name) return;
    saveChecklists(note, withList(note, list.id, (current) => ({ ...current, name: name.trim() })));
  }

  function deleteChecklist(note: Note, listId: string) {
    setConfirming("");
    saveChecklists(note, note.checklists.filter((list) => list.id !== listId));
  }

  // owner is the checklist for a top level step, or the step it indents under. either way
  // the new one goes on the end and the composer stays open for the next
  async function addItem(note: Note, ownerId: string, text: string) {
    cancelEdit();
    if (!text.trim()) return;
    const checklists = placeNoteItem(note.checklists, ownerId, buildItem(text.trim()), Number.MAX_SAFE_INTEGER);
    await saveChecklists(note, checklists);
    expand(ownerId);
    startEdit("newStep", ownerId);
  }

  // with roll up on a step carries its sub steps with it, then everything above it catches
  // up, so a step is ticked exactly when all of its own sub steps are
  function toggleItem(note: Note, itemId: string) {
    const target = findItem(note.checklists, itemId);
    if (!target) return;

    const completed = !target.completed;
    const flip = (item: ChecklistItem): ChecklistItem => settings.rollUpSteps
      ? { ...item, completed, items: item.items.map(flip) }
      : { ...item, completed };

    const ticked = withItem(note, itemId, flip);
    saveChecklists(note, settings.rollUpSteps ? rollUpNote(ticked) : ticked);
  }

  // removing a step takes its sub steps with it, they only exist under it
  async function renameItem(note: Note, item: ChecklistItem, text: string) {
    cancelEdit();
    if (!text.trim() || text.trim() === item.text) return;
    saveChecklists(note, withItem(note, item.id, (current) => ({ ...current, text: text.trim() })));
  }

  const removeItem = (note: Note, itemId: string) =>
    saveChecklists(note, dropNoteItem(note.checklists, itemId));

  // one switch in the settings menu
  const settingRow = (key: keyof Settings, title: string, blurb: string) =>
    <button type="button" className={`setting-row ${settings[key] ? "on" : ""}`} role="switch" aria-checked={settings[key]}
      onClick={() => toggleSetting(key)}>
      <span className="setting-what"><strong>{title}</strong><small>{blurb}</small></span>
      <span className="switch"><span /></span>
    </button>;

  // one checklist. the count and the bar track its top level steps, what indents under
  // them rolls up on the step itself rather than in here
  function renderChecklist(note: Note, list: Checklist) {
    const done = list.items.filter((item) => item.completed).length;
    const listShut = isCollapsed(list.id);

    return <div className={`checklist-group ${listShut ? "collapsed" : ""}`} data-checklist-id={list.id} data-step-owner={list.id}>
      <div className="checklist-head">
        {isEditing("list", list.id)
          ? <InlineInput value={list.name} placeholder="Checklist name"
              onCommit={(text) => renameChecklist(note, list, text)} onCancel={cancelEdit} />
          : <><button className="row-action" onClick={() => toggleCollapse(list.id)} aria-label={`${listShut ? "Expand" : "Collapse"} ${list.name}`}>
                {listShut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
              <button className="checklist-name" onClick={() => startEdit("list", list.id)}>{list.name}</button>
              <span className="checklist-count">{done} of {list.items.length}</span>
              <button className="row-action drag-handle" onPointerDown={(event) => beginListDrag(event, note, list)} aria-label={`Move ${list.name}`}><GripVertical size={13} /></button>
              <button className="row-action" onClick={() => setConfirming(list.id)} aria-label={`Delete ${list.name}`}><X size={13} /></button></>}
      </div>

      {confirming === list.id && <div className="confirm-bar tight">
        <span>Delete this checklist?</span>
        <button className="danger-button" onClick={() => deleteChecklist(note, list.id)}>Delete</button>
        <button className="ghost-button small" onClick={() => setConfirming("")}>Cancel</button>
      </div>}

      {list.items.length > 0 && <div className="progress">
        <span style={{ width: `${Math.round((done / list.items.length) * 100)}%` }} />
      </div>}

      {!listShut && renderSteps(note, list.id, list.items, 0)}
    </div>;
  }

  // the steps under a checklist or under another step, with their drop slots and the
  // composer that adds to this level. the same markup all the way down
  function renderSteps(note: Note, ownerId: string, source: ChecklistItem[], depth: number) {
    const steps = source.filter((item) => !(drag?.kind === "item" && item.id === drag.id));
    const slotAt = (at: number) => drag?.kind === "item" && drag.container === ownerId && drag.index === at;

    return <>
      {steps.map((item, index) => <Fragment key={item.id}>
        {slotAt(index) && <div className="drop-slot step" style={{ height: drag?.height }} />}
        {renderItem(note, item, depth)}
      </Fragment>)}
      {slotAt(steps.length) && <div className="drop-slot step" style={{ height: drag?.height }} />}

      {isEditing("newStep", ownerId)
        ? <div className="step-composer">
            <Square size={15} />
            <InlineInput placeholder={depth ? "Sub step, then enter" : "Step, then enter"}
              onCommit={(text) => addItem(note, ownerId, text)} onCancel={cancelEdit} />
          </div>
        : !depth && <button className="add-item indented" onClick={() => startEdit("newStep", ownerId)}><Plus size={13} />Add step</button>}
    </>;
  }

  // a step, plus whatever indents under it. the wrapper is what holds the sub steps, so
  // folding the step hides the lot and dragging it takes them along
  function renderItem(note: Note, item: ChecklistItem, depth: number) {
    const itemShut = isCollapsed(item.id);
    const nested = allItems(item.items);
    const nestedDone = nested.filter((step) => step.completed).length;
    const composing = isEditing("newStep", item.id);

    return <div className={`check-item-group ${itemShut ? "collapsed" : ""}`} data-item-id={item.id}>
      <div className={`check-item ${item.completed ? "done" : ""}`}>
        {item.items.length > 0
          ? <button className="row-action item-fold" onClick={() => toggleCollapse(item.id)} aria-label={`${itemShut ? "Expand" : "Collapse"} the steps under ${item.text}`}>
              {itemShut ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
          : <span className="fold-spacer" />}
        <button className="row-action drag-handle" onPointerDown={(event) => beginItemDrag(event, note, item.id, item.text)} aria-label={`Move ${item.text}`}><GripVertical size={12} /></button>
        <button className="check-toggle" onClick={() => toggleItem(note, item.id)} aria-label={item.completed ? `Untick ${item.text}` : `Tick ${item.text}`}>
          {item.completed ? <SquareCheckBig size={15} /> : <Square size={15} />}
        </button>
        {isEditing("item", item.id)
          ? <InlineInput value={item.text} placeholder="Step"
              onCommit={(text) => renameItem(note, item, text)} onCancel={cancelEdit} />
          : <><button className="check-text" onClick={() => startEdit("item", item.id)}>{item.text}</button>
              {nested.length > 0 && <span className="checklist-count">{nestedDone} of {nested.length}</span>}
              <button className="row-action" onClick={() => { expand(item.id); startEdit("newStep", item.id); }} aria-label={`Add a step under ${item.text}`} title="Add sub step"><ListTree size={12} /></button>
              <button className="row-action" onClick={() => removeItem(note, item.id)} aria-label={`Remove ${item.text}`}><X size={13} /></button></>}
      </div>

      {/* past a few levels the indent stops growing, otherwise the text ends up a letter
          wide in a narrow column and the row runs on forever */}
      {!itemShut && (item.items.length > 0 || composing) && <div className={`sub-steps ${depth >= 3 ? "tight" : ""}`} data-step-owner={item.id}>
        {renderSteps(note, item.id, item.items, depth + 1)}
      </div>}
    </div>;
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Layers3 size={18} /></div><span>Taskboard</span></div>
      <div className="sidebar-label">Your boards <button className="icon-button" onClick={openBoardDialog} aria-label="Add board"><Plus size={16} /></button></div>
      <nav className="board-list">
        {liveBoards.map((board) => <button key={board.id} className={`board-button ${showBoard && activeBoard?.id === board.id ? "active" : ""}`} onClick={() => { openView("board"); setActiveBoardId(board.id); }}>
          {board.name}<span className="note-count">{openCountFor(board.id)}</span>
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className={`utility-button ${view === "archive" ? "active" : ""}`} onClick={() => openView(view === "archive" ? "board" : "archive")}>
          <Archive size={17} />Archive{archivedCount > 0 && <span className="note-count">{archivedCount}</span>}
        </button>
        <button className={`utility-button ${view === "connect" ? "active" : ""}`} onClick={() => openView(view === "connect" ? "board" : "connect")}>
          <PlugZap size={17} />Connect Agents
          {settings.agentAccess && <span className={`note-count ${bridge?.listening ? "live" : ""}`}>{bridge?.listening ? "on" : "…"}</span>}
        </button>
        <button className={`utility-button ${view === "sync" ? "active" : ""}`} onClick={() => openView(view === "sync" ? "board" : "sync")}>
          <CloudUpload size={17} />Sync
          {syncKey && <span className="note-count">on</span>}
        </button>
        <button className={`utility-button ${showTransfer ? "active" : ""}`} onClick={() => setShowTransfer(true)}>
          <ArrowDownUp size={17} />Import &amp; export
        </button>
        <button className={`utility-button ${showSettings ? "active" : ""}`} onClick={() => setShowSettings(true)}><Settings2 size={17} />Settings</button>
        <div className={`local-status ${sync?.state ?? ""}`}>
          <span />{sync && syncKey ? describeSync(sync) : "Stored on this device"}
        </div>
      </div>
    </aside>

    <section className="content">
      <header className="topbar">
        <div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{view === "archive" ? "Archive" : view === "connect" ? "Connect Agents" : view === "sync" ? "Sync" : activeBoard?.name ?? "No boards"}</strong></div>
        <div className="top-actions">
          <div className="search-box">
            <Search size={17} />
            <input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" />
            <kbd>Ctrl K</kbd>
          </div>
          <button className="avatar" aria-label="Profile">N</button>
        </div>
      </header>

      <div className="board-heading">
        <div>
          <div className="eyebrow"><Sparkles size={14} />Personal workspace</div>
          <h1>{view === "archive" ? "Archive" : view === "connect" ? "Connect Agents" : view === "sync" ? "Sync" : activeBoard?.name ?? "No boards yet"}</h1>
          <p>{view === "archive" ? "Put things back, or clear them out for good."
            : view === "sync" ? "Reach these boards from your other devices."
            : view === "connect" ? "Let an AI agent add tasks and tick them off for you."
            : "Keep the signal visible. Let the rest wait."}</p>
        </div>
        {!showBoard
          ? <button className="ghost-button" onClick={() => openView("board")}><ArrowLeft size={16} />Back to the board</button>
          : activeBoard
            ? <div className="heading-actions">
                <button className="icon-button" onClick={() => archiveBoard(activeBoard)} aria-label={`Archive ${activeBoard.name}`} title="Archive this board"><Archive size={17} /></button>
                <button className="primary-button" onClick={() => startEdit("newColumn", "new")}><Plus size={17} />New column</button>
              </div>
            : <button className="primary-button" onClick={openBoardDialog}><Plus size={17} />New board</button>}
      </div>

      {activeBoard && showBoard && <div className="toolbar">
        <div className="board-stats">
          <span>{shownColumns.length} columns</span><span className="stat-divider" />
          <span>{boardNotes.length} notes</span><span className="stat-divider" />
          <span>{boardNotes.filter((note) => note.completed).length} completed</span>
        </div>
        <button className={`filter-button ${!showCompleted ? "selected" : ""}`} onClick={() => setShowCompleted(!showCompleted)}>
          <Filter size={16} />{showCompleted ? "All notes" : "Active only"}
        </button>
      </div>}

      {!activeBoard && showBoard && <div className="empty-board">
        <div className="empty-mark"><Columns3 size={22} /></div>
        <strong>Nothing here yet</strong>
        <p>Create a board and pick a template. The columns come with it.</p>
        <button className="primary-button" onClick={openBoardDialog}><Plus size={17} />New board</button>
      </div>}

      {view === "connect" && <Connect
        bridge={bridge} log={bridgeLog} access={settings.agentAccess}
        onAccess={() => toggleSetting("agentAccess")}
        awake={awake} tabAwake={settings.tabAwake} screenAwake={settings.screenAwake}
        onTabAwake={() => toggleSetting("tabAwake")} onScreenAwake={() => toggleSetting("screenAwake")}
        board={activeBoard?.name} column={columns[0]?.name}
        onBack={() => openView("board")} />}

      {view === "sync" && <Sync
        onBack={() => openView("board")}
        onPulled={async () => { await refresh(); setSyncKey(readKey()); }} />}

      {view === "archive" && <div className="archive-view">
        {!archivedCount && <div className="empty-board">
          <div className="empty-mark"><Archive size={22} /></div>
          <strong>The archive is empty</strong>
          <p>Archive a board, a column or a task and it waits here until you want it back.</p>
        </div>}

        {archivedCount > 0 && <div className="archive-bar">
          <button className="check-box" onClick={toggleAllPicked} aria-label={allPicked ? "Clear the selection" : "Select everything"}>
            {allPicked ? <SquareCheckBig size={16} /> : <Square size={16} />}
          </button>

          {selection.length === 0
            ? <span className="archive-hint">Select items to restore or delete them together.</span>
            : <>
                <span className="archive-hint">{plural(selection.length, "item")} selected</span>
                <div className="archive-actions">
                  {confirming === "bulk"
                    ? <>
                        <span className="archive-warn">Delete {plural(selection.length, "item")} for good?</span>
                        <button className="danger-button" onClick={deletePicked}>Delete</button>
                        <button className="ghost-button small" onClick={() => setConfirming("")}>Cancel</button>
                      </>
                    : <>
                        <button className="ghost-button small" onClick={restorePicked}><ArchiveRestore size={14} />Restore</button>
                        <button className="danger-button" onClick={() => setConfirming("bulk")}><Trash2 size={14} />Delete</button>
                        <button className="ghost-button small" onClick={() => setPicked(new Set())}>Clear</button>
                      </>}
                </div>
              </>}
        </div>}

        {archivedBoards.length > 0 && <section className="archive-group">
          <h2>Boards <span>{archivedBoards.length}</span></h2>
          {archivedBoards.map((board) => archiveRow(
            board.id, board.name,
            `${categories.filter((category) => category.boardId === board.id).length} columns \u00b7 archived ${shortDate(board.archivedAt)}`,
            () => restoreBoard(board), () => destroyBoard(board)))}
        </section>}

        {archivedColumns.length > 0 && <section className="archive-group">
          <h2>Columns <span>{archivedColumns.length}</span></h2>
          {archivedColumns.map((category) => archiveRow(
            category.id, category.name,
            `in ${boards.find((board) => board.id === category.boardId)?.name ?? "a deleted board"} \u00b7 ${notes.filter((note) => note.categoryId === category.id).length} tasks \u00b7 archived ${shortDate(category.archivedAt)}`,
            () => restoreColumn(category), () => destroyColumn(category)))}
        </section>}

        {archivedNotes.length > 0 && <section className="archive-group">
          <h2>Tasks <span>{archivedNotes.length}</span></h2>
          {archivedNotes.map((note) => archiveRow(
            note.id, note.title,
            `in ${columnNameFor(note.categoryId)}, ${boardNameFor(note.categoryId)} \u00b7 archived ${shortDate(note.archivedAt)}`,
            () => restoreNote(note), () => destroyNote(note)))}
        </section>}

        {archivedCount > 0 && <p className="archive-note">
          Restoring a task or column only brings it back if what it sits in is not archived too.
          Deleting takes everything underneath with it, and that one cannot be undone.
        </p>}
      </div>}

      {activeBoard && showBoard && <div className={`board-columns ${settings.compactRows ? "compact" : ""}`} ref={boardRef} data-board-id={activeBoard.id}>
        {laidOutColumns.map((category, columnIndex) => {
          const rows = rowsFor(category.id).filter((note) => !(drag?.kind === "note" && note.id === drag.id));
          const slotAt = (index: number) => drag?.kind === "note" && drag.container === category.id && drag.index === index;
          const columnShut = isCollapsed(category.id);
          return <Fragment key={category.id}>
            {drag?.kind === "column" && drag.index === columnIndex && <div className="drop-slot column" style={{ width: drag.width }} />}
            <section className={`column ${columnShut ? "collapsed" : ""}`} data-column-id={category.id}
              style={{ "--column-width": `${widthOf(category)}px` } as React.CSSProperties}>
            {columnShut && <button className="column-strip" onPointerDown={(event) => beginColumnDrag(event, category)}
              onClick={() => toggleCollapse(category.id)} aria-label={`Expand ${category.name}`}>
              <ChevronRight size={14} />
              <span className={`category-dot ${category.color}`} />
              <span className="strip-name">{category.name}</span>
              <span className="strip-count">{rows.length}</span>
            </button>}

            {!columnShut && <header className="column-head">
              <button className="icon-button" onClick={() => toggleCollapse(category.id)} aria-label={`Collapse ${category.name}`}><ChevronDown size={14} /></button>
              <span className={`category-dot ${category.color}`} />
              {isEditing("column", category.id)
                ? <InlineInput value={category.name} placeholder="Column name"
                    onCommit={(text) => renameColumn(category, text)} onCancel={cancelEdit} />
                : <><h2>{category.name}</h2><span className="note-count">{rows.length}</span>
                    <button className="icon-button" onClick={() => startEdit("column", category.id)} aria-label={`Rename ${category.name}`}><Pencil size={14} /></button>
                    <button className="icon-button drag-handle" onPointerDown={(event) => beginColumnDrag(event, category)} aria-label={`Move ${category.name}`}><GripVertical size={14} /></button>
                    <button className="icon-button" onClick={() => archiveColumn(category)} aria-label={`Archive ${category.name}`} title="Archive this column"><Archive size={14} /></button></>}
            </header>}

            {!columnShut && <div className="column-rows">
              {rows.map((note, index) => {
                const noteShut = isCollapsed(note.id);
                const lists = note.checklists.filter((list) => !(drag?.kind === "list" && list.id === drag.id));
                const listSlotAt = (at: number) => drag?.kind === "list" && drag.container === note.id && drag.index === at;
                return <Fragment key={note.id}>
                {slotAt(index) && <div className="drop-slot" style={{ height: drag?.height }} />}
                <article className={`note-row ${note.completed ? "completed" : ""}`} data-note-id={note.id}
                  onPointerDown={(event) => beginNoteDrag(event, note, false)}>
                  <div className="note-row-top">
                    <button className="row-action note-fold" onClick={() => toggleCollapse(note.id)} aria-label={`${noteShut ? "Expand" : "Collapse"} ${note.title}`}>
                      {noteShut ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>
                    <button className="complete-button" onClick={() => toggleNote(note)} aria-label={note.completed ? "Mark incomplete" : "Mark complete"}>
                      {note.completed ? <Check size={16} /> : <Circle size={16} />}
                    </button>
                    {isEditing("note", note.id)
                      ? <InlineInput value={note.title} placeholder="Note title"
                          onCommit={(text) => renameNote(note, text)} onCancel={cancelEdit} />
                      : <><button className="note-title" onClick={() => startEdit("note", note.id)}>{note.title}</button>
                          <button className="row-action drag-handle" onPointerDown={(event) => beginNoteDrag(event, note, true)} aria-label={`Move ${note.title}`}><GripVertical size={14} /></button>
                          <button className="row-action" onClick={() => archiveNote(note)} aria-label={`Archive ${note.title}`} title="Archive this task"><Archive size={14} /></button></>}
                  </div>

                  {noteShut ? <>
                    <div className="note-collapsed">
                      <span className={`note-type ${note.type}`}>{typeLabels[note.type]}</span>
                      {settings.collapsedSteps && note.checklists.length > 0 && <span>
                        {noteItems(note.checklists).filter((item) => item.completed).length} of {noteItems(note.checklists).length} steps
                        {" in "}{plural(note.checklists.length, "checklist")}
                      </span>}
                      {settings.collapsedDescription && note.content && <p className="note-preview">{shorten(note.content)}</p>}
                    </div>

                    {/* folded or not the date stays, folding just drops the buttons */}
                    <div className="note-footer folded"><span>{shortDate(note.updatedAt)}</span></div>
                  </> : <>

                  <span className={`note-type ${note.type}`}>{typeLabels[note.type]}</span>

                  {isEditing("body", note.id)
                    ? <div className="body-editor">
                        <InlineInput multiline value={note.content} placeholder="Description, ctrl+enter to save"
                          onCommit={(text) => saveBody(note, text)} onCancel={cancelEdit} />
                      </div>
                    : note.content && <button className="note-body" onClick={() => startEdit("body", note.id)}>{note.content}</button>}

                  {lists.map((list, listIndex) => <Fragment key={list.id}>
                    {listSlotAt(listIndex) && <div className="drop-slot list" style={{ height: drag?.height }} />}
                    {renderChecklist(note, list)}
                  </Fragment>)}

                  {listSlotAt(lists.length) && <div className="drop-slot list" style={{ height: drag?.height }} />}

                  {isEditing("newList", note.id) && <div className="step-composer">
                    <ListChecks size={15} />
                    <InlineInput placeholder="Checklist name, then enter" onCommit={(text) => addChecklist(note, text)} onCancel={cancelEdit} />
                  </div>}

                  {<div className="note-footer">
                        <div className="footer-actions">
                          <button className="add-item" onClick={() => startEdit("newList", note.id)}><ListChecks size={13} />Add checklist</button>
                          {!note.content && <button className="add-item" onClick={() => startEdit("body", note.id)}><TextAlignStart size={13} />Add description</button>}
                        </div>
                        <span>{new Date(note.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      </div>}
                  </>}
                </article>
              </Fragment>; })}

              {slotAt(rows.length) && <div className="drop-slot" style={{ height: drag?.height }} />}
              {!rows.length && !drag && <p className="column-empty">Nothing here yet.</p>}
            </div>}

            {!columnShut && <div className="column-add">
              <button className="add-note" onClick={() => addNote(category, "idea")}><Plus size={15} />Add task</button>
              <button className="icon-button" onClick={() => addNote(category, "checklist")} aria-label="Add checklist" title="Add checklist"><ListChecks size={15} /></button>
            </div>}

            {!columnShut && <div className={`column-grip ${sizing?.id === category.id ? "sizing" : ""}`}
              onPointerDown={(event) => beginResize(event, category)}
              onDoubleClick={() => resetWidth(category)}
              title="Drag to resize, double click to reset" />}
            </section>
          </Fragment>;
        })}

        {drag?.kind === "column" && drag.index >= laidOutColumns.length && <div className="drop-slot column" style={{ width: drag.width }} />}

        {isEditing("newColumn", "new")
          ? <div className="add-column composing">
              <InlineInput placeholder="Column name, then enter" onCommit={addColumn} onCancel={cancelEdit} />
            </div>
          : <button className="add-column" onClick={() => startEdit("newColumn", "new")}>
              <span><Plus size={19} /></span><strong>Add a column</strong><small>Group the work on this board</small>
            </button>}
      </div>}
    </section>

    {drag && <div className={`drag-ghost ${drag.kind === "item" ? "step" : drag.kind === "column" ? "column" : ""}`} style={{ left: drag.x, top: drag.y }}>{drag.title}</div>}

    {showSettings && <div className="modal-overlay" onClick={() => setShowSettings(false)}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div><strong>Settings</strong><span>How the board looks and works on this device.</span></div>
          <button type="button" className="icon-button" onClick={() => setShowSettings(false)} aria-label="Close"><X size={17} /></button>
        </header>

        <div className="field-label">Folded tasks</div>
        <div className="setting-group">
          {settingRow("collapsedDescription", "Show a shortened description", "A folded task keeps the start of its description, cut to a couple of lines.")}
          {settingRow("collapsedSteps", "Show the step count", "How many steps are done, and how many checklists they sit in.")}
        </div>

        <div className="field-label">Checklists</div>
        <div className="setting-group">
          {settingRow("rollUpSteps", "Sub steps drive the step above them", "Ticking a step ticks everything under it, and a step ticks itself once all of its sub steps are done.")}
        </div>

        <div className="field-label">Board</div>
        <div className="setting-group">
          {settingRow("compactRows", "Tighter spacing", "Less padding on the rows, so more of the column fits on screen.")}
          <div className="setting-actions">
            <button type="button" className="ghost-button small" onClick={() => { setShowSettings(false); openView("connect"); }}><PlugZap size={14} />Connect Agents</button>
            <button type="button" className="ghost-button small" onClick={() => { setShowSettings(false); setShowTransfer(true); }}><ArrowDownUp size={14} />Import &amp; export</button>
            <button type="button" className="ghost-button small" onClick={expandEverything}><ChevronDown size={14} />Unfold everything</button>
            <button type="button" className="ghost-button small" onClick={resetColumnWidths}><Columns3 size={14} />Reset column widths</button>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={() => setShowSettings(false)}>Done</button>
        </div>
      </div>
    </div>}

    {showTransfer && <ImportExport
      boards={boards} categories={categories} notes={notes} activeBoardId={activeBoard?.id ?? ""}
      onClose={() => setShowTransfer(false)}
      onImported={async (boardId: string) => {
        await refresh();
        if (!boardId) return;
        openView("board");
        setActiveBoardId(boardId);
      }} />}

    {isCreating && <div className="modal-overlay" onClick={() => setIsCreating(false)}>
      <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); createBoard(); }}>
        <header className="modal-head">
          <div><strong>New board</strong><span>Pick a template to start from.</span></div>
          <button type="button" className="icon-button" onClick={() => setIsCreating(false)} aria-label="Close"><X size={17} /></button>
        </header>

        <label className="field">
          <span>Board name</span>
          <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Board name" autoFocus />
        </label>

        <div className="field-label">Template</div>
        <div className="template-grid">
          {boardTemplates.map((template) => <button type="button" key={template.id}
            className={`template-card ${draftTemplate === template.id ? "selected" : ""}`}
            onClick={() => pickTemplate(template.id)}>
            <strong>{template.name}</strong>
            <small>{template.description}</small>
            <div className="template-preview">
              {template.columns.length
                ? template.columns.map((column) => <span key={column.name}>{column.name}</span>)
                : <span className="faint">No columns</span>}
            </div>
          </button>)}
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={() => setIsCreating(false)}>Cancel</button>
          <button type="submit" className="primary-button"><Plus size={16} />Create board</button>
        </div>
      </form>
    </div>}
  </main>;
}

export default App;
