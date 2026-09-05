# Taskboard

A local-first taskboard for organizing categories and purpose-driven notes.

## Foundation

- React and TypeScript powered by Vite
- Dexie over IndexedDB for browser-local persistence
- Dark theme by default
- No account or server is required

## Run locally

Install Node.js, then run:

```bash
npm install
npm run dev
```

That starts the board on 5173 and the sync api on 4320 together, since the board proxies `/api`
across to it. `npm run dev:web` is the board on its own if you do not want the server.

For a production build:

```bash
npm run build
```

`npm run typecheck` runs the compiler on its own if you just want the types checked.

## Structure

Three levels. A board holds columns, a column holds rows.

```text
Project Alpha            <- board, picked from the sidebar
├── Sprint 1             <- category, drawn as a column
│   ├── Checklist        <- note, drawn as a row
│   └── Idea
└── Sprint 2
    ├── Checklist
    └── Checklist
```

Boards are the sidebar entries. Categories are the columns across the board. Notes are the rows
stacked inside a column, and their `position` is scoped to the column they sit in.

## Notes and checklists

An **idea** is the default task. A note can carry any number of **named checklists**, each with its
own steps, its own progress bar and its own count. Adding a checklist to a plain task turns it into a
checklist note. The circle next to the title is a separate flag that marks the whole note done, no
matter what the steps say.

```text
Task
├── description
├── Build          <- checklist, 2 of 3
│   ├── step
│   ├── step
│   └── step
└── Review         <- checklist, 0 of 2
    ├── step
    └── step
```

## Editing

Everything is edited in place. Clicking a note title, a description, a column name, "Add step",
"Add description" or "New column" swaps that spot for a text box: enter saves, escape backs out,
clicking away saves. Deleting a note asks in a small bar on the note itself.

Descriptions are the one multi-line field, so there enter makes a new line and **ctrl+enter** is
what saves. Saving a blank one clears the description and the "Add description" button returns.

No `window.prompt`, `window.confirm` or `window.alert` anywhere. Those are blocked in embedded
viewers such as the VS Code preview pane, so an action built on them looks dead rather than broken.
Keep it that way when adding features.

## Dragging

Three things drag, all through the same machinery:

- **Notes** between columns and within one. Grab a card anywhere with the mouse, or use its grip.
- **Columns** across the board, by the grip in the column head or by a collapsed column's strip.
- **Checklists** within their note, by the grip in the checklist head. Their steps come with them.
- **Steps** within a checklist, and between the checklists on the same note.

Checklists and steps are locked to their own note. Drag one off it and the slot disappears and the
drop is cancelled, rather than quietly applying wherever the slot happened to be last. Notes and
columns do keep their last slot, so releasing in the gap between two columns still lands.

A press only turns into a drag once it moves 5px, so ordinary clicks still land. On touch a card's
grip is the only way in, so a swipe still scrolls. A dashed slot shows where the thing will land, the board
scrolls sideways while dragging a note near an edge, and a column scrolls vertically when a long
checklist runs past its bottom.

The dashed slot is sized to the thing being dragged, which matters more than it looks. A fixed size
slot does not make up for the height the dragged element left behind, so everything below it shifts,
and the element under the pointer changes as you move — the drop target flickers or vanishes
entirely. Tall things like a checklist of five steps or a note with several checklists made this
obvious. `measure()` records the size on pointer down and the slot stands in at exactly that size.

Built on pointer events, not the HTML5 drag-and-drop API, for the same reason as the note above:
native drag is unreliable inside embedded webviews. `moveNote` and `moveColumn` in `src/db.ts`
renumber positions in a single transaction, so an interrupted drag cannot leave gaps.

## Collapsing

Anything that grows folds up, via the chevron on it:

- a **checklist** collapses to its name, count and progress bar
- a **note** collapses to its title plus a summary like "4 of 26 steps in 2 checklists"
- a **column** collapses to a narrow strip with its name running vertically

