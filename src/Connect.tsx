// The setup walkthrough. Three steps, each one showing whether it has actually happened
// rather than just telling you what to type, so you can see it come together.

import { useState } from "react";
import { ArrowLeft, Bot, Check, Copy, Download, LoaderCircle, PlugZap, Terminal } from "lucide-react";
import type { BridgeHealth, OpResult } from "./bridge";
// the connector, verbatim, so the board can hand you a copy. it is one file with no
// imports and no dependencies for exactly this reason
import connectorSource from "../bridge/mcp.mjs?raw";

const FILE = "taskboard-connector.mjs";

// hands over the connector as a file. blobs are fine over plain http, unlike the clipboard
function saveConnector() {
  const url = URL.createObjectURL(new Blob([connectorSource], { type: "text/javascript" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = FILE;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// clipboard writes need a secure context, and this gets self hosted over plain http, so
// fall back to the old execCommand trick rather than have the button quietly do nothing
async function copyText(text: string) {
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

function Command({ text, note }: { text: string; note?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    setCopied(await copyText(text));
    window.setTimeout(() => setCopied(false), 1600);
  }

  return <div className="command">
    <code>{text}</code>
    <button className="ghost-button small" onClick={copy}>
      {copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}
    </button>
    {note && <small>{note}</small>}
  </div>;
}

// done, waiting, or something to fix
function Chip({ state, children }: { state: "on" | "waiting" | "off"; children: React.ReactNode }) {
  return <span className={`chip ${state}`}>
    {state === "on" ? <Check size={12} /> : state === "waiting" ? <LoaderCircle size={12} className="spin" /> : null}
    {children}
  </span>;
}

function Step({ index, done, title, children }: {
  index: number; done: boolean; title: string; children: React.ReactNode;
}) {
  return <section className={`step ${done ? "done" : ""}`}>
    <div className="step-mark">{done ? <Check size={14} /> : index}</div>
    <div className="step-body">
      <h3>{title}</h3>
      {children}
    </div>
  </section>;
}

export default function Connect({ bridge, log, access, onAccess, board, column, onBack }: {
  bridge: BridgeHealth | null;
  log: OpResult[];
  access: boolean;
  onAccess: () => void;
  board?: string;
  column?: string;
  onBack: () => void;
}) {
  const up = Boolean(bridge?.ok);
  // the mcp server says hello when claude starts it, so this is real rather than assumed
  const claudeSeen = Boolean(bridge?.mcp);
  const connected = Boolean(bridge?.listening) && access;

  // the real path, not a shortcut. Claude Code runs node directly rather than through a
  // shell, so %USERPROFILE% or ~ would be handed over as literal text and node would give up
  const windows = navigator.userAgent.includes("Win");
  const saved = windows ? `C:/Users/you/Downloads/${FILE}` : `/home/you/Downloads/${FILE}`;
  const addCommand = `claude mcp add taskboard -- node "${saved}"`;
  const mcpJson = `{ "mcpServers": { "taskboard": { "command": "node", "args": ["${saved}"] } } }`;


  return <div className="connect-view">
    <div className="connect-intro">
      <div className="connect-mark"><PlugZap size={20} /></div>
      <div>
        <strong>Let Claude Code keep this board up to date</strong>
        <p>
          Two steps, nothing to install by hand. When it is done you can say <em>"add a task
          to {column ?? "the column"}"</em> or <em>"tick off the login task"</em> and it happens here. The board never
          leaves this browser, and the connection only runs on your own machine.
        </p>
      </div>
      <button className="ghost-button" onClick={onBack}><ArrowLeft size={16} />Back to the board</button>
    </div>

    <Step index={1} done={claudeSeen} title="Give Claude the tools">
      <p>
        The connector is one file with nothing around it and nothing to install. Save it, then tell Claude Code
        where it went.
      </p>
      <button className="primary-button save-connector" onClick={saveConnector}><Download size={15} />Save the connector</button>

      <p className="faint-note">Then say this to Claude Code. It knows where your Downloads are, so it can do the rest:</p>
      <Command text={`Add the ${FILE} I just saved in my Downloads as an mcp server called taskboard`} />

      <p className="faint-note">
        <Terminal size={12} /> Or do it yourself, with the file's real path. Drag the file into the terminal to
        paste it. A shortcut like <code>~</code> or <code>%USERPROFILE%</code> will not do, Claude Code runs node
        straight rather than through a shell, so it would be handed over as literal text.
      </p>
      <Command text={addCommand} />
      <p className="faint-note">
        No terminal? Put the same thing in <code>.mcp.json</code> where you work, then approve it when Claude asks.
      </p>
      <Command text={mcpJson} />

      {claudeSeen
        ? <Chip state="on">Claude is connected</Chip>
        : up
          ? <Chip state="waiting">Connector found, but Claude has not used it yet</Chip>
          : <Chip state="waiting">Waiting for a Claude Code session</Chip>}
      {!claudeSeen && <p className="faint-note">
        Tools are picked up when a session starts, so start a new one afterwards. There is no need to restart your
        editor. If it is a project <code>.mcp.json</code>, Claude asks you to approve it first.
      </p>}
      {up && !claudeSeen && <p className="faint-note">
        Claude Code has to be running on this computer, since the connector lives inside it and the board reaches
        it on loopback.
      </p>}
    </Step>

    <Step index={2} done={connected} title="Let this board listen">
      <p>The board checks for work every couple of seconds while this is on. Turn it off any time.</p>
      <button className={`setting-row ${access ? "on" : ""}`} role="switch" aria-checked={access} onClick={onAccess}>
        <span className="setting-what">
          <strong>Claude access</strong>
          <small>{board ? `Changes land on "${board}", the board you have open.` : "Open a board first."}</small>
        </span>
        <span className="switch"><span /></span>
      </button>
      {connected
        ? <Chip state="on">Connected</Chip>
        : access ? <Chip state="waiting">Waiting for Claude Code</Chip> : <Chip state="off">Switched off</Chip>}
    </Step>

    <Step index={3} done={log.length > 0} title="Try it">
      <p>Ask Claude Code for something and watch it turn up here.</p>
      <Command text={`Add a task called "Try me" to ${column ?? "my first column"}`} note="Say this to Claude, do not run it in a terminal." />

      <div className="activity">
        {log.length
          ? log.slice(0, 6).map((entry) => <div key={entry.id} className={`activity-row ${entry.ok ? "" : "bad"}`}>
              {entry.ok ? <Check size={13} /> : <Bot size={13} />}<span>{entry.message}</span>
            </div>)
          : <div className="activity-row empty"><Bot size={13} /><span>Nothing yet. Anything Claude does to the board shows up here.</span></div>}
      </div>
    </Step>

    <div className="connect-more">
      <div className="field-label">What it can do</div>
      <p>
        Read the whole board, add boards, columns and tasks, add checklist steps under other steps, tick things off,
        and archive a task. It works by name, so "the login task" is enough, and it says so rather than guessing if
        two tasks match.
      </p>

      <div className="field-label">Where it runs</div>
      <p>
        The connector runs inside Claude Code itself, on <code>127.0.0.1:4319</code>, and only while a session is
        open. Nothing is written to disk, nothing leaves this machine, and the board still lives entirely in this
        browser. Both halves have to be on the same computer.
      </p>
    </div>
  </div>;
}
