// The setup walkthrough. Three steps, each one showing whether it has actually happened
// rather than just telling you what to type, so you can see it come together.

import { useState } from "react";
import { ArrowLeft, Bot, Check, Copy, LoaderCircle, PlugZap, Terminal } from "lucide-react";
import type { BridgeHealth, OpResult } from "./bridge";

// where the plugin comes from. Claude Code fetches it itself, so nobody needs the folder
const REPO = "NDBrewer20/Taskboard";

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

    <Step index={1} done={claudeSeen} title="Add the plugin to Claude Code">
      <p>Paste these into Claude Code, one after the other. It fetches everything itself, there is nothing to download or run.</p>
      <Command text={`/plugin marketplace add ${REPO}`} />
      <Command text="/plugin install taskboard@taskboard" note="Then restart Claude Code so it picks the tools up." />
      {claudeSeen
        ? <Chip state="on">Claude is connected</Chip>
        : up
          ? <Chip state="waiting">Connector found, but Claude has not used it yet</Chip>
          : <Chip state="waiting">Waiting for a Claude Code session</Chip>}
      {up && !claudeSeen && <p className="faint-note">
        If Claude Code is running on a different computer to this browser, see the note at the bottom.
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

      <div className="field-label">Different computers?</div>
      <p>
        The connector runs inside Claude Code itself, on whatever machine Claude Code is on. Normally that is this
        machine and there is nothing more to do. If you are reading the board on one computer and running Claude on
        another, the browser cannot see the connector, so run one where the board is open and point Claude at it:
      </p>
      <Command text="node bridge/server.mjs" note="On the machine with the board open, from a copy of the repo." />
      <Command text="TASKBOARD_BRIDGE=http://that-machine:4319" note="Set this for Claude Code, so its tools use that one instead of their own." />
      <p className="faint-note">
        <Terminal size={12} /> There is a plain command line version as well, handy for a hook:
        <code> taskboard status</code>, <code>taskboard done "the login task"</code>. It sits beside the tools in the
        plugin.
      </p>
    </div>
  </div>;
}
