// What this has to prove, in order:
//
//   1. a board exported out of the app pushes up and comes back the same file
//   2. an export written before boards and columns had an updatedAt still works
//   3. a push cannot remove anything it did not mention
//   4. the older of two edits does not win
//   5. a delete travels, and a row that has been deleted does not come back on the next push
//   6. a delete does not take an edit made after it
//
// Run it with: node server/roundtrip.test.mjs

import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashKey, openStore, PAIRING_TRIES } from "./store.mjs";

const scratch = mkdtempSync(join(tmpdir(), "taskboard-test-"));
const store = openStore(join(scratch, "test.db"));
const { accountId: hash } = store.createAccount();

let passed = 0;
const check = (name, run) => {
  run();
  passed += 1;
  console.log(`  ok  ${name}`);
};

/* ---------- fixtures, shaped exactly as transfer.ts writes them ---------- */

const step = (id, text, done, items = []) => ({ id, text, completed: done, items });

// the current shape, everything filled in including the optional fields
const current = {
  board: {
    id: "b-1", name: "Faded Light", position: 0,
    createdAt: "2026-01-02T10:00:00.000Z", updatedAt: "2026-03-01T09:00:00.000Z",
  },
  columns: [
    {
      column: {
        id: "c-1", boardId: "b-1", name: "Phase 1", color: "coral", position: 0, width: 420,
        createdAt: "2026-01-02T10:00:00.000Z", updatedAt: "2026-02-01T08:00:00.000Z",
      },
      notes: [
        {
          id: "n-1", categoryId: "c-1", title: "Input Handler", content: "reads input on tick",
          type: "checklist",
          checklists: [{
            id: "l-1", name: "TODO:",
            items: [step("s-1", "Read Input on Tick", true, [step("s-2", "physics frame", true)])],
          }],
          completed: true, position: 0,
          createdAt: "2026-01-02T10:00:00.000Z", updatedAt: "2026-02-10T12:00:00.000Z",
          completedAt: "2026-02-10T12:00:00.000Z",
        },
        {
          id: "n-2", categoryId: "c-1", title: "Cavern Demo", content: "", type: "idea",
          checklists: [], completed: false, position: 1,
          createdAt: "2026-01-03T10:00:00.000Z", updatedAt: "2026-01-03T10:00:00.000Z",
          archivedAt: "2026-02-20T10:00:00.000Z",
        },
      ],
    },
    {
      column: {
        id: "c-2", boardId: "b-1", name: "Phase 2", color: "teal", position: 1,
        createdAt: "2026-01-02T10:00:00.000Z", updatedAt: "2026-01-02T10:00:00.000Z",
        archivedAt: "2026-03-01T09:00:00.000Z",
      },
      notes: [],
    },
  ],
};

// what a file exported before today looks like: no updatedAt above the note, no width
const legacy = {
  board: { id: "b-2", name: "Old Export", position: 1, createdAt: "2025-11-01T10:00:00.000Z" },
  columns: [{
    column: {
      id: "c-3", boardId: "b-2", name: "Backlog", color: "gold", position: 0,
      createdAt: "2025-11-01T10:00:00.000Z",
    },
    notes: [{
      id: "n-3", categoryId: "c-3", title: "Something old", content: "", type: "idea",
      checklists: [], completed: false, position: 0,
      createdAt: "2025-11-01T10:00:00.000Z", updatedAt: "2025-11-02T10:00:00.000Z",
    }],
  }],
};

/* ---------- 1 and 2, the round trip ---------- */

store.merge(hash, [current, legacy]);
const back = store.read(hash);

check("a current export comes back exactly as it went in", () => {
  deepStrictEqual(back[0], current);
});

check("no nulls creep in where a field was simply absent", () => {
  ok(!("archivedAt" in back[0].columns[0].notes[0]), "an unarchived note grew an archivedAt");
  ok(!("completedAt" in back[0].columns[0].notes[1]), "an unfinished note grew a completedAt");
  ok(!("width" in back[1].columns[0].column), "a column that was never dragged grew a width");
});

check("an old export lands, with updatedAt filled in from createdAt", () => {
  strictEqual(back[1].board.updatedAt, legacy.board.createdAt);
  strictEqual(back[1].columns[0].column.updatedAt, legacy.columns[0].column.createdAt);
  strictEqual(back[1].columns[0].notes[0].title, "Something old");
});

check("the nested step tree survives the json column", () => {
  deepStrictEqual(back[0].columns[0].notes[0].checklists, current.columns[0].notes[0].checklists);
});

/* ---------- 3, a push only adds ---------- */

check("pushing one board leaves the others alone", () => {
  store.merge(hash, [legacy]);
  strictEqual(store.read(hash).length, 2, "a board went missing on a partial push");
});

/* ---------- 4, whoever edited last wins ---------- */

check("a newer edit lands", () => {
  const newer = structuredClone(current);
  newer.board.name = "Renamed later";
  newer.board.updatedAt = "2026-06-01T10:00:00.000Z";
  const counts = store.merge(hash, [newer]);
  strictEqual(counts.updated, 1);
  strictEqual(store.read(hash)[0].board.name, "Renamed later");
});

