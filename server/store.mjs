// The store behind the sync api. One sqlite file, no dependencies - node:sqlite is builtin
// from 22.5 and the image is on 24, so there is nothing to compile and nothing to install.
//
// The board tables are the same three the browser holds, with the same field names, because
// the whole point is that what comes out of here is a Taskboard export and what goes into it
// is a Taskboard export. A shape of its own would mean two schemas drifting apart and a
// translation layer in the middle to keep them honest.
//
// checklists stays json on the note, exactly as dexie holds it. Shredding a step tree into
// rows buys nothing - it is always read and written whole with the note it belongs to.
//
// Above the boards sits an account, which is nothing but an id: no email, no password, no
// name. A key points at one. Several keys can point at the same one, which is what lets a
// second device in without anybody typing out a 47 character key, and lets an agent hold
// its own that you can revoke without touching your phone. Only the hash of a key is ever
// stored, so nothing here can hand one back - not to a thief, and not to you either.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// account_id sits on every board table rather than being reached through the board above it,
// so every read and every wipe is one indexed lookup and never a join
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS keys (
    key_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL, account_id TEXT NOT NULL,
    label TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT
  );
  CREATE TABLE IF NOT EXISTS pairings (
    code TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, board_id TEXT NOT NULL, name TEXT NOT NULL,
    color TEXT NOT NULL, position INTEGER NOT NULL, width INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, category_id TEXT NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL, type TEXT NOT NULL, checklists TEXT NOT NULL, completed INTEGER NOT NULL,
    position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    completed_at TEXT, archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS deletions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, deleted_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS keys_by_account ON keys (account_id);
  CREATE INDEX IF NOT EXISTS pairings_by_expiry ON pairings (expires_at);
  CREATE INDEX IF NOT EXISTS boards_by_account ON boards (account_id);
  CREATE INDEX IF NOT EXISTS categories_by_board ON categories (account_id, board_id);
  CREATE INDEX IF NOT EXISTS notes_by_category ON notes (account_id, category_id);
  CREATE INDEX IF NOT EXISTS deletions_by_account ON deletions (account_id, deleted_at);
`;

export const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");

// 32 bytes of random, url safe, with something on the front so it is recognisable as one of
// ours when it turns up in a config file. only the hash of it is ever stored
export const mintKey = () => `tb_${randomBytes(32).toString("base64url")}`;

// six digits, typed by someone squinting at another screen. short is the point - what keeps
// it safe is that it dies in five minutes, works once, and the api counts wrong guesses
const mintCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

// codes are compared byte for byte in constant time. they are short lived, but a compare
// that gives up on the first wrong digit still tells you how much of it you got right
const sameCode = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

export const PAIRING_TTL = 5 * 60 * 1000;
export const PAIRING_TRIES = 5;

/* ---------- rows in, rows out ----------

   sqlite takes null, not undefined, and has no boolean. the browser types have optional
   fields that are absent rather than null, so on the way back out anything unset is left
   off the object entirely - an export with "archivedAt": null in it is not the same file
   that went in, and round tripping exactly is the one thing this has to get right. */

const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);
const whole = (value, fallback = 0) => (Number.isFinite(value) ? Math.trunc(value) : fallback);
const orNull = (value) => (typeof value === "string" && value ? value : null);
const maybe = (field, value) => (value === null || value === undefined ? {} : { [field]: value });

// a row written before boards and columns had an updatedAt falls back to when it was made,
// never to now. now would make every row in an old file the newest thing on the server
const stamp = (value, created) => (typeof value === "string" && value
  ? value
  : text(created, new Date().toISOString()));

const boardOut = (row) => ({
  id: row.id, name: row.name, position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...maybe("archivedAt", row.archived_at),
});

const columnOut = (row) => ({
  id: row.id, boardId: row.board_id, name: row.name, color: row.color, position: row.position,
  ...maybe("width", row.width),
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...maybe("archivedAt", row.archived_at),
});

const noteOut = (row) => ({
  id: row.id, categoryId: row.category_id, title: row.title, content: row.content, type: row.type,
  checklists: JSON.parse(row.checklists), completed: row.completed === 1, position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...maybe("completedAt", row.completed_at),
  ...maybe("archivedAt", row.archived_at),
});

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");

  // a store written by the first cut keyed its boards on key_hash rather than an account.
  // nothing was ever deployed on it, but say so plainly rather than failing on a missing
  // column three calls later
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'boards'").get();
  if (existing) {
    const columns = db.prepare("PRAGMA table_info(boards)").all().map((row) => row.name);
    if (columns.includes("key_hash")) {
      throw new Error(
        "This store was made by the key_hash version, before accounts existed. Nothing shipped on "
        + "it, so delete the file and let it be made again.",
      );
    }
  }

  db.exec(SCHEMA);

  const one = (sql) => db.prepare(sql);
  const q = {
    addAccount: one("INSERT INTO accounts (id, created_at) VALUES (?, ?)"),

    addKey: one("INSERT INTO keys (key_hash, key_id, account_id, label, created_at) VALUES (?, ?, ?, ?, ?)"),
    getKey: one("SELECT account_id FROM keys WHERE key_hash = ?"),
    keysOf: one("SELECT key_id, label, created_at, last_seen FROM keys WHERE account_id = ? ORDER BY created_at"),
    countKeys: one("SELECT COUNT(*) AS n FROM keys WHERE account_id = ?"),
    dropKey: one("DELETE FROM keys WHERE account_id = ? AND key_id = ?"),
    seenKey: one("UPDATE keys SET last_seen = ? WHERE key_hash = ?"),

    addPairing: one("INSERT INTO pairings (code, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    getPairing: one("SELECT * FROM pairings WHERE code = ?"),
    usePairing: one("UPDATE pairings SET used_at = ? WHERE code = ?"),
    missPairing: one("UPDATE pairings SET attempts = attempts + 1 WHERE code = ?"),
    sweepPairings: one("DELETE FROM pairings WHERE expires_at < ? OR used_at IS NOT NULL"),

    boards: one("SELECT * FROM boards WHERE account_id = ? ORDER BY position, created_at"),
    columns: one("SELECT * FROM categories WHERE account_id = ? AND board_id = ? ORDER BY position, created_at"),
    notes: one("SELECT * FROM notes WHERE account_id = ? AND category_id = ? ORDER BY position, created_at"),

    boardAt: one("SELECT updated_at FROM boards WHERE account_id = ? AND id = ?"),
    columnAt: one("SELECT updated_at FROM categories WHERE account_id = ? AND id = ?"),
    noteAt: one("SELECT updated_at FROM notes WHERE account_id = ? AND id = ?"),

    putBoard: one(`INSERT INTO boards (id, account_id, name, position, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, position = excluded.position, created_at = excluded.created_at,
      updated_at = excluded.updated_at, archived_at = excluded.archived_at`),
    putColumn: one(`INSERT INTO categories (id, account_id, board_id, name, color, position, width,
      created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, name = excluded.name, color = excluded.color,
      position = excluded.position, width = excluded.width, created_at = excluded.created_at,
      updated_at = excluded.updated_at, archived_at = excluded.archived_at`),
    putNote: one(`INSERT INTO notes (id, account_id, category_id, title, content, type, checklists,
      completed, position, created_at, updated_at, completed_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      category_id = excluded.category_id, title = excluded.title, content = excluded.content,
      type = excluded.type, checklists = excluded.checklists, completed = excluded.completed,
      position = excluded.position, created_at = excluded.created_at, updated_at = excluded.updated_at,
      completed_at = excluded.completed_at, archived_at = excluded.archived_at`),

    dropBoard: one("DELETE FROM boards WHERE account_id = ? AND id = ?"),
    dropColumn: one("DELETE FROM categories WHERE account_id = ? AND id = ?"),
    dropNote: one("DELETE FROM notes WHERE account_id = ? AND id = ?"),
    columnsOfBoard: one("SELECT id FROM categories WHERE account_id = ? AND board_id = ?"),
    notesOfColumn: one("SELECT id FROM notes WHERE account_id = ? AND category_id = ?"),

    putGone: one(`INSERT INTO deletions (id, account_id, kind, deleted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at`),
    gone: one("SELECT id, kind, deleted_at FROM deletions WHERE account_id = ? ORDER BY deleted_at"),
    isGone: one("SELECT deleted_at FROM deletions WHERE account_id = ? AND id = ?"),
  };

  const at = { board: q.boardAt, category: q.columnAt, note: q.noteAt };

  // a write only lands if it is newer than what is already there. the same stamp means both
  // sides are looking at the same edit, so it is left alone rather than written again
  const newer = (incoming, existing) => !existing || String(incoming) > String(existing.updated_at);

  // a key is minted here and handed straight out. what is kept is the hash and a short id,
  // which is enough to list the thing and revoke it and no use at all for signing in
  const issue = (accountId, label) => {
    const key = mintKey();
    const hash = hashKey(key);
    q.addKey.run(hash, hash.slice(0, 12), accountId, text(label, "device"), new Date().toISOString());
    return key;
  };

  return {
    close: () => db.close(),

    // an account is an id and a date. everything a person has is hung off it
    createAccount(label = "first device") {
      const accountId = randomBytes(16).toString("hex");
      q.addAccount.run(accountId, new Date().toISOString());
      return { accountId, key: issue(accountId, label) };
    },

    accountFor: (keyHash) => q.getKey.get(keyHash)?.account_id ?? null,
    touch: (keyHash) => q.seenKey.run(new Date().toISOString(), keyHash),
    addKey: (accountId, label) => issue(accountId, label),

    keys: (accountId) => q.keysOf.all(accountId).map((row) => ({
      id: row.key_id, label: row.label, createdAt: row.created_at, lastSeen: row.last_seen ?? null,
    })),

    // the last key is not revocable, since dropping it would strand every board under it
    // with no way back in and nothing to reset
    revokeKey(accountId, keyId) {
      if (q.countKeys.get(accountId).n <= 1) return { ok: false, message: "That is the only key left on this account." };
      const done = q.dropKey.run(accountId, keyId);
      return done.changes ? { ok: true } : { ok: false, message: "No key with that id." };
    },

    /* ---------- pairing ----------

       Device one already holds a key, so it is allowed to vouch for device two. It asks for
       a code, reads it out, and device two types six digits instead of forty seven
       characters. What comes back is not the first device's key - the server has never seen
       it - but a brand new one on the same account. */

    openPairing(accountId, ttl = PAIRING_TTL) {
      q.sweepPairings.run(new Date().toISOString());
      const now = Date.now();

      // a collision would hand someone else's code back, so try again rather than upsert
      for (let tries = 0; tries < 10; tries += 1) {
        const code = mintCode();
        if (q.getPairing.get(code)) continue;
        const expiresAt = new Date(now + ttl).toISOString();
        q.addPairing.run(code, accountId, new Date(now).toISOString(), expiresAt);
        return { code, expiresAt };
      }
      throw new Error("Could not find a free pairing code.");
    },

    // wrong guesses are counted against the code itself, so a code being brute forced burns
    // out rather than sitting there for the full five minutes taking attempts
    claimPairing(code, label = "paired device") {
      const wanted = text(code).trim();
      if (!/^\d{6}$/.test(wanted)) return { ok: false, message: "A pairing code is six digits." };

      const row = q.getPairing.get(wanted);
      if (!row || !sameCode(row.code, wanted)) return { ok: false, message: "That code is not one we gave out." };
      if (row.used_at) return { ok: false, message: "That code has already been used." };
      if (row.attempts >= PAIRING_TRIES) return { ok: false, message: "That code has been guessed at too many times." };
      if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, message: "That code has expired." };

      q.usePairing.run(new Date().toISOString(), wanted);
      return { ok: true, key: issue(row.account_id, label) };
    },

    missPairing: (code) => q.missPairing.run(text(code).trim()),

    // the board tree, in the order the board draws it - the same shape gather() writes out
    read(accountId) {
      return q.boards.all(accountId).map((board) => ({
        board: boardOut(board),
        columns: q.columns.all(accountId, board.id).map((column) => ({
          column: columnOut(column),
          notes: q.notes.all(accountId, column.id).map(noteOut),
        })),
      }));
    },

    deletions: (accountId) => q.gone.all(accountId)
      .map((row) => ({ id: row.id, kind: row.kind, deletedAt: row.deleted_at })),

    /* A push adds and updates. It never removes: a client that only knows about two of your
       five boards pushes two boards, and the other three have to still be here afterwards.
       Anything that really is gone travels as a deletion instead, where it is explicit. */
    merge(accountId, bundles) {
      const count = { added: 0, updated: 0, skipped: 0, buried: 0 };

      const write = (kind, id, changedAt, put) => {
        // a row deleted after this edit was made does not come back to life
        const grave = q.isGone.get(accountId, id);
        if (grave && String(grave.deleted_at) >= String(changedAt)) { count.buried += 1; return; }

        const existing = at[kind].get(accountId, id);
        if (!newer(changedAt, existing)) { count.skipped += 1; return; }
        put();
        count[existing ? "updated" : "added"] += 1;
      };

      db.exec("BEGIN");
      try {
        for (const bundle of bundles ?? []) {
          const board = bundle?.board ?? {};
          if (!text(board.id)) continue;
          const boardAt = stamp(board.updatedAt, board.createdAt);

          write("board", board.id, boardAt, () => q.putBoard.run(
            board.id, accountId, text(board.name, "Board"), whole(board.position),
            stamp(board.createdAt), boardAt, orNull(board.archivedAt),
          ));

          for (const entry of bundle?.columns ?? []) {
            const column = entry?.column ?? {};
            if (!text(column.id)) continue;
            const columnAt = stamp(column.updatedAt, column.createdAt);

            write("category", column.id, columnAt, () => q.putColumn.run(
              column.id, accountId, text(column.boardId) || board.id, text(column.name, "Column"),
              text(column.color, "coral"), whole(column.position),
              Number.isFinite(column.width) ? Math.trunc(column.width) : null,
              stamp(column.createdAt), columnAt, orNull(column.archivedAt),
            ));

            for (const note of entry?.notes ?? []) {
              if (!text(note?.id)) continue;
              const noteAt = stamp(note.updatedAt, note.createdAt);

              write("note", note.id, noteAt, () => q.putNote.run(
                note.id, accountId, text(note.categoryId) || column.id, text(note.title, "Untitled"),
                text(note.content), text(note.type, "idea"),
                JSON.stringify(Array.isArray(note.checklists) ? note.checklists : []),
                note.completed === true ? 1 : 0, whole(note.position),
                stamp(note.createdAt), noteAt, orNull(note.completedAt), orNull(note.archivedAt),
              ));
            }
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return count;
    },

    // the only way anything leaves. a board takes its columns and their notes, same as it
    // does on the board, and every id that goes is written down so the next device finds out
    bury(accountId, deletions) {
      let count = 0;

      db.exec("BEGIN");
      try {
        for (const row of deletions ?? []) {
          const id = text(row?.id);
          const kind = ["board", "category", "note"].includes(row?.kind) ? row.kind : null;
          if (!id || !kind) continue;
          const goneAt = stamp(row.deletedAt, new Date().toISOString());

          // an edit made after the delete wins, so a row worked on elsewhere is not taken
          // out from under it by a tombstone that has been sat in an offline queue
          const held = at[kind].get(accountId, id);
          if (held && String(held.updated_at) > String(goneAt)) continue;

          if (kind === "board") {
            for (const column of q.columnsOfBoard.all(accountId, id)) {
              for (const note of q.notesOfColumn.all(accountId, column.id)) {
                q.dropNote.run(accountId, note.id);
                q.putGone.run(note.id, accountId, "note", goneAt);
              }
              q.dropColumn.run(accountId, column.id);
              q.putGone.run(column.id, accountId, "category", goneAt);
            }
            q.dropBoard.run(accountId, id);
          } else if (kind === "category") {
            for (const note of q.notesOfColumn.all(accountId, id)) {
              q.dropNote.run(accountId, note.id);
              q.putGone.run(note.id, accountId, "note", goneAt);
            }
            q.dropColumn.run(accountId, id);
          } else {
            q.dropNote.run(accountId, id);
          }

          q.putGone.run(id, accountId, kind, goneAt);
          count += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return count;
    },
  };
}
