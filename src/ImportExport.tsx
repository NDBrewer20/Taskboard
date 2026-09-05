// Boards on their way out and on their way back in. Export picks the boards and the shape
// they leave in, import only takes the JSON one back, since that is the only format that
// still has everything in it.

import { useMemo, useRef, useState } from "react";
import { Braces, Check, Copy, Download, FileSpreadsheet, FileText, FolderInput, Square, SquareCheckBig, Upload, X } from "lucide-react";
import type { BoardBundle, TransferFormat } from "./transfer";
import { copyText, fileName, formatMeta, gather, importBoards, readTransfer, saveFile, serialize, tally, transferFormats } from "./transfer";
import type { Board, Category, Note } from "./types";

const formatIcons: Record<TransferFormat, typeof Braces> = {
  json: Braces, csv: FileSpreadsheet, markdown: FileText,
};

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

// what a pile of boards adds up to, the line under the format cards and under the file
const summary = (counts: { boards: number; columns: number; notes: number }) =>
  `${plural(counts.boards, "board")} · ${plural(counts.columns, "column")} · ${plural(counts.notes, "task")}`;

// one selectable row, used for the boards going out and the boards coming in
function PickRow({ on, title, meta, onPick }: { on: boolean; title: string; meta: string; onPick: () => void }) {
  return <button type="button" className={`pick-row ${on ? "picked" : ""}`} role="checkbox" aria-checked={on} onClick={onPick}>
    {on ? <SquareCheckBig size={16} /> : <Square size={16} />}
    <span className="pick-what"><strong>{title}</strong><span>{meta}</span></span>
  </button>;
}

