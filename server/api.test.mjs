// Boots the real api on a scratch store and drives it over http, so the routes, the key
// header and the json wrapper are covered rather than just the store underneath.
//
// Run it with: node server/api.test.mjs

import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scratch = mkdtempSync(join(tmpdir(), "taskboard-api-"));
const port = 4399;
const root = `http://127.0.0.1:${port}/api`;

const api = spawn(process.execPath, [fileURLToPath(new URL("./api.mjs", import.meta.url))], {
  env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_STORE: join(scratch, "api.db") },
  stdio: ["ignore", "pipe", "inherit"],
});

// windows will not let the file go while the child still has it open, and kill() only asks.
// wait for it to actually be gone, and never fail the run over tidying up a temp folder
const stop = async () => {
  const ended = new Promise((resolve) => api.once("exit", resolve));
  api.kill();
  await ended;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* it is a temp folder */ }
};

// wait for it to say it is up rather than sleeping a guess
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("the api never started")), 10000);
  api.stdout.on("data", (chunk) => {
    if (String(chunk).includes("taskboard sync on")) { clearTimeout(timer); resolve(); }
  });
  api.on("error", reject);
});

let passed = 0;
const check = async (name, run) => {
  await run();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const board = {
  board: {
    id: "b-1", name: "Taskboard-dev", position: 0,
    createdAt: "2026-05-01T10:00:00.000Z", updatedAt: "2026-05-02T10:00:00.000Z",
  },
  columns: [{
    column: {
      id: "c-1", boardId: "b-1", name: "Server Storage", color: "coral", position: 0,
      createdAt: "2026-05-01T10:00:00.000Z", updatedAt: "2026-05-01T10:00:00.000Z",
    },
    notes: [{
      id: "n-1", categoryId: "c-1", title: "Sync API", content: "keys map to a bag of boards",
      type: "checklist",
      checklists: [{ id: "l-1", name: "TODO:", items: [{ id: "s-1", text: "POST /keys", completed: true, items: [] }] }],
      completed: false, position: 0,
      createdAt: "2026-05-01T10:00:00.000Z", updatedAt: "2026-05-03T10:00:00.000Z",
    }],
  }],
};

try {
  await check("health answers without a key", async () => {
    const body = await (await fetch(`${root}/health`)).json();
    strictEqual(body.ok, true);
  });

  await check("no key is turned away", async () => {
    strictEqual((await fetch(`${root}/boards`)).status, 401);
  });

  await check("a made up key is turned away", async () => {
    const response = await fetch(`${root}/boards`, { headers: { "x-taskboard-key": "tb_nonsense" } });
    strictEqual(response.status, 403);
  });

  const key = await (async () => {
    const response = await fetch(`${root}/keys`, { method: "POST" });
    strictEqual(response.status, 201);
    const body = await response.json();
    ok(body.key.startsWith("tb_"), "that does not look like one of ours");
    return body.key;
  })();
  passed += 1;
  console.log("  ok  a key can be minted, and is handed back once");

  const withKey = { "x-taskboard-key": key, "content-type": "application/json" };

  await check("a push lands", async () => {
    const response = await fetch(`${root}/boards`, {
      method: "PUT", headers: withKey,
      body: JSON.stringify({ app: "taskboard", version: 2, exportedAt: new Date().toISOString(), boards: [board] }),
    });
    const body = await response.json();
    strictEqual(body.added, 3, "board, column and note should all be new");
  });

  await check("what comes back is an importable export file", async () => {
    const body = await (await fetch(`${root}/boards`, { headers: withKey })).json();
    strictEqual(body.app, "taskboard");
    ok(typeof body.exportedAt === "string" && body.exportedAt, "no exportedAt on it");
    ok(Array.isArray(body.boards), "no boards array on it");
    deepStrictEqual(body.boards[0], board);
  });

  await check("a bad body is refused rather than stored", async () => {
    const response = await fetch(`${root}/boards`, {
      method: "PUT", headers: withKey, body: JSON.stringify({ nothing: true }),
    });
    strictEqual(response.status, 400);
  });

  await check("an unknown route says so", async () => {
    strictEqual((await fetch(`${root}/nope`, { headers: withKey })).status, 404);
  });

  /* ---------- pairing a second device ---------- */

  let paired;

  await check("a code is six digits and pairing hands back a different key", async () => {
    const opened = await (await fetch(`${root}/pairings`, { method: "POST", headers: withKey })).json();
    ok(/^\d{6}$/.test(opened.code), `that is not six digits: ${opened.code}`);

    const response = await fetch(`${root}/pairings/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: opened.code, label: "the phone" }),
    });
    strictEqual(response.status, 201);

    const claimed = await response.json();
    ok(claimed.key.startsWith("tb_"), "that does not look like one of ours");
    ok(claimed.key !== key, "pairing handed back the key device one already had");
    paired = claimed.key;
  });

  await check("the paired device sees the same boards", async () => {
    const body = await (await fetch(`${root}/boards`, { headers: { "x-taskboard-key": paired } })).json();
    deepStrictEqual(body.boards[0], board);
  });

  await check("both devices are listed on the account", async () => {
    const body = await (await fetch(`${root}/keys`, { headers: withKey })).json();
    strictEqual(body.keys.length, 2);
    ok(body.keys.some((row) => row.label === "the phone"), "the paired device is not listed");
  });

  await check("a wrong code is refused", async () => {
    const response = await fetch(`${root}/pairings/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    strictEqual(response.status, 400);
  });

  await check("the paired device can be revoked, and stops working", async () => {
    const listed = await (await fetch(`${root}/keys`, { headers: withKey })).json();
    const phone = listed.keys.find((row) => row.label === "the phone");

    const gone = await fetch(`${root}/keys/${phone.id}`, { method: "DELETE", headers: withKey });
    strictEqual(gone.status, 200);

    const after = await fetch(`${root}/boards`, { headers: { "x-taskboard-key": paired } });
    strictEqual(after.status, 403, "a revoked key still worked");
  });

  // last, because it uses up the allowance for this caller and everything after would 429
  await check("guessing at codes gets shut down", async () => {
    let blocked = false;
    for (let n = 0; n < 20 && !blocked; n += 1) {
      const response = await fetch(`${root}/pairings/claim`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: String(n).padStart(6, "0") }),
      });
      blocked = response.status === 429;
    }
    ok(blocked, "twenty guesses in a row were all allowed through");
  });

  console.log(`\n${passed} checks passed`);
} finally {
  await stop();
}
