// Two devices on one key, which is the thing the sync engine is for: what you type on the
// desk turns up on the phone without anybody importing anything.
//
// This drives the real api over http with two clients that behave the way src/server.ts
// does - pull, merge by whoever wrote last, then push the whole tree back. The merge here
// is a plain object stand in for dexie, so what is being tested is the rules and the api
// rather than IndexedDB.
//
// Run it with: node server/converge.test.mjs

import { strictEqual, ok } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scratch = mkdtempSync(join(tmpdir(), "taskboard-converge-"));
const port = 4398;
const root = `http://127.0.0.1:${port}/api`;

const api = spawn(process.execPath, [fileURLToPath(new URL("./api.mjs", import.meta.url))], {
  env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_STORE: join(scratch, "converge.db") },
  stdio: ["ignore", "pipe", "inherit"],
});

const stop = async () => {
  const ended = new Promise((resolve) => api.once("exit", resolve));
  api.kill();
  await ended;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp folder */ }
};

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

/* ---------- a device, the way the browser half behaves ---------- */

function Device(key, name) {
  // the three tables, flat, keyed by id - dexie stands in as a Map here
  const boards = new Map();
  const columns = new Map();
  const notes = new Map();
  const graves = new Map();

  const call = async (path, options = {}) => {
    const response = await fetch(`${root}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        "x-taskboard-key": key,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${name}: ${body.message}`);
    return body;
  };

  const older = (incoming, held) => held && String(incoming) <= String(held.updatedAt);

  const land = (table, row) => {
    const grave = graves.get(row.id);
    if (grave && String(grave.deletedAt) >= String(row.updatedAt)) return;
    if (older(row.updatedAt, table.get(row.id))) return;
    table.set(row.id, row);
  };

  return {
    name,
    boards, columns, notes,

    edit(id, changes, at) {
      const row = { ...notes.get(id), ...changes, updatedAt: at };
      notes.set(id, row);
      return row;
    },

    remove(id, kind, at) {
      graves.set(id, { id, kind, deletedAt: at });
      (kind === "board" ? boards : kind === "category" ? columns : notes).delete(id);
    },

    seed(bundle) {
      boards.set(bundle.board.id, bundle.board);
      for (const entry of bundle.columns) {
        columns.set(entry.column.id, entry.column);
        for (const note of entry.notes) notes.set(note.id, note);
      }
    },

    async pull() {
      const answer = await call("/boards");

      for (const grave of answer.deletions ?? []) {
        const table = grave.kind === "board" ? boards : grave.kind === "category" ? columns : notes;
        const held = table.get(grave.id);
        if (held && String(held.updatedAt) > String(grave.deletedAt)) continue;
        table.delete(grave.id);
        graves.set(grave.id, grave);
      }

      for (const bundle of answer.boards ?? []) {
        land(boards, bundle.board);
        for (const entry of bundle.columns) {
          land(columns, entry.column);
          for (const note of entry.notes) land(notes, note);
        }
      }
    },

    async push() {
      // the whole tree, rebuilt the way gather() does it
      const bundles = [...boards.values()]
        .sort((a, b) => a.position - b.position)
        .map((board) => ({
          board,
          columns: [...columns.values()]
            .filter((column) => column.boardId === board.id)
            .sort((a, b) => a.position - b.position)
            .map((column) => ({
              column,
              notes: [...notes.values()]
                .filter((note) => note.categoryId === column.id)
                .sort((a, b) => a.position - b.position),
            })),
        }));

      return call("/boards", {
        method: "PUT",
        body: { app: "taskboard", version: 2, boards: bundles, deletions: [...graves.values()] },
      });
    },

    async sync() { await this.pull(); await this.push(); },
  };
}

const iso = (minutes) => new Date(Date.UTC(2026, 8, 5, 12, minutes)).toISOString();