The chevron always leads, on the left of whatever it folds, which is why a task's sits before its
checkbox. The body of a task lines up under its title through the `--note-indent` variable on
`.note-row` — change it in one place and the type label, description, checklists and footer follow.

What is collapsed is view state, not data, so it lives in `localStorage` under `taskboard:collapsed`
rather than in the database. It survives a reload and is per browser. A collapsed column or checklist
is not a drop target, since there is nowhere visible to drop into.

## Archive and delete

Nothing on the board deletes anything outright. Boards, columns and tasks each have an **archive**
button, which takes them off the board and parks them under **Archive** in the sidebar. From there
each one can be **restored** or **deleted for good**, behind an inline confirm.

Two stages on purpose: archiving is one click and always reversible, while the irreversible step is
somewhere you have to go looking for.

Archived rows can be worked on together. Tick the box on any row, or the one in the bar to take
everything, then **Restore** or **Delete** the lot behind a single confirm. Boards are deleted first
so a cascade cleans up anything else that was picked underneath, and deleting a row a cascade already
removed is a no-op. The selection is dropped whenever you act on it or leave the archive.

- Archiving a **column** takes its tasks with it, and a **board** takes its columns and their tasks.
  They are not listed separately in the archive — they come back together.
- Restoring only puts something back if what it sits in is not archived too. Restore the board
  first, then the column.
- **Deleting cascades**: a board takes its columns and every task in them, a column takes its tasks.
  This one cannot be undone.
- Checklists and steps are part of their task, so they have no separate archive. Their `X` deletes
  them directly, and they come back with the task if it is restored.

Archiving stamps an `archivedAt` date rather than moving rows, so the schema does not change and
nothing is copied anywhere. An absent `archivedAt` simply means active.

## Filtering

**Active only** hides completed notes, and also hides any column whose tasks are *all* completed —
finished columns get out of the way. A column with no tasks at all stays put, so there is still
somewhere to drop things.

## Templates

New boards are created from a template rather than from a fixed seed, so the app starts empty.
Templates live in `src/templates.ts` as plain data — a board name, a description, and the columns
and notes to create. Add an entry to `boardTemplates` and it shows up in the create dialog.

Current templates: Blank, Sprints, Kanban, Weekly.

## Storage

The database layer lives in `src/db.ts` and the UI should use that boundary rather than reaching
into IndexedDB directly. The schema is versioned:

- **v1** — flat categories and notes
- **v2** — adds the board level above categories, backfills `items` on every note
- **v3** — used to be a one-time wipe of the old demo data. The wipe is gone, the version stays
- **v4** — folds each note's flat `items` array into a named checklist, so a note can hold several
- **v5** — gave every step its own `checklists` array, sub steps were a group of their own then
- **v6** — drops that again, a step owns its sub steps directly
- **v7** — `updatedAt` on boards and columns, and the `deletions` table

Version 3 cleared every table. That had long since served its purpose, and what it did instead was
sit waiting for any database still on v1 or v2 to open the app and lose everything in it. A board
served from a different origin is exactly that — IndexedDB is per origin, so one you have not
opened in a while never moved past v2. The upgrade is gone and the version number stays, so the
chain from v2 upward still lines up.

Boards and columns carry an `updatedAt` from v7, the same as notes always did. It is what sync
compares to work out whose copy is newer, so a write that skips it looks like no write at all —
which is why `updateBoard` and `updateColumn` in `src/db.ts` exist and the tables are not written
to directly.

**Deleting for good writes a tombstone.** A row that is deleted is otherwise just an absence, and
an absence looks exactly like a row the other side has not been told about yet, so without one the
next pull hands the deleted row straight back. `deletions` holds the id, what kind of row it was,
and when it went. Archiving needs none of this — it is a stamp on a row that is still there, so it
travels like any other edit.

## Import and export

**Import & export** in the sidebar moves boards off this browser and back again. The database is
three flat tables, but a board only means anything with its columns and their notes attached, so
`src/transfer.ts` works on that tree rather than the tables.