export default function ImportExport({ boards, categories, notes, activeBoardId, onClose, onImported }: {
  boards: Board[];
  categories: Category[];
  notes: Note[];
  activeBoardId: string;
  onClose: () => void;
  onImported: (boardId: string) => void;
}) {
  const [tab, setTab] = useState<"export" | "import">("export");
  // the board you have open is the one you probably meant, so it starts ticked
  const [picked, setPicked] = useState<Set<string>>(() => new Set(activeBoardId ? [activeBoardId] : []));
  const [format, setFormat] = useState<TransferFormat>("json");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [copied, setCopied] = useState(false);

  const [incoming, setIncoming] = useState<BoardBundle[] | null>(null);
  const [takeIn, setTakeIn] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState("");
  const [landed, setLanded] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [over, setOver] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);

  const meta = formatMeta(format);
  const bundles = useMemo(
    () => gather(boards, categories, notes, picked, includeArchived),
    [boards, categories, notes, picked, includeArchived]);

  const counts = tally(bundles);
  const name = fileName(bundles, format);

  const countsFor = (boardId: string) => {
    const columns = categories.filter((category) => category.boardId === boardId);
    const ids = new Set(columns.map((column) => column.id));
    return { columns: columns.length, notes: notes.filter((note) => ids.has(note.categoryId)).length };
  };

  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const allPicked = boards.length > 0 && picked.size === boards.length;
  const pickAll = () => setPicked(allPicked ? new Set() : new Set(boards.map((board) => board.id)));

  function download() {
    if (!bundles.length) return;
    saveFile(name, serialize(bundles, format), meta.mime);
  }

  // the file is the normal way out, but a download can be awkward in an embedded browser,
  // so the same text can go straight to the clipboard instead
  async function copy() {
    if (!bundles.length) return;
    setCopied(await copyText(serialize(bundles, format)));
    window.setTimeout(() => setCopied(false), 1600);
  }

  // whatever came in gets parsed straight away, so you see what is in it before it lands
  function inspect(text: string) {
    setLanded(""); setProblem(""); setIncoming(null);
    try {
      const found = readTransfer(text);
      setIncoming(found);
      setTakeIn(new Set(found.map((bundle) => bundle.board.id)));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That file could not be read.");
    }
  }

  async function openFile(file?: File | null) {
    if (!file) return;
    inspect(await file.text());
  }

  function drop(event: React.DragEvent) {
    event.preventDefault();
    setOver(false);
    openFile(event.dataTransfer.files?.[0]);
  }

  async function land() {
    if (!incoming) return;
    const chosen = incoming.filter((bundle) => takeIn.has(bundle.board.id));
    if (!chosen.length) return;

    const done = await importBoards(chosen);
    setIncoming(null); setPasted(""); setPasting(false);
    setLanded(`Added ${plural(done.boards, "board")}, ${plural(done.columns, "column")} and ${plural(done.notes, "task")}.`);
    onImported(done.firstBoardId);
  }

  const takingIn = incoming?.filter((bundle) => takeIn.has(bundle.board.id)) ?? [];

  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <header className="modal-head">
        <div>
          <strong>Import &amp; export</strong>
          <span>Take your boards to another computer, or hand one to someone else.</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </header>

      <div className="tab-row">
        <button type="button" className={`tab ${tab === "export" ? "on" : ""}`} onClick={() => setTab("export")}>
          <Download size={14} />Export
        </button>
        <button type="button" className={`tab ${tab === "import" ? "on" : ""}`} onClick={() => setTab("import")}>
          <Upload size={14} />Import
        </button>
      </div>

      {tab === "export" ? <>
        <div className="field-label">
          Boards
          {boards.length > 0 && <button type="button" className="ghost-button small" onClick={pickAll}>
            {allPicked ? "Select none" : "Select all"}
          </button>}
        </div>

        {boards.length
          ? <div className="pick-list">
              {boards.map((board) => {
                const own = countsFor(board.id);
                return <PickRow key={board.id} on={picked.has(board.id)} title={board.name}
                  meta={`${plural(own.columns, "column")} · ${plural(own.notes, "task")}${board.archivedAt ? " · archived" : ""}`}
                  onPick={() => toggle(board.id)} />;
              })}
            </div>
          : <p className="transfer-note">There is nothing to export yet. Create a board first.</p>}

        <div className="field-label">Format</div>
        <div className="template-grid formats">
          {transferFormats.map((row) => {
            const Icon = formatIcons[row.id];
            return <button type="button" key={row.id} className={`template-card ${format === row.id ? "selected" : ""}`}
              onClick={() => setFormat(row.id)}>
              <strong><Icon size={14} />{row.name}</strong>
              <small>{row.blurb}</small>
            </button>;
          })}
        </div>

        <div className="setting-group">
          <button type="button" className={`setting-row ${includeArchived ? "on" : ""}`} role="switch" aria-checked={includeArchived}
            onClick={() => setIncludeArchived(!includeArchived)}>
            <span className="setting-what">
              <strong>Include archived columns and tasks</strong>
              <small>Off by default, so what you hand over is just the board as it looks now.</small>
            </span>
            <span className="switch"><span /></span>
          </button>
        </div>

        <p className="transfer-note">
          {picked.size
            ? <>{summary(counts)} → <code>{name}</code></>
            : "Pick at least one board."}
        </p>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={copy} disabled={!bundles.length}>
            {copied ? <><Check size={15} />Copied</> : <><Copy size={15} />Copy</>}
          </button>
          <button type="button" className="primary-button" onClick={download} disabled={!bundles.length}>
            <Download size={16} />Export {meta.name}
          </button>
        </div>
      </> : <>
        <div className={`drop-zone ${over ? "over" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          onClick={() => filePicker.current?.click()}>
          <FolderInput size={20} />
          <strong>Drop a Taskboard JSON file here</strong>
          <small>Or click to pick one. CSV and Markdown are for reading, only the JSON comes back in.</small>
        </div>

        <input ref={filePicker} type="file" accept=".json,application/json" hidden
          onChange={(event) => { openFile(event.target.files?.[0]); event.target.value = ""; }} />

        {pasting
          ? <div className="field">
              <span>Or paste the file</span>
              <textarea className="paste-box" value={pasted} placeholder="Paste the JSON here"
                onChange={(event) => setPasted(event.target.value)} />
              <div className="setting-actions">
                <button type="button" className="ghost-button small" onClick={() => inspect(pasted)} disabled={!pasted.trim()}>Read it</button>
                <button type="button" className="ghost-button small" onClick={() => { setPasting(false); setPasted(""); }}>Cancel</button>
              </div>
            </div>
          : <button type="button" className="ghost-button small paste-toggle" onClick={() => setPasting(true)}>
              <Copy size={13} />Paste the file instead
            </button>}

        {problem && <p className="transfer-warn">{problem}</p>}
        {landed && <span className="chip on"><Check size={12} />{landed}</span>}

        {incoming && <>
          <div className="field-label">Boards in that file</div>
          <div className="pick-list">
            {incoming.map((bundle) => {
              const own = tally([bundle]);
              return <PickRow key={bundle.board.id} on={takeIn.has(bundle.board.id)} title={bundle.board.name}
                meta={`${plural(own.columns, "column")} · ${plural(own.notes, "task")}`}
                onPick={() => setTakeIn((current) => {
                  const next = new Set(current);
                  if (!next.delete(bundle.board.id)) next.add(bundle.board.id);
                  return next;
                })} />;
            })}
          </div>

          <p className="transfer-note">
            Everything lands as new boards at the bottom of the sidebar. Nothing already here is touched, and a name
            that is taken comes in as "(imported)".
          </p>

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => { setIncoming(null); setProblem(""); }}>Cancel</button>
            <button type="button" className="primary-button" onClick={land} disabled={!takingIn.length}>
              <Upload size={16} />Import {plural(takingIn.length, "board")}
            </button>
          </div>
        </>}
      </>}
    </div>
  </div>;
}
