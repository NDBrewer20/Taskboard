// The board's half of server storage.
//
// Local first, still. The board is read from and written to IndexedDB exactly as it always
// was, and this pushes a copy up and pulls other devices' copies down. Nothing here is on a
// timer yet - it runs when asked. Pull first then push, so what comes down is merged before
// what goes up is worked out.
//
// The wire format is the export file. gather() in transfer.ts builds the tree that the
// sidebar writes to disk, and that is exactly what is sent, so there is one definition of
// what a board is and no converter to keep in step.

import { database, updateNote } from "./db";
import { gather } from "./transfer";
import type { BoardBundle } from "./transfer";
import type { Board, Category, Deletion, Note } from "./types";

const KEY_AT = "taskboard:key";
const SERVER_AT = "taskboard:server";

// same origin by default, because nginx proxies /api to the sync container and that saves
// a second hostname, a cors preflight on every write and a whole class of mixed content
// trouble. dev runs vite on one port and the api on another, so it can be pointed elsewhere
export const DEFAULT_SERVER = "/api";

const local = {
  get: (name: string) => { try { return localStorage.getItem(name) ?? ""; } catch { return ""; } },
  set: (name: string, value: string) => { try { localStorage.setItem(name, value); } catch { /* private mode */ } },
  drop: (name: string) => { try { localStorage.removeItem(name); } catch { /* private mode */ } },
};

export const readKey = () => local.get(KEY_AT);
export const saveKey = (key: string) => local.set(KEY_AT, key.trim());
export const forgetKey = () => local.drop(KEY_AT);
export const hasKey = () => Boolean(readKey());

export const readServer = () => local.get(SERVER_AT) || DEFAULT_SERVER;
export const saveServer = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === DEFAULT_SERVER) local.drop(SERVER_AT);
  else local.set(SERVER_AT, trimmed);
};

// a key is only ever shown by the device holding it. the server keeps the hash, so it could
// not hand one back even if something asked it to
export const revealKey = () => readKey();

export type Device = { id: string; label: string; createdAt: string; lastSeen: string | null };
export type SyncCounts = { pulled: number; pushed: number; removed: number };

class SyncError extends Error {}

// what went wrong, said in terms of what it means. the api puts a message in the body and
// that is used whenever there is one, but a proxy with nothing behind it answers in plain
// text with no body at all - and "the server said 502" says nothing about what happened.
//
// nothing in here tells anyone to run a command. whoever is reading it is looking at a
// board someone else hosts, and has no terminal to go and fix it in
function complaint(status: number, body: Record<string, unknown>) {
  if (typeof body.message === "string") return body.message;

  if (status === 502 || status === 503 || status === 504) {
    return "The sync server is not answering. It may be down or still starting up.";
  }
  if (status === 401 || status === 403) return "This device's key is not being accepted. It may have been revoked.";
  if (status === 404) return `Nothing is listening at ${readServer()}.`;
  if (status === 429) return "Too many tries at once. Give it a minute.";
  return `The server said ${status}.`;
}