Pick any boards, or all of them, and pick a format:

- **JSON** — the whole tree, exactly as it is. The only one that imports back in.
- **CSV** — a row per task for a spreadsheet. Checklists ride along as indented text in one cell,
  and anything opening with `=` gets an apostrophe in front so it lands as text, not a formula.
- **Markdown** — headings down to the task, steps as `- [x]` items. For pasting into notes or a repo.

Archived columns and tasks are left out unless you switch them in, so what you hand over is the
board as it looks now. An archived board you tick explicitly still exports.

The file downloads as `taskboard-<board>-<date>.<ext>`. **Copy** puts the same text on the
clipboard instead, for when a download is awkward — an embedded browser, say.

Import takes the JSON one back. Drop the file on the zone, pick it, or paste its contents. It is
parsed before anything is written, so you choose which of the boards in it to take, and a hand
edited or older file falls back field by field rather than failing outright. Everything lands as
new boards with fresh ids at the bottom of the sidebar — nothing already there is touched — and a
name that is taken comes in as `(imported)`.

## Server storage

**Sync** in the sidebar is where a key is made, and after that it looks after itself. Boards still
live in this browser and are still read and written there — the server holds a copy, and every
device holding a key converges on it without anybody importing or exporting anything.

What makes it go:

| When | What |
| --- | --- |
| you stop typing | 2.5s later the tree goes up |
| every 15 seconds | a pull, to see what the other devices did |
| coming back to the tab | a pull on focus and on becoming visible, since a background tab has its timers cut to about one a minute and will be behind |
| coming back online | a full sync, which drains whatever piled up while it was off |

A push is the **whole tree**, not a delta. That is what makes the timing forgiving: a missed nudge
delays an edit, it never loses one. Local writes are noticed through Dexie's table hooks rather
than by having every caller remember to say so, because the bridge writes the same tables an agent
does and a new caller added later would be missed.

Nothing is applied while you are **dragging** something. A drag renumbers a whole column, and a
pull landing halfway through would be writing rows to positions that are still moving.

There is no login, no email and nothing to reset. A **key** is the whole of it: hold one and you
get the boards under it. Only the hash is stored, so the server cannot look one up, mail it to you
or hand it back — not even to you.

### Two ways onto a second device

They are for different devices, which is why there are two:

- **The key itself** — long lived, kept in this browser, revealed and copied when you want another
  machine or an agent on it. This is the one worth writing down. It is masked until you ask, and
  read out of `localStorage` rather than fetched, because there is nowhere to fetch it from.
- **A pairing code** — six digits, five minutes, one use. For the phone, where typing out a
  47 character key is the reason you would give up. Device one asks for a code, you read it out,
  device two types it in.

What claiming a code hands over is **not** the first device's key — the server has never seen it —
but a **new key on the same account**. So every device holds its own, and revoking one does not
touch the others. Give the MCP connector its own and you can kill the agent's access without
touching your phone.

Six digits sounds thin. What keeps it safe is that it dies in five minutes, works once, burns out
after five wrong guesses, and the api caps how fast any one caller can guess at all. The last key
on an account cannot be revoked, since that would strand every board under it.

An **account** here is an id and nothing else — no name, no email, no password. It exists so that
several keys can point at one pile of boards.

```bash
npm run dev                      # the board and the sync api together, which is all it takes
npm run test:sync                # the round trip, the api, and two devices converging
```

`npm run dev` runs both halves: vite on 5173 and the api on 4320, with **vite proxying `/api`
across** so the board sees one origin exactly as it does in the container. There is nothing to
configure and no live server involved — a key made in dev is made on your own machine, in
`./data/taskboard.db`, and you can delete it and start again whenever you like.

`npm run dev:web` and `npm run sync` are the two halves on their own if you want them in separate
terminals.

The routes, all under `/api`. The key goes in an `x-taskboard-key` header, never in the url, where
it would land in every log along the way:

| Route | Key needed | What |
| --- | --- | --- |
| `POST /keys` | no | makes an account and hands back its first key |
| `POST /pairings/claim` | no | six digits in, a new key on that account back |
| `POST /pairings` | yes | opens a code, five minutes, one use |
| `GET /keys` | yes | the devices on this account |
| `DELETE /keys/:id` | yes | throws one off. Never the last one |
| `GET /boards` | yes | every board under that account |
| `PUT /boards` | yes | pushes boards up |

Only the two pairing-free routes can be reached without a key, and the claim route is the one that
is rate limited by caller as well as by code.

### It is the export format

`GET /api/boards` answers with a Taskboard export file — the same wrapper `src/transfer.ts` writes,
down to the `app` and `exportedAt` fields. So a curl of that endpoint saved to disk imports back
into the app through the ordinary **Import & export** panel, and a file you exported months ago
pushes straight up here with no converter in between.

That is the reason the server schema mirrors the browser's rather than being designed on its own:
three tables with the same field names, and `checklists` left as json on the note exactly as Dexie
holds it. A shape of its own would mean two schemas drifting apart and a translation layer in the
middle keeping them honest. An older file with no `updatedAt` above the note is read field by
field like an import is, and falls back to when the row was made — not to now, which would make
every row in an old export the newest thing on the server and have it win every conflict.

### Nothing is removed by accident

**A push only adds and updates.** Send two boards when the server holds five and the other three
are still there afterwards. There is no route that replaces a key's boards wholesale, because a
client that is halfway through its first sync, or that only knows about one board, would take out
everything it had not heard of.

Removal only happens through an explicit deletion, carried in the same `PUT` as a `deletions`
array. Those apply before the writes — a device catching up sends both, and writing first would
only have the rows taken back out again. Two guards on it:

- a row deleted after an edit does not come back to life when that edit is pushed again
- a delete does **not** take a row edited after it, so a tombstone sat in an offline queue cannot
  quietly remove work done elsewhere in the meantime

Whoever wrote last wins, compared on `updatedAt`, and the same stamp on both sides counts as the
same edit and is left alone rather than written again.

### Before you put it anywhere

There is no TLS and no rate limiting yet, and a key is a bearer token — anything holding it is you.
On a LAN behind the proxy that is the same deal the rest of the app already makes. On the open
internet it is not, so do not put it there yet.

The store is one sqlite file on a volume, `./data/taskboard.db` by default and `TASKBOARD_STORE`
to move it. It is the one thing in the stack that cannot be rebuilt from the repo, so it is the one
thing worth backing up.

## Hosting it on Unraid

The app is a pile of static files. There is no server, no API and no database on the host, so any
static web server will do.

### Read this before you set it up

**Hosting does not share your data on its own.** Serving the app from Unraid means every device can
load it, and each one still gets its own separate taskboard in its own IndexedDB. What joins them
up is a key and the Sync panel above, not the hosting. Without one, everything lives in the
browser's IndexedDB on whatever device you are looking at. Serving the app from Unraid means every device can *load* it, but each one gets
its own separate, empty taskboard. Nothing syncs and nothing is backed up on the server. If what you
want is one taskboard you can reach from the sofa and the desk, this alone will not give you that —
that needs a real backend, which this project does not have.

**IndexedDB is scoped to the exact origin.** `http://taskboard.lan` and `http://192.168.1.50:8080`
are different origins, so they hold different data. Pick one address and stick to it, or it will
look like your boards vanished.

### Build and serve

```bash
docker compose up -d --build
```

That builds the static files and serves them with nginx on port 8080. Nothing else runs in
the container - there is no API and no database. On Unraid either use the
**Docker Compose Manager** plugin pointed at a clone of this repo, or build the image once and add a
container by hand. If you would rather not build on the server, run `npm run build` on your desktop
and mount the resulting `dist/` into any static web container instead:

```
/mnt/user/appdata/taskboard/dist  ->  /usr/share/nginx/html   (read only)
```

### The custom hostname

The container does not care what name you use — the name has to come from whatever answers DNS on
your LAN. Pick one:

