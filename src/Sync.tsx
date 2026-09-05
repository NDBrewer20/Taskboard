// Getting a board onto more than one device.
//
// There is no login. A key is the whole of it, and there are two ways to get one onto a
// second device because they suit different devices:
//
//   the key    long lived, kept here, revealed and copied when you want another machine or
//              an agent on it. this is the one worth writing down
//   a code     six digits, five minutes, one use. for the phone, where typing out a key is
//              the reason you would give up. claiming one mints that device its own key
//
// The key is masked until asked for. Nothing here reads it out of the server - it cannot,
// the server only keeps the hash - it is read out of this browser, which is the only place
// it exists.

import { useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, Download, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, Smartphone, Trash2, TriangleAlert } from "lucide-react";
import { copyText, saveFile } from "./transfer";
import type { Device, SyncStatus } from "./server";
import { claimPairing, createKey, describeSync, forgetKey, listDevices, nudge, openPairing, readKey, readServer, revokeDevice, saveKey, saveServer, subscribe } from "./server";

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

const secondsLeft = (until: string) =>
  (until ? Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)) : 0);

// how long a pairing code has left, counted down rather than stated once. only ever used to
// draw the number - whether the code is still good is worked out from the date itself, since
// this starts at zero and an effect does not run until after the first paint
function useCountdown(until: string) {
  const [left, setLeft] = useState(() => secondsLeft(until));

  useEffect(() => {
    if (!until) return;
    setLeft(secondsLeft(until));
    const timer = window.setInterval(() => setLeft(secondsLeft(until)), 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  return left;
}

export default function Sync({ onBack, onPulled }: { onBack: () => void; onPulled: () => Promise<void> | void }) {
  const [key, setKey] = useState(readKey());
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [sync, setSync] = useState<SyncStatus | null>(null);

  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [entering, setEntering] = useState(false);
  const [typed, setTyped] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [you, setYou] = useState("");
  const [server, setServer] = useState(readServer());

  const left = useCountdown(pairing?.expiresAt ?? "");
  // read off the date rather than the countdown, so a code just handed over never draws as
  // expired for the one frame before the timer has had a chance to run
  const paired = Boolean(pairing) && new Date(pairing?.expiresAt ?? 0).getTime() > Date.now();

  // the key never leaves this browser, so what is drawn is what is in localStorage
  const masked = key ? `${key.slice(0, 6)}${"•".repeat(24)}${key.slice(-4)}` : "";

  async function run(what: string, job: () => Promise<void>) {
    setBusy(what);
    setProblem("");
    try { await job(); }
    catch (error) { setProblem(error instanceof Error ? error.message : "That did not work."); }
    finally { setBusy(""); }
  }

  const refreshDevices = async () => {
    const listed = await listDevices();
    setDevices(listed.keys);
    setYou(listed.you);
  };

  useEffect(() => subscribe(setSync), []);

  useEffect(() => {
    if (!key) return;
    refreshDevices().catch(() => { /* said on the next thing that is asked for */ });
  }, [key]);

  return <div className="connect-view">
    <button className="ghost-button" onClick={onBack}><ArrowLeft size={16} />Back to the board</button>

    <Step index={1} done={Boolean(key)} title="Make a key">
      <p>
        A key is the whole of it. Hold one and you get the boards under it - there is no login, no email and
        nothing to reset. It is stored hashed on the server, so it cannot be looked up or sent back to you.
      </p>

      {key ? <>
        <div className="command">
          <code>{shown ? key : masked}</code>
          <button className="ghost-button small" onClick={() => setShown(!shown)}>
            {shown ? <><EyeOff size={13} />Hide</> : <><Eye size={13} />Reveal</>}
          </button>
          <button className="ghost-button small" onClick={async () => {
            setCopied(await copyText(key));
            window.setTimeout(() => setCopied(false), 1600);
          }}>
            {copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}
          </button>
          <button className="ghost-button small" onClick={() => saveFile("taskboard-key.txt", key, "text/plain")}>
            <Download size={13} />Save
          </button>
        </div>
        <p className="faint-note">
          <TriangleAlert size={12} /> Losing every key on an account means losing the boards under it. Save it
          somewhere before you close this - clearing site data on this browser takes the copy that is in it.
        </p>
      </> : <>
        <div className="command">
          <button className="ghost-button small" disabled={Boolean(busy)} onClick={() => run("make", async () => {
            setKey(await createKey());
            await nudge();
          })}>
            <KeyRound size={13} />{busy === "make" ? "Making one…" : "Make a key"}
          </button>
          <button className="ghost-button small" onClick={() => setEntering(!entering)}>
            Already have one
          </button>
        </div>

        {entering && <div className="command">
          <input className="inline-input" placeholder="tb_… or a six digit code" value={typed}
            onChange={(event) => setTyped(event.target.value)} />
          <button className="ghost-button small" disabled={!typed.trim() || Boolean(busy)} onClick={() => run("join", async () => {
            const value = typed.trim();
            // six digits is a pairing code, anything else is a key being pasted in
            if (/^\d{6}$/.test(value)) setKey(await claimPairing(value));
            else { saveKey(value); setKey(value); }
            setTyped("");
            setEntering(false);
            await nudge();
            await onPulled();
          })}>
            {busy === "join" ? "Checking…" : "Use it"}
          </button>
        </div>}
      </>}

      {problem && <Chip state="off">{problem}</Chip>}
    </Step>

    <Step index={2} done={sync?.state === "idle" && Boolean(sync.at)} title="It keeps itself level">
      <p>
        Boards stay here in the browser and this keeps a copy on the server. It runs on its own - an edit settles
        for a moment then goes up, and what your other devices did comes down on a timer and whenever you come
        back to the tab. There is nothing to press.
      </p>

      <Chip state={sync?.state === "idle" ? "on" : sync?.state === "syncing" ? "waiting" : "off"}>
        {sync ? describeSync(sync) : "Waiting"}
      </Chip>

      <div className="command">
        <button className="ghost-button small" disabled={!key || Boolean(busy)} onClick={() => run("sync", async () => {
          await nudge();
          await onPulled();
        })}>
          <RefreshCw size={13} className={sync?.state === "syncing" ? "spin" : ""} />Sync now
        </button>
        <small>Only here for when you do not want to wait for the timer.</small>
      </div>

      <p className="faint-note">
        Whoever edited last wins, compared on when the row changed. A push only ever adds or updates - it cannot
        remove a board the server has and this browser has never heard of. Nothing is applied while you are
        dragging something, so a pull cannot land halfway through a move.
      </p>
    </Step>

    <Step index={3} done={devices.length > 1} title="Add another device">
      <p>
        On a phone, reading out six digits beats typing out a key. The code lasts five minutes, works once, and
        what the other device gets is a key of its own - not this one.
      </p>

      <div className="command">
        <button className="ghost-button small" disabled={!key || Boolean(busy)} onClick={() => run("pair", async () => {
          setPairing(await openPairing());
        })}>
          <Smartphone size={13} />{busy === "pair" ? "Asking…" : "Show a pairing code"}
        </button>
      </div>

      {pairing && (paired
        ? <>
          <div className="command"><code className="pairing-code">{pairing.code}</code></div>
          <Chip state="waiting">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left</Chip>
          <p className="faint-note">
            On the other device open this board, go to Sync, and put those six digits in under
            <strong> Already have one</strong>.
          </p>
        </>
        : <Chip state="off">That code has expired. Ask for another.</Chip>)}

      {devices.length > 0 && <div className="activity">
        {devices.map((device) => <div key={device.id} className="activity-row">
          <span>
            <strong>{device.label}</strong>
            {device.id === you && <em> · this device</em>}
            <small> last seen {device.lastSeen ? new Date(device.lastSeen).toLocaleString() : "never"}</small>
          </span>
          {device.id !== you && devices.length > 1 && <button className="ghost-button small" onClick={() => run("revoke", async () => {
            await revokeDevice(device.id);
            await refreshDevices();
          })}>
            <Trash2 size={13} />Revoke
          </button>}
        </div>)}
      </div>}

      <p className="faint-note">
        Revoking a device only kills its own key. The last one cannot be revoked, since that would strand the
        boards under it with no way back in.
      </p>
    </Step>

    <details className="faint-note">
      <summary>Where the server is</summary>
      <p>
        The board asks <code>{readServer()}</code>, which is the same origin it is served from. In the container
        nginx proxies <code>/api</code> across to the sync service, and in dev vite proxies it the same way, so
        this is right both times and there is nothing to set. It is here for a server somewhere else entirely.
      </p>
      <div className="command">
        <input className="inline-input" value={server} placeholder="/api"
          onChange={(event) => setServer(event.target.value)} />
        <button className="ghost-button small" onClick={() => { saveServer(server); setServer(readServer()); }}>
          Use it
        </button>
      </div>
    </details>

    {key && <button className="danger-button" onClick={() => {
      forgetKey();
      setKey("");
      setDevices([]);
    }}>
      Forget the key on this device
    </button>}
  </div>;
}