async function call<Row>(path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<Row> {
  const key = options.key ?? readKey();
  let response: Response;

  try {
    response = await fetch(`${readServer()}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "x-taskboard-key": key } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new SyncError(`Cannot reach the sync server at ${readServer()}.`);
  }

  let body: Record<string, unknown> = {};
  try { body = await response.json(); } catch { /* a proxy error page is not json */ }

  if (!response.ok) throw new SyncError(complaint(response.status, body));
  return body as Row;
}

/* ---------- keys and devices ---------- */

export async function createKey(label = "this device") {
  const made = await call<{ key: string }>("/keys", { method: "POST", body: { label }, key: "" });
  saveKey(made.key);
  return made.key;
}

// device one vouching for device two. the code is read out loud, not the key
export const openPairing = () => call<{ code: string; expiresAt: string }>("/pairings", { method: "POST" });

// device two. no key on this one, that is the point - what comes back is a new key of its own
export async function claimPairing(code: string, label = "this device") {
  const claimed = await call<{ key: string }>("/pairings/claim", {
    method: "POST", body: { code: code.trim(), label }, key: "",
  });
  saveKey(claimed.key);
  return claimed.key;
}

export const listDevices = () => call<{ keys: Device[]; you: string }>("/keys");
export const revokeDevice = (id: string) => call<{ ok: boolean }>(`/keys/${id}`, { method: "DELETE" });
export const serverHealth = () => call<{ ok: boolean; pairing?: boolean }>("/health", { key: "" });

/* ---------- pulling ----------

   Same rules as the server applies on the way up, pointed the other way: whoever wrote last
   wins, a row deleted here does not come back because the server still has a copy, and a
   delete does not take a row edited after it. */

// dexie types an update by walking every key path on the row, and a checklist that can hold
// checklists sends that walk in circles. note writes go through a loose view, same as db.ts
const noteWrites = database.notes as unknown as {
  get(id: string): Promise<Note | undefined>;
  put(row: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<void>;
};

const older = (incoming: string, existing?: string) => Boolean(existing) && String(incoming) <= String(existing);

async function applyBoards(bundles: BoardBundle[]) {
  let pulled = 0;

  const land = async (
    id: string, changedAt: string,
    held: () => Promise<{ updatedAt: string } | undefined>,
    put: () => Promise<unknown>,
  ) => {
    // something deleted here after that edit was made stays deleted
    const grave = await database.deletions.get(id);
    if (grave && String(grave.deletedAt) >= String(changedAt)) return;
    if (older(changedAt, (await held())?.updatedAt)) return;
    await put();
    pulled += 1;
  };

  for (const bundle of bundles) {
    const board = bundle.board;
    await land(board.id, board.updatedAt,
      () => database.boards.get(board.id),
      () => database.boards.put(board));

    for (const entry of bundle.columns) {
      const column = entry.column;
      await land(column.id, column.updatedAt,
        () => database.categories.get(column.id),
        () => database.categories.put(column));

      for (const note of entry.notes) {
        await land(note.id, note.updatedAt,
          () => noteWrites.get(note.id),
          () => noteWrites.put(note as unknown as Record<string, unknown>));
      }
    }
  }

  return pulled;
}

// a tombstone from the server, applied here. the row is taken unless it has been edited
// since it was deleted, in which case the edit wins and goes back up on the next push
async function applyDeletions(graves: Deletion[]) {
  let removed = 0;

  for (const grave of graves) {
    const held = grave.kind === "board" ? await database.boards.get(grave.id)
      : grave.kind === "category" ? await database.categories.get(grave.id)
        : await noteWrites.get(grave.id);

    if (held && String(held.updatedAt) > String(grave.deletedAt)) continue;

    if (held) {
      if (grave.kind === "board") await database.boards.delete(grave.id);
      else if (grave.kind === "category") await database.categories.delete(grave.id);
      else await noteWrites.delete(grave.id);
      removed += 1;
    }

    // kept either way, so this device does not push the row back up as something new
    await database.deletions.put(grave);
  }

  return removed;
}

export async function pull() {
  const answer = await call<{ boards: BoardBundle[]; deletions: Deletion[] }>("/boards");

  // deletions first. landing the writes first would only have them taken straight back out
  const removed = await applyDeletions(answer.deletions ?? []);
  const pulled = await applyBoards(answer.boards ?? []);
  return { pulled, removed };
}

/* ---------- pushing ---------- */

// everything, archived included - archiving is a stamp on a row that is still there, so it
// has to travel like any other edit or the other device never hears about it
export async function push() {
  const [boards, categories, notes, deletions] = await Promise.all([
    database.boards.toArray(),
    database.categories.toArray(),
    database.notes.toArray(),
    database.deletions.toArray(),
  ]);

  const bundles = gather(
    boards as Board[], categories as Category[], notes as Note[],
    new Set(boards.map((board) => board.id)), true,
  );

  const done = await call<{ added: number; updated: number }>("/boards", {
    method: "PUT",
    body: { app: "taskboard", version: 2, exportedAt: new Date().toISOString(), boards: bundles, deletions },
  });

  return { pushed: (done.added ?? 0) + (done.updated ?? 0) };
}

// pull then push, so what comes down is merged before what goes up is worked out
export async function syncNow(): Promise<SyncCounts> {
  const down = await pull();
  const up = await push();
  return { ...down, ...up };
}

/* ---------- keeping every device on the same boards ----------

   Nobody should have to press a button to see what they typed on the other machine, so this
   is the part that runs on its own:

     an edit here      settles for a moment, then goes up. a push is the whole tree rather
                       than a delta, so a missed nudge only ever delays it, never loses it
     every so often    a pull, to pick up what the other devices did
     coming back       a pull on focus and on the tab becoming visible, because a background
                       tab has its timers cut right back and will be behind
     coming online     a sync, which is what drains anything queued while offline

   Every write to the three tables is watched through dexie's hooks rather than by having
   each caller remember to say so - the bridge writes the same tables an agent does, and a
   new one added later would be missed otherwise. */

export type SyncState = "off" | "idle" | "syncing" | "offline" | "error";
export type SyncStatus = { state: SyncState; at: string; message: string; pending: boolean };

const QUIET = 2500;
const EVERY = 15000;
const BACKOFF_MAX = 5 * 60 * 1000;

let status: SyncStatus = { state: hasKey() ? "idle" : "off", at: "", message: "", pending: false };
const watchers = new Set<(status: SyncStatus) => void>();

// what the app is told to do once something has actually landed
let onChanged: () => void = () => {};

let dirty = false;
let applying = false;   // a pull is writing, so those writes are not "someone edited"
let held = false;       // a drag is in flight, so nothing is pulled out from under it
let running: Promise<void> | null = null;
let backoff = 0;
let quietTimer = 0;
let everyTimer = 0;
let watching = false;

function tell(next: Partial<SyncStatus>) {
  status = { ...status, ...next };
  for (const watcher of watchers) watcher(status);
}

export function subscribe(watcher: (status: SyncStatus) => void) {
  watchers.add(watcher);
  watcher(status);
  return () => { watchers.delete(watcher); };
}

export const syncStatus = () => status;

// a drag renumbers a whole column, and a pull landing halfway through it would be applying
// rows to positions that are still moving. the board says when it is busy
export function holdSync(busy: boolean) {
  held = busy;
  if (!busy && dirty) schedulePush();
}

function schedulePush() {
  window.clearTimeout(quietTimer);
  quietTimer = window.setTimeout(() => { void cycle(true); }, QUIET);
  // hooks fire per row and inside the transaction, so an import of a hundred notes would
  // otherwise put a hundred renders through the app to say the same thing
  if (!status.pending) tell({ pending: true });
}

function noteEdit() {
  if (applying) return;
  dirty = true;
  schedulePush();
}

async function cycle(wantPush: boolean) {
  if (!hasKey()) return tell({ state: "off", pending: false });
  if (held) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return tell({ state: "offline", pending: dirty });
  }
  if (running) return running;

  running = (async () => {
    tell({ state: "syncing" });
    try {
      applying = true;
      const down = await pull();
      applying = false;

      // cleared before the push reads anything, so an edit made while it is in flight sets
      // it again and goes up on the next one rather than being swallowed
      const sending = wantPush || dirty;
      dirty = false;
      if (sending) await push();

      backoff = 0;
      tell({ state: "idle", at: new Date().toISOString(), message: "", pending: false });
      if (down.pulled || down.removed) onChanged();
    } catch (error) {
      applying = false;
      dirty = dirty || wantPush;
      backoff = Math.min(backoff ? backoff * 2 : EVERY, BACKOFF_MAX);
      tell({
        state: "error", pending: dirty,
        message: error instanceof Error ? error.message : "Sync did not work.",
      });
      window.setTimeout(() => { void cycle(dirty); }, backoff);
    } finally {
      running = null;
    }
  })();

  return running;
}

// the panel's button, and what runs the moment a key is put in
export const nudge = () => cycle(true);

export function startSync(changed: () => void) {
  onChanged = changed;

  if (!watching) {
    watching = true;
    // returning anything from creating or updating means something to dexie - a new primary
    // key, or more changes to apply - so these have to hand back undefined and nothing else
    try {
      for (const table of [database.boards, database.categories, database.notes, database.deletions]) {
        const watched = table as unknown as { hook(name: string, run: () => void): void };
        watched.hook("creating", noteEdit);
        watched.hook("updating", noteEdit);
        watched.hook("deleting", noteEdit);
      }
    } catch {
      // no board is worth a white screen. without hooks an edit still goes up, it just
      // waits for the timer rather than going a couple of seconds after you stop typing
      watching = false;
    }
  }

  const catchUp = () => { if (document.visibilityState === "visible") void cycle(dirty); };
  const online = () => { void cycle(true); };

  window.addEventListener("focus", catchUp);
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", catchUp);

  // a hidden tab has this cut to about once a minute, which is why focus is listened for
  everyTimer = window.setInterval(catchUp, EVERY);
  void cycle(false);

  return () => {
    window.clearInterval(everyTimer);
    window.clearTimeout(quietTimer);
    window.removeEventListener("focus", catchUp);
    window.removeEventListener("online", online);
    document.removeEventListener("visibilitychange", catchUp);
    onChanged = () => {};
  };
}

// how long ago, said the way you would say it rather than as a timestamp
export function describeSync(state: SyncStatus) {
  if (state.state === "off") return "Stored on this device";
  if (state.state === "syncing") return "Syncing…";
  if (state.state === "offline") return "Offline, will catch up";
  if (state.state === "error") return state.message || "Sync did not work";
  if (state.pending) return "Saving…";
  if (!state.at) return "Synced";

  const seconds = Math.round((Date.now() - new Date(state.at).getTime()) / 1000);
  if (seconds < 45) return "Synced just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes} min ago`;
  return `Synced ${new Date(state.at).toLocaleTimeString()}`;
}