1. **Your router, Pi-hole or AdGuard Home** (best, works on every device). Add an A record or DNS
   rewrite pointing your chosen name at the Unraid box's IP. In AdGuard that is *Filters → DNS
   rewrites*; in Pi-hole, *Local DNS → DNS Records*. Then browse to `http://taskboard.lan:8080`.
2. **Nginx Proxy Manager** (an Unraid Community App) if you want it on port 80 with no port in the
   URL, or several apps behind one name. Point the proxy host at `unraid-ip:8080`.
3. **A hosts file entry** on one machine, for a quick try. Does not scale past that machine.

Two naming traps worth avoiding:

- **Do not use `.local`.** It is reserved for mDNS/Bonjour, and normal DNS records under it behave
  erratically, especially on macOS and iOS.
- **Do not invent a TLD that turns out to be real.** `.dev` is a real, HSTS preloaded TLD, so
  browsers force HTTPS on it and a plain http host will simply refuse to load. `.lan` is the common
  choice, and `.home.arpa` is the one actually reserved for this (RFC 8375).

### About HTTPS

Plain http over your LAN is fine here, and the app is built to work that way — but that took a
deliberate fix worth knowing about. `crypto.randomUUID()`, which minted every id in the app, only
exists in a **secure context**. `http://localhost` counts as one; `http://taskboard.lan` does not.
Served over plain http on a hostname, `crypto.randomUUID` is `undefined` and *nothing can be
created at all* — no boards, columns, tasks or steps. `newId()` in `src/db.ts` now falls back to
`crypto.getRandomValues`, which has no such restriction. Keep using it rather than reaching for
`crypto.randomUUID` directly, or self hosting breaks again.

If you do want HTTPS anyway, put it on the reverse proxy, not this container.

### One more thing

The stylesheet pulls DM Sans and Space Grotesk from Google Fonts, so a machine with no internet
falls back to system fonts. Everything still works, it just looks different. Inline the fonts if
that matters to you.

## Still missing

Renaming a board.

## Agents

The board can be driven by an AI agent: it reads what is there, adds boards, columns and
tasks, adds checklist steps under other steps, ticks things off and archives them.

The connector is a plain MCP server over stdio, so anything that speaks MCP can drive the
board - Claude Code, Cursor, Zed, VS Code, your own script. Claude Code is the worked example
below because it can wire itself up.

Open **Connect Agents** in the sidebar and it walks you through it, checking each step as it
happens rather than just telling you what to type.

The board hands you the connector, one file with no dependencies. Save it anywhere, then tell
your agent where it went:

```
Add the taskboard-connector.mjs I just saved in my Downloads as an mcp server called taskboard
```

Or add it by hand. Most MCP clients take the same block, in their own config or in a project
`.mcp.json`:

```json
{ "mcpServers": { "taskboard": { "command": "node", "args": ["C:/Users/you/Downloads/taskboard-connector.mjs"] } } }
```

Claude Code has a one liner for it:

```bash
claude mcp add taskboard -- node "C:/Users/you/Downloads/taskboard-connector.mjs"
```

A shortcut like `~` or `%USERPROFILE%` will not do. node is run straight rather than through a
shell, so it would be handed over as literal text.

Then start a new agent session so it picks the tools up, and switch on **Agent access** in the
walkthrough.

### Leaving it running

Two different things stop a board left running unattended: the browser putting the **tab** to
sleep, and the machine putting the **display** to sleep. There is a switch for each under agent
access, and both only do anything while agent access is on. `src/awake.ts` holds the pair as
`useStayAwake(keepTab, keepScreen)`.

**Keep this tab awake** is the one that matters for an agent, because it is the one that carries
on while you are looking at something else. There is no API for "leave this tab alone", but no
browser throttles, freezes or discards a tab that is playing audio, so that is what it holds: a one
second loop built as a WAV blob at run time, 8kHz mono, a 30Hz tone at about -46 dBFS peak and
-49 dBFS RMS. Too low for a speaker to reproduce, and comfortably above the -72 dBFS a browser
counts as silence. Exactly 30 cycles fit the second so the loop comes round without a click, and
there is no audio asset to ship.