try {
  const first = await (await fetch(`${root}/keys`, { method: "POST" })).json();
  const opened = await (await fetch(`${root}/pairings`, {
    method: "POST", headers: { "x-taskboard-key": first.key },
  })).json();
  const second = await (await fetch(`${root}/pairings/claim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: opened.code, label: "the phone" }),
  })).json();

  const desk = Device(first.key, "desk");
  const phone = Device(second.key, "phone");

  desk.seed({
    board: { id: "b-1", name: "Taskboard-dev", position: 0, createdAt: iso(0), updatedAt: iso(0) },
    columns: [{
      column: { id: "c-1", boardId: "b-1", name: "In Flight", color: "coral", position: 0, createdAt: iso(0), updatedAt: iso(0) },
      notes: [
        { id: "n-1", categoryId: "c-1", title: "Rename a Board", content: "", type: "idea", checklists: [], completed: false, position: 0, createdAt: iso(0), updatedAt: iso(0) },
        { id: "n-2", categoryId: "c-1", title: "Drop the v3 Wipe", content: "", type: "idea", checklists: [], completed: false, position: 1, createdAt: iso(0), updatedAt: iso(0) },
      ],
    }],
  });

  await check("a board made on one device turns up on the other, no import", async () => {
    strictEqual(phone.boards.size, 0);
    await desk.sync();
    await phone.sync();

    strictEqual(phone.boards.size, 1);
    strictEqual(phone.notes.size, 2);
    strictEqual(phone.boards.get("b-1").name, "Taskboard-dev");
  });

  await check("an edit on the phone comes back to the desk", async () => {
    phone.edit("n-1", { title: "Rename a Board (done)", completed: true }, iso(10));
    await phone.sync();
    await desk.sync();
    strictEqual(desk.notes.get("n-1").title, "Rename a Board (done)");
    strictEqual(desk.notes.get("n-1").completed, true);
  });

  await check("two devices editing different notes both keep their edit", async () => {
    desk.edit("n-1", { content: "from the desk" }, iso(20));
    phone.edit("n-2", { content: "from the phone" }, iso(21));

    await desk.sync();
    await phone.sync();
    await desk.sync();

    strictEqual(desk.notes.get("n-1").content, "from the desk");
    strictEqual(desk.notes.get("n-2").content, "from the phone");
    strictEqual(phone.notes.get("n-1").content, "from the desk");
    strictEqual(phone.notes.get("n-2").content, "from the phone");
  });

  await check("the same note edited on both, the later one wins everywhere", async () => {
    desk.edit("n-2", { title: "Desk got there first" }, iso(30));
    phone.edit("n-2", { title: "Phone got there last" }, iso(31));

    await desk.sync();
    await phone.sync();
    await desk.sync();

    strictEqual(desk.notes.get("n-2").title, "Phone got there last");
    strictEqual(phone.notes.get("n-2").title, "Phone got there last");
  });

  await check("a delete travels, and does not come back on the next push", async () => {
    desk.remove("n-1", "note", iso(40));
    await desk.sync();
    await phone.sync();

    strictEqual(phone.notes.has("n-1"), false, "the phone still has the deleted note");

    // the phone pushes its whole tree straight after, which must not resurrect it
    await phone.sync();
    await desk.sync();
    strictEqual(desk.notes.has("n-1"), false, "the note came back from the dead");
  });

  await check("a device that was away catches up in one sync", async () => {
    const late = Device(second.key, "laptop");
    strictEqual(late.boards.size, 0);
    await late.sync();

    strictEqual(late.boards.size, 1);
    strictEqual(late.columns.size, 1);
    strictEqual(late.notes.size, 1, "the deleted note should not have been handed over");
    ok(late.notes.has("n-2"));
  });

  await check("a revoked device stops syncing, the others carry on", async () => {
    const listed = await (await fetch(`${root}/keys`, { headers: { "x-taskboard-key": first.key } })).json();
    const gone = listed.keys.find((row) => row.label === "the phone");
    await fetch(`${root}/keys/${gone.id}`, { method: "DELETE", headers: { "x-taskboard-key": first.key } });

    let refused = false;
    try { await phone.sync(); } catch { refused = true; }
    ok(refused, "a revoked device kept syncing");

    await desk.sync();
    strictEqual(desk.notes.size, 1);
  });

  console.log(`\n${passed} checks passed`);
} finally {
  await stop();
}
