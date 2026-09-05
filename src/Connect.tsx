// The setup walkthrough. Three steps, each one showing whether it has actually happened
// rather than just telling you what to type, so you can see it come together.

import { useState } from "react";
import { ArrowLeft, Bot, Check, Copy, Download, LoaderCircle, MonitorCheck, PlugZap, Terminal } from "lucide-react";
import type { BridgeHealth, OpResult } from "./bridge";
import type { AwakeState } from "./awake";
import { browserGuide } from "./browser";
import { copyText, saveFile } from "./transfer";
// the connector, verbatim, so the board can hand you a copy. it is one file with no
// imports and no dependencies for exactly this reason
import connectorSource from "../bridge/mcp.mjs?raw";

const FILE = "taskboard-connector.mjs";

// hands over the connector as a file, the same way a board export goes out
const saveConnector = () => saveFile(FILE, connectorSource, "text/javascript");

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

// one switch, told the way it reads on the page
function Toggle({ on, title, blurb, onToggle }: { on: boolean; title: string; blurb: string; onToggle: () => void }) {
  return <button className={`setting-row ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={onToggle}>
    <span className="setting-what"><strong>{title}</strong><small>{blurb}</small></span>
    <span className="switch"><span /></span>
  </button>;
}

export default function Connect({ bridge, log, access, onAccess, awake, tabAwake, screenAwake, onTabAwake, onScreenAwake, board, column, onBack }: {
  bridge: BridgeHealth | null;
  log: OpResult[];
  access: boolean;
  onAccess: () => void;
  awake: AwakeState;
  tabAwake: boolean;
  screenAwake: boolean;
  onTabAwake: () => void;
  onScreenAwake: () => void;
  board?: string;
  column?: string;
  onBack: () => void;
}) {
  const up = Boolean(bridge?.ok);
  // the mcp server says hello when an agent starts it, so this is real rather than assumed
  const agentSeen = Boolean(bridge?.mcp);
  const connected = Boolean(bridge?.listening) && access;

  // both follow agent access, so a switch being on is not the whole story. and the tab one
  // can be on and still not running, since nothing plays until you have clicked something
  const waitingOnAccess = { state: "waiting" as const, text: "On, but nothing to keep awake until agent access is" };

  const tabChip = !tabAwake ? null
    : !access ? waitingOnAccess
    : awake.tab === "awake" ? { state: "on" as const, text: "The tab is being kept awake" }
    : awake.tab === "waiting" ? { state: "waiting" as const, text: "Click anywhere on the board to start it off" }
    : { state: "off" as const, text: "The browser would not let it start" };

  const screenChip = !screenAwake ? null
    : !("wakeLock" in navigator) ? { state: "off" as const, text: "Not available over plain http, open the board on https or localhost" }
    : !access ? waitingOnAccess
    : awake.screen ? { state: "on" as const, text: "The screen is being kept awake" }
    : { state: "waiting" as const, text: "Held only while this is the tab you are looking at" };

  // what this browser calls putting a tab to sleep, and where it keeps the way out of it
  const guide = browserGuide();

  // the real path, not a shortcut. the connector is run as node directly rather than through
  // a shell, so %USERPROFILE% or ~ would be handed over as literal text and node would give up
  const windows = navigator.userAgent.includes("Win");
  const saved = windows ? `C:/Users/you/Downloads/${FILE}` : `/home/you/Downloads/${FILE}`;
  const addCommand = `claude mcp add taskboard -- node "${saved}"`;
  const mcpJson = `{ "mcpServers": { "taskboard": { "command": "node", "args": ["${saved}"] } } }`;

  return <div className="connect-view">
    <div className="connect-intro">
      <div className="connect-mark"><PlugZap size={20} /></div>
      <div>
        <strong>Let an agent keep this board up to date</strong>
        <p>
          Two steps, nothing to install by hand. When it is done you can say <em>"add a task
          to {column ?? "the column"}"</em> or <em>"tick off the login task"</em> and it happens here. The board never
          leaves this browser, and the connection only runs on your own machine.
        </p>
      </div>
      <button className="ghost-button" onClick={onBack}><ArrowLeft size={16} />Back to the board</button>
    </div>

    <Step index={1} done={agentSeen} title="Give your agent the tools">
      <p>
        The connector is one file with nothing around it and nothing to install. It is a plain MCP server, so
        anything that speaks MCP can drive the board. Save it, then point your agent at it.
      </p>
      <button className="primary-button save-connector" onClick={saveConnector}><Download size={15} />Save the connector</button>

      <p className="faint-note">
        If your agent can run commands, this is the whole job. It knows where your Downloads are, so it can work
        out the path and wire it up itself:
      </p>
      <Command text={`Add the ${FILE} I just saved in my Downloads as an mcp server called taskboard`} />

      <p className="faint-note">
        Otherwise add it by hand, with the file's real path. Most MCP clients take the same block, in their own
        config or in a project <code>.mcp.json</code>:
      </p>
      <Command text={mcpJson} />

      <p className="faint-note">
        <Terminal size={12} /> Claude Code has a one liner for it. Drag the file into the terminal to paste its
        path. A shortcut like <code>~</code> or <code>%USERPROFILE%</code> will not do, node is run straight rather
        than through a shell, so it would be handed over as literal text.
      </p>
      <Command text={addCommand} />

      {agentSeen
        ? <Chip state="on">An agent is connected</Chip>
        : up
          ? <Chip state="waiting">Connector found, but no agent has used it yet</Chip>
          : <Chip state="waiting">Waiting for an agent</Chip>}
      {!agentSeen && <p className="faint-note">
        Tools are picked up when a session starts, so start a new one afterwards. There is no need to restart your
        editor. If it is a project <code>.mcp.json</code>, most agents ask you to approve it first.
      </p>}
      {up && !agentSeen && <p className="faint-note">
        The agent has to be running on this computer, since the connector lives inside it and the board reaches it
        on loopback.
      </p>}
      {up && !bridge?.waits && <p className="faint-note">
        <Terminal size={12} /> The connector answering is an older copy of the file. Save it again and start a new
        agent session to get the held poll - that is what keeps this board answering while it sits behind a pile of
        other tabs, instead of the agent timing out waiting on it.
      </p>}
    </Step>

    <Step index={2} done={connected} title="Let this board listen">
      <p>The board checks for work every couple of seconds while this is on. Turn it off any time.</p>
      <Toggle on={access} onToggle={onAccess} title="Agent access"
        blurb={board ? `Changes land on "${board}", the board you have open.` : "Open a board first."} />
      {connected
        ? <Chip state="on">Connected</Chip>
        : access ? <Chip state="waiting">Waiting for an agent</Chip> : <Chip state="off">Switched off</Chip>}

      <p className="faint-note">
        <MonitorCheck size={12} /> Two different things get in the way of leaving this running unattended: the
        browser putting the tab to sleep, and the machine putting the display to sleep. One switch each.
      </p>
      <Toggle on={tabAwake} onToggle={onTabAwake} title="Keep this tab awake"
        blurb={"Plays a loop too quiet to hear. No browser throttles, freezes or closes down a tab that is playing "
          + "something, and unlike the screen lock it carries on while you are looking elsewhere. The tab shows the "
          + "speaker icon while it runs."} />
      {tabChip && <Chip state={tabChip.state}>{tabChip.text}</Chip>}

      <Toggle on={screenAwake} onToggle={onScreenAwake} title="Keep the screen awake"
        blurb={"Stops the display sleeping and taking the machine with it. Only counts while this is the tab you "
          + "are looking at, and it needs https or localhost, so it is the one that does nothing on a self hosted "
          + "board over plain http."} />
      {screenChip && <Chip state={screenChip.state}>{screenChip.text}</Chip>}
    </Step>

    <Step index={3} done={log.length > 0} title="Try it">
      <p>Ask your agent for something and watch it turn up here.</p>
      <Command text={`Add a task called "Try me" to ${column ?? "my first column"}`} note="Say this to the agent, do not run it in a terminal." />

      <div className="activity">
        {log.length
          ? log.slice(0, 6).map((entry) => <div key={entry.id} className={`activity-row ${entry.ok ? "" : "bad"}`}>
              {entry.ok ? <Check size={13} /> : <Bot size={13} />}<span>{entry.message}</span>
            </div>)
          : <div className="activity-row empty"><Bot size={13} /><span>Nothing yet. Anything an agent does to the board shows up here.</span></div>}
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
        The connector runs inside the agent itself, on <code>127.0.0.1:4319</code>, and only while a session is
        open. Nothing is written to disk, nothing leaves this machine, and the board still lives entirely in this
        browser. Both halves have to be on the same computer.
      </p>

      <div className="field-label">While you are looking elsewhere</div>
      <p>
        A tab you are not looking at has its timers cut to about one a minute, which is why an agent used to time
        out on a board buried in a pile of tabs. So the board stops using one: while it is in the background it
        holds a poll open at the connector instead, and work comes back down it the moment the agent queues any.
        Clicking back to the tab cuts that short and catches up on the spot.
      </p>
      <p>
        The one thing that still stops it is the browser closing the tab down to save memory. <em>Give the board its
        own window</em> and that never comes up: the tab on top of its own window counts as the one you are looking
        at even when the window is behind everything else, so nothing throttles it, nothing discards it, and the
        screen lock keeps working.
      </p>

      <div className="field-label">Or leave it among your tabs, in {guide.name}</div>
      {guide.settings && <Command text={guide.settings} note="Paste it in the address bar. A settings page will not open from a link." />}
      {guide.steps.length > 0 && <ol className="guide-steps">
        {guide.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>}
      {guide.perSite && <p className="faint-note">The site to add is <code>{location.host || "this site"}</code>.</p>}
      {guide.note && <p className="faint-note">{guide.note}</p>}
      <p className="faint-note">
        If that is not the browser you are in, the same setting is somewhere in its settings under sleeping,
        discarding or memory.
      </p>
    </div>
  </div>;
}