Two costs, both said on the switch: the tab shows the speaker icon while it runs, and nothing
plays until the page has had a gesture. Flipping the switch is one, but the setting is remembered,
so after a reload it waits and the chip says to click. It works over plain http.

**Keep the screen awake** takes a screen wake lock, which stops the display sleeping and taking the
machine with it. It is only held while this is the tab you are looking at - the browser hands it
straight back when you switch away, which is why it is no use for the background case on its own -
and it needs a secure context, so it does nothing on a self hosted board over plain http. It
listens for the release event rather than assuming it still holds the lock, since battery saver
takes it too.

### Not getting the tab put to sleep

Throttling is handled (see below), but a browser can also close a background tab down entirely to
save memory. The way round that is not a setting at all: **give the board its own window**. The tab
on top of its own window counts as visible even when the window is behind everything else, so
nothing throttles it, nothing discards it, and the screen lock keeps working.

If it has to live among your other tabs, Connect Agents prints the exemption for the browser you
are actually in. `src/browser.ts` works out which that is and holds what each one needs:

| Browser | Where | What |
| --- | --- | --- |
| Chrome | `chrome://settings/performance` | Memory Saver → Always keep these sites active |
| Edge | `edge://settings/system` | Sleeping tabs → Never put these sites to sleep |
| Brave | `brave://settings/performance` | Memory Saver → Always keep these sites active |
| Opera, Vivaldi, other Chromium | its own settings | search for memory, snooze or hibernate |
| Firefox | `about:config` | `browser.tabs.unloadOnLowMemory` → false. No per site list, so it is all or nothing |
| Safari | nothing to do | it does not discard tabs this way |

Detection is user agent order of business - nearly all of them still say `Chrome` somewhere, so
Firefox, `Edg/`, `OPR/` and `Vivaldi` are checked before it. Brave is the awkward one: its user
agent is deliberately identical to Chrome's and the only tell is `navigator.brave`. None of those
settings pages open from a link, so the path is handed over as text to paste with a copy button.

### How it hangs together

Everything still lives in the browser. A small connector holds the work the agent has queued,
the open tab pulls it and applies it through the same builders the UI uses, then posts the board
back so the agent can read it. Nothing is written to disk.

How it pulls depends on whether you are looking at it. In front, it asks every couple of seconds,
the way it always did. In the background it asks the connector to **hold the poll open** for up to
25 seconds instead, and the connector answers it the instant an agent queues anything.

That is not a nicety. A tab you are not looking at has its timers cut to roughly one a minute by
the browser, so `setInterval` polling is exactly what made an agent time out on a board buried in a
pile of tabs. A request held open is not a timer, so throttling does not touch it. Clicking back to
the tab aborts the held poll and catches up on the spot rather than waiting it out.

`GET /ops` takes an optional `?wait=<ms>`, capped at 30s, and `/health` advertises `waits: true`.
Both halves check for it, so an old board with a new connector and a new board with an old
connector both still work - they just fall back to polling. **If you saved the connector before
this, save it again**; Connect Agents says so when it sees an old one answering. A tab sat on a
held poll counts as listening, so ops queued while it waits are accepted rather than refused, and
`run()` now tells the difference between no tab at all and a tab that is there but throttled.

The connector runs **inside the MCP server's own process**, which is why nobody has to start
it. Whichever agent session gets the port hosts it and the rest share it. It binds to
loopback on `127.0.0.1:4319` and there is no remote mode, so the agent and the browser have
to be on the same computer.

The tab has to be open for changes to land. If it is not, the tools say so rather than
failing quietly.

- `bridge/mcp.mjs` all of it, the connector and the MCP server. one file with no imports,
  because the app serves a copy of it straight out of the bundle
- `src/bridge.ts` the board's half, the loop and the ops