check("an older edit does not", () => {
  const stale = structuredClone(current);
  stale.board.name = "Stale name";
  stale.board.updatedAt = "2026-01-01T10:00:00.000Z";
  const counts = store.merge(hash, [stale]);
  // the whole bundle is pushed, so the other four rows are skipped as unchanged too
  strictEqual(counts.updated, 0);
  strictEqual(counts.skipped, 5);
  strictEqual(store.read(hash)[0].board.name, "Renamed later");
});

/* ---------- 5 and 6, deletes ---------- */

check("a deleted note goes, and is written down", () => {
  strictEqual(store.bury(hash, [{ id: "n-2", kind: "note", deletedAt: "2026-07-01T10:00:00.000Z" }]), 1);
  strictEqual(store.read(hash)[0].columns[0].notes.length, 1);
  ok(store.deletions(hash).some((row) => row.id === "n-2"), "nothing was written down");
});

check("pushing the deleted note again does not resurrect it", () => {
  const counts = store.merge(hash, [current]);
  strictEqual(counts.buried, 1);
  strictEqual(store.read(hash)[0].columns[0].notes.length, 1);
});

check("a delete takes the columns and notes under a board", () => {
  store.bury(hash, [{ id: "b-2", kind: "board", deletedAt: "2026-07-01T10:00:00.000Z" }]);
  strictEqual(store.read(hash).length, 1);
  const graves = store.deletions(hash).map((row) => row.id);
  ok(graves.includes("c-3") && graves.includes("n-3"), "the column and note under it were not written down");
});

check("an edit made after the delete is not taken by it", () => {
  const edited = structuredClone(current);
  edited.columns[0].notes[0].title = "Edited after the delete";
  edited.columns[0].notes[0].updatedAt = "2026-09-01T10:00:00.000Z";
  store.merge(hash, [edited]);
  store.bury(hash, [{ id: "n-1", kind: "note", deletedAt: "2026-08-01T10:00:00.000Z" }]);
  strictEqual(store.read(hash)[0].columns[0].notes[0].title, "Edited after the delete");
});

/* ---------- keys ---------- */

check("another account sees none of it", () => {
  strictEqual(store.read(store.createAccount().accountId).length, 0);
});

/* ---------- keys and pairing ---------- */

check("a key resolves to its account, and a made up one does not", () => {
  const { accountId, key } = store.createAccount();
  strictEqual(store.accountFor(hashKey(key)), accountId);
  strictEqual(store.accountFor(hashKey("tb_nonsense")), null);
});

check("claiming a code mints a new key on the same account", () => {
  const { accountId, key } = store.createAccount();
  const { code } = store.openPairing(accountId);
  const claimed = store.claimPairing(code);

  ok(claimed.ok, claimed.message);
  ok(claimed.key !== key, "pairing handed back the key it already had");
  strictEqual(store.accountFor(hashKey(claimed.key)), accountId, "the new key landed on another account");
  strictEqual(store.keys(accountId).length, 2);
});

check("a code only works once", () => {
  const { accountId } = store.createAccount();
  const { code } = store.openPairing(accountId);
  ok(store.claimPairing(code).ok);
  strictEqual(store.claimPairing(code).ok, false);
});

check("an expired code is no good", () => {
  const { accountId } = store.createAccount();
  const { code } = store.openPairing(accountId, -1000);
  const claimed = store.claimPairing(code);
  strictEqual(claimed.ok, false);
  ok(claimed.message.includes("expired"), claimed.message);
});

check("a code burns out after too many wrong guesses", () => {
  const { accountId } = store.createAccount();
  const { code } = store.openPairing(accountId);
  for (let n = 0; n < PAIRING_TRIES; n += 1) store.missPairing(code);

  const claimed = store.claimPairing(code);
  strictEqual(claimed.ok, false, "a burnt out code still worked");
  ok(claimed.message.includes("guessed at"), claimed.message);
});

check("a code that was never given out is refused", () => {
  strictEqual(store.claimPairing("000000").ok, false);
  strictEqual(store.claimPairing("nope").ok, false);
});

check("a device can be revoked, but never the last one", () => {
  const { accountId } = store.createAccount();
  const { code } = store.openPairing(accountId);
  store.claimPairing(code);

  const [first] = store.keys(accountId);
  ok(store.revokeKey(accountId, first.id).ok);
  strictEqual(store.keys(accountId).length, 1);

  const [last] = store.keys(accountId);
  const refused = store.revokeKey(accountId, last.id);
  strictEqual(refused.ok, false, "the last key was revoked and stranded the boards");
});

check("revoking a key stops it working", () => {
  const { accountId } = store.createAccount();
  const { code } = store.openPairing(accountId);
  const second = store.claimPairing(code).key;

  const mine = store.keys(accountId).find((row) => row.id === hashKey(second).slice(0, 12));
  ok(store.revokeKey(accountId, mine.id).ok);
  strictEqual(store.accountFor(hashKey(second)), null);
});

store.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
