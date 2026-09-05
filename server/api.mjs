// The sync api. Keys in, board trees out.
//
// There is no login here and nothing to reset. A key is the whole of it: hold one and you
// get the boards under it. It is stored hashed, so it cannot be looked up, mailed to you or
// handed back - not even by this. Lose every key on an account and there is nobody to ask.
//
// Two ways onto a second device, because they are for different devices:
//
//   the key    long lived, kept by the device, revealed and copied when you want another
//              machine or an agent on it. this is the one you write down
//   a code     six digits, five minutes, one use. for the phone, where typing out a key is
//              the reason you gave up. claiming one mints a new key on the same account
//
// What GET /api/boards answers with is a Taskboard export file, exactly as the sidebar
// writes one, and what PUT /api/boards takes is the same. So a curl of this endpoint saved
// to disk imports back into the app, and a file exported months ago pushes up here without
// a converter in between. That is the whole reason the schema mirrors the browser's.

import { createServer } from "node:http";
import { hashKey, openStore, PAIRING_TRIES } from "./store.mjs";

const PORT = Number(process.env.TASKBOARD_PORT ?? 4320);
const STORE = process.env.TASKBOARD_STORE ?? "./data/taskboard.db";

// the same wrapper transfer.ts writes, so what comes back off here is an importable file
const FILE_VERSION = 2;

// a body has to fit in memory to be parsed at all, so it is capped rather than trusted.
// a big board is tens of kb, so four megabytes is already far past anything real
const MAX_BODY = 4 * 1024 * 1024;

const store = openStore(STORE);

const send = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // a key is a bearer token, so nothing holding one should be cached on the way past
    "cache-control": "no-store",
    // the board is served from somewhere else entirely when it is not behind the proxy
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-taskboard-key",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
  });
  response.end(text);
};

function body(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("That is too big to be a board."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("That body is not JSON.")); }
    });
    request.on("error", reject);
  });
}

/* ---------- guessing at codes ----------

   Six digits is a million, and a code only lives five minutes, but neither of those means
   much if something can sit there trying thousands a second. The code itself burns out
   after five wrong guesses. This is the other half: a cap on how fast any one caller can
   guess at all, so the whole space cannot be swept by rotating through codes.

   In memory on purpose. It is a single process, restarting it is a deploy rather than
   something an attacker can ask for, and a table would be writes on the hot path. */

const attempts = new Map();
const CLAIM_WINDOW = 60 * 1000;
const CLAIM_TRIES = 10;

function tooMany(who) {
  const now = Date.now();
  const seen = attempts.get(who);

  if (!seen || seen.until < now) {
    attempts.set(who, { count: 1, until: now + CLAIM_WINDOW });
    return false;
  }

  seen.count += 1;
  return seen.count > CLAIM_TRIES;
}

// the map only ever grows otherwise, and it is keyed by whatever address turned up
setInterval(() => {
  const now = Date.now();
  for (const [who, seen] of attempts) if (seen.until < now) attempts.delete(who);
}, CLAIM_WINDOW).unref();

const caller = (request) => request.socket.remoteAddress ?? "somewhere";

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method ?? "GET";

  if (method === "OPTIONS") return send(response, 204, {});

  if (path === "/health") {
    return send(response, 200, { ok: true, service: "taskboard-sync", version: FILE_VERSION, pairing: true });
  }

  /* ---------- the two routes with no key on them ---------- */

  // where an account comes from. the key is handed back here and nowhere else ever again
  if (path === "/keys" && method === "POST") {
    let payload = {};
    try { payload = await body(request); } catch { /* a label is optional */ }

    const { key } = store.createAccount(typeof payload.label === "string" ? payload.label : "first device");
    return send(response, 201, {
      ok: true, key,
      note: "Keep this somewhere safe. It is stored hashed, so it cannot be looked up or reset.",
    });
  }

  // the far end of pairing. no key on the request, which is the whole point of it, so this
  // is the one route that is rate limited by caller as well as by code
  if (path === "/pairings/claim" && method === "POST") {
    if (tooMany(caller(request))) {
      return send(response, 429, { ok: false, message: "Too many tries. Wait a minute and start again." });
    }

    let payload;
    try { payload = await body(request); }
    catch (error) { return send(response, 400, { ok: false, message: error.message }); }

    const claimed = store.claimPairing(payload?.code, typeof payload?.label === "string" ? payload.label : "paired device");
    if (!claimed.ok) {
      // a wrong guess is counted against the code, so one being worked through dies early
      store.missPairing(payload?.code);
      return send(response, 400, { ok: false, message: claimed.message, triesPerCode: PAIRING_TRIES });
    }

    return send(response, 201, {
      ok: true, key: claimed.key,
      note: "This device has its own key now. Revoking it will not touch the others.",
    });
  }

  /* ---------- everything below needs one ---------- */

  const key = request.headers["x-taskboard-key"];
  if (!key) return send(response, 401, { ok: false, message: "No key on that request." });

  const keyHash = hashKey(key);
  const accountId = store.accountFor(keyHash);
  if (!accountId) return send(response, 403, { ok: false, message: "That key is not one of ours." });
  store.touch(keyHash);

  // what is on this account, so a device can be seen and thrown off. the key itself is not
  // in here and cannot be - only its short id, which is enough to revoke and no use to sign in
  if (path === "/keys" && method === "GET") {
    return send(response, 200, { ok: true, keys: store.keys(accountId), you: keyHash.slice(0, 12) });
  }

  if (path.startsWith("/keys/") && method === "DELETE") {
    const keyId = path.slice("/keys/".length);
    const gone = store.revokeKey(accountId, keyId);
    return send(response, gone.ok ? 200 : 400, gone);
  }

  // device one vouching for device two
  if (path === "/pairings" && method === "POST") {
    const pairing = store.openPairing(accountId);
    return send(response, 201, { ok: true, ...pairing });
  }

  if (path === "/boards" && method === "GET") {
    return send(response, 200, {
      app: "taskboard", version: FILE_VERSION, exportedAt: new Date().toISOString(),
      boards: store.read(accountId),
      // an export file has no deletions in it and an import ignores the key, so carrying
      // them here costs nothing and saves the client a second round trip
      deletions: store.deletions(accountId),
    });
  }

  if (path === "/boards" && method === "PUT") {
    let payload;
    try { payload = await body(request); }
    catch (error) { return send(response, 400, { ok: false, message: error.message }); }

    if (!Array.isArray(payload?.boards)) {
      return send(response, 400, { ok: false, message: "No boards in that. It has to be a Taskboard export." });
    }

    // deletions go first. a push that carries both is a device catching up, and applying
    // the writes first would only have them taken straight back out again
    const buried = store.bury(accountId, payload.deletions);
    const counts = store.merge(accountId, payload.boards);
    return send(response, 200, { ok: true, ...counts, deleted: buried });
  }

  return send(response, 404, { ok: false, message: `Nothing at ${url.pathname}.` });
});

// the usual reason this happens is that it is already running in another terminal, which
// is worth saying rather than throwing eight lines of stack at it
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Something is already listening on :${PORT}. Is the sync server running in another terminal?`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`taskboard sync on :${PORT}, store at ${STORE}`);
});
