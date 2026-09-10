// The whole agent side of Taskboard, in one file on purpose.
//
// It is an MCP server over stdio, so the board turns up as real tools rather than something
// the agent has to shell out to, and it hosts the connector the board talks to in this same
// process, so there is nothing for anyone to start by hand. Any MCP client can run it.
//
// One file because it gets handed around: the board offers you a copy of this to save
// wherever you like, and it has to run on its own with no folder around it and nothing
// installed. Node 18 or newer, no dependencies.
//
// It only ever talks to loopback. There is no remote mode and nothing to configure.
//
//   claude mcp add taskboard -- node <path to this file>
//
// or the same thing as a config block, which is what most other MCP clients take:
//
//   { "mcpServers": { "taskboard": { "command": "node", "args": ["<path to this file>"] } } }
//
// Nothing goes on stdout except protocol messages, anything to say goes to stderr.

import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const NAME = "taskboard";
const VERSION = "1.0.0";

// hardcoded on purpose. the board's half has the same number in it and cannot read env,
// so a port that only one side knows about would just break the connection quietly
export const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------------------------------------------------------------- the connector

   Taskboard keeps everything in the browser's IndexedDB and a terminal cannot reach that,
   so this holds the work the agent has queued, the open tab pulls it, applies it through the
   same code paths the UI uses, and posts back what happened. Nothing touches disk.

   If the port is already taken then another session is hosting, and this steps aside and
   uses that one instead. */

export function startHub(port = PORT, host = "127.0.0.1") {
  // ops waiting for the tab, and what came back once it applied them
  const queue = [];
  const results = new Map();
  let snapshot = null;
  let snapshotAt = 0;
  let lastPoll = 0;
  let lastHello = 0;

  // polls being held open, waiting for something to turn up for the tab
  const waiting = new Set();

  const now = () => Date.now();

  // the tab counts as listening if it has asked for work in the last few seconds, or if it
  // is sat on the line right now waiting for some
  const listening = () => waiting.size > 0 || now() - lastPoll < 6000;

  // lets go of every held poll, so work queued reaches the tab straight away
  const wake = () => { for (const release of [...waiting]) release(); };

  // holds one poll open until there is work, the wait runs out, or the tab goes away
  function hold(ms, request) {
    return new Promise((done) => {
      const release = () => {
        clearTimeout(timer);
        waiting.delete(release);
        request.off("close", release);
        done();
      };
      const timer = setTimeout(release, ms);
      waiting.add(release);
      request.on("close", release);
    });
  }

  function send(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      // a local sidecar, and the board can be served from a different port or host
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    response.end(payload);
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
        // nothing legitimate is this big, so stop reading rather than fill memory
        if (raw.length > 4_000_000) reject(new Error("body too large"));
      });
      request.on("end", () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("body was not json")); }
      });
      request.on("error", reject);
    });
  }

  // dropping anything the tab never got to, so a queue does not build up while it is closed
  function sweep() {
    const cutoff = now() - 120_000;
    while (queue.length && queue[0].at < cutoff) {
      const stale = queue.shift();
      results.set(stale.id, { ok: false, message: "Taskboard never picked this up.", at: now() });
    }
    for (const [id, result] of results) if (result.at && result.at < cutoff) results.delete(id);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const route = `${request.method} ${url.pathname}`;
    sweep();

    if (request.method === "OPTIONS") return send(response, 204, {});

    try {
      // what the walkthrough checks to know whether any of this is working
      if (route === "GET /health") {
        return send(response, 200, {
          ok: true, service: "taskboard-bridge", port,
          root: process.cwd(), listening: listening(), queued: queue.length,
          // the tab checks this before asking us to hold a poll open, so an older board
          // and a newer connector still work together, just by polling
          waits: true,
          // set by whoever started the hub, so the walkthrough can say an agent is here
          mcp: now() - lastHello < 600_000,
          board: snapshot?.board ?? null, seenAt: snapshotAt || null,
        });
      }

      // the MCP server says hello on the way up, and whenever a tool is used
      if (route === "POST /hello") { lastHello = now(); return send(response, 200, { ok: true }); }

      // the agent reads the board here, by name, so it never has to know an id
      if (route === "GET /state") {
        if (!snapshot) return send(response, 200, { ok: false, listening: listening(), message: "No board has connected yet." });
        return send(response, 200, { ok: true, listening: listening(), at: snapshotAt, ...snapshot });
      }

      // the agent queues work here
      if (route === "POST /ops") {
        const body = await readBody(request);
        if (!body.type) return send(response, 400, { ok: false, message: "An op needs a type." });
        if (!listening()) return send(response, 200, {
          ok: false, pending: false,
          message: "No board is listening. Open Taskboard and switch on Agent access under Connect Agents.",
        });

        const op = { id: `op_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, at: now(), ...body };
        queue.push(op);
        wake();
        return send(response, 200, { ok: true, pending: true, id: op.id });
      }

      // and waits here for the tab to say what happened
      if (route === "GET /result") {
        const id = url.searchParams.get("id");
        const result = id && results.get(id);
        if (!result) return send(response, 200, { ok: false, pending: true });
        return send(response, 200, { ...result, pending: false });
      }

      // the tab pulls its work here, and says whether the snapshot needs refreshing.
      //
      // it can ask us to hold the line rather than come back in a couple of seconds. a tab
      // that is not the one you are looking at has its timers cut to about one a minute by
      // the browser, which is what makes an agent time out waiting on a board buried in a
      // pile of tabs. a request held open is not a timer, so it gets answered either way
      if (route === "GET /ops") {
        lastPoll = now();
        const wait = Math.min(Number(url.searchParams.get("wait")) || 0, 30_000);
        if (wait > 0 && !queue.length) await hold(wait, request);
        // the tab may well have gone while we were holding, so nothing is taken off the
        // queue for a connection that is not there to receive it
        if (response.writableEnded || request.destroyed) return;

        lastPoll = now();
        const taking = queue.splice(0, queue.length);
        return send(response, 200, { ok: true, ops: taking, wantState: !snapshot || now() - snapshotAt > 10_000 });
      }

      // and posts back the board plus what each op did
      if (route === "POST /sync") {
        const body = await readBody(request);
        lastPoll = now();
        if (body.state) { snapshot = body.state; snapshotAt = now(); }
        for (const result of body.results ?? []) results.set(result.id, { ...result, at: now() });
        return send(response, 200, { ok: true });
      }

      return send(response, 404, { ok: false, message: `Nothing at ${url.pathname}` });
    } catch (error) {
      return send(response, 400, { ok: false, message: error.message });
    }
  });

  // either this process hosts it, or something already is and that is just as good
  return new Promise((resolve) => {
    server.once("error", (error) => resolve({
      ok: false,
      reason: error.code === "EADDRINUSE" ? "taken" : error.code ?? "failed",
    }));
    server.listen(port, host, () => resolve({ ok: true, port, host, server }));
  });
}

/* ---------------------------------------------------------------- talking to it */

const offline = (error) => ({
  ok: false,
  message: `Cannot reach the Taskboard connector at ${BASE} (${error.message}).`,
});

export async function health() {
  try { return await (await fetch(`${BASE}/health`)).json(); } catch (error) { return offline(error); }
}

// lets the board's walkthrough show that an agent is here, nothing depends on it
export async function announce() {
  try { await fetch(`${BASE}/hello`, { method: "POST" }); } catch { /* not up yet, fine */ }
}

export async function state() {
  try { return await (await fetch(`${BASE}/state`)).json(); } catch (error) { return offline(error); }
}

// queue an op, then hang about for the tab to apply it. the tab is sat on an open poll
// while it is in the background and polls every couple of seconds while it is not, so an
// answer normally comes back within a second either way
export async function run(op, waitMs = 20_000) {
  let queued;
  try {
    queued = await (await fetch(`${BASE}/ops`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op),
    })).json();
  } catch (error) { return offline(error); }

  if (!queued.ok) return queued;

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, 400));
    try {
      const result = await (await fetch(`${BASE}/result?id=${encodeURIComponent(queued.id)}`)).json();
      if (!result.pending) return result;
    } catch (error) { return offline(error); }
  }

  // no answer. a tab that is not there and a tab that is there but too throttled to answer
  // need different things doing about them, and the health check knows which this is
  const info = await health();
  if (info?.listening) return { ok: false, message:
    "The board is open but did not answer in time. If it is buried in a pile of tabs the browser "
    + "will have cut its timers right back - click the Taskboard tab to bring it to the front, or "
    + "save the connector again if you are on an older copy of it." };

  return { ok: false, message: "The board did not answer in time. Is the tab still open with Agent access on?" };
}

/* ---------------------------------------------------------------- the tools */

const text = (body) => ({ content: [{ type: "text", text: body }] });
const failed = (body) => ({ content: [{ type: "text", text: body }], isError: true });

// a task or a step is named the way you would say it out loud, the board resolves it
const target = { type: "string", description: "Name of the task, or its id. A partial name is fine as long as it only matches one." };

// and the board it sits on. left out it falls back to the open board, which is really just
// the first one in the sidebar - so anything working further down the list has to say which,
// or the task is looked for on the wrong board and either is not found or is the wrong one
const owner = { type: "string", description: "Which board the task is on. Defaults to the open board, the first one in the sidebar." };

export const tools = [
  {
    name: "taskboard_board",
    description: "Read a board: every column, task, and checklist step, with what is done. Start here so you know what exists "
      + "before changing anything. Leave the board out for the open one, or name any other board to read that instead.",
    inputSchema: { type: "object", properties: {
      board: { type: "string", description: "Which board to read. Defaults to the one that is open." },
    } },
  },
  {
    name: "taskboard_boards",
    description: "List every board with its columns and how many tasks sit in each. Use it to find the board or column name "
      + "you need before reading or changing anything, rather than guessing at one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "taskboard_add_board",
    description: "Create a board.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "taskboard_add_column",
    description: "Create a column on a board.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" },
      board: { type: "string", description: "Defaults to the open board." },
    }, required: ["name"] },
  },
  {
    name: "taskboard_add_task",
    description: "Add a task to a column, with an optional description and checklist steps.",
    inputSchema: { type: "object", properties: {
      column: { type: "string", description: "Name of the column it goes in." },
      title: { type: "string" },
      description: { type: "string" },
      steps: { type: "array", items: { type: "string" }, description: "Checklist steps, in order." },
      checklist: { type: "string", description: "Name for the checklist holding those steps. Defaults to Checklist." },
      board: { type: "string", description: "Defaults to the open board." },
    }, required: ["column", "title"] },
  },
  {
    name: "taskboard_add_step",
    description: "Add a checklist step to a task, or under one of its existing steps.",
    inputSchema: { type: "object", properties: {
      task: target,
      text: { type: "string" },
      under: { type: "string", description: "Name of a step this one indents under. Leave out for a top level step." },
      checklist: { type: "string", description: "Which checklist on the task. Defaults to the first one." },
      board: owner,
    }, required: ["task", "text"] },
  },
  {
    name: "taskboard_complete",
    description: "Tick a task off, or one of its checklist steps. Pass done: false to untick it again.",
    inputSchema: { type: "object", properties: {
      task: target,
      step: { type: "string", description: "Name of a step on that task. Leave out to tick the task itself." },
      done: { type: "boolean", description: "Defaults to true." },
      board: owner,
    }, required: ["task"] },
  },
  {
    name: "taskboard_archive",
    description: "Take a task, a column or a whole board off the board. Nothing is deleted - archived things sit in "
      + "the archive and come back with restore: true. Name one of task, column or board_name.",
    inputSchema: { type: "object", properties: {
      task: target,
      column: { type: "string", description: "Archive this column and the tasks in it, instead of a task." },
      board_name: { type: "string", description: "Archive this whole board, with its columns and their tasks." },
      restore: { type: "boolean", description: "Put it back on the board instead. A column or task only reappears if what it sits in is not archived too." },
      board: owner,
    } },
  },
  {
    name: "taskboard_rename_board",
    description: "Rename a board.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "The new name." },
      board: { type: "string", description: "Which board to rename. Defaults to the open board." },
    }, required: ["name"] },
  },
  {
    name: "taskboard_update_column",
    description: "Rename a column or change its colour.",
    inputSchema: { type: "object", properties: {
      column: { type: "string", description: "The column to change." },
      name: { type: "string", description: "The new name." },
      color: { type: "string", description: "One of coral, teal, gold, violet, sky." },
      board: owner,
    }, required: ["column"] },
  },
  {
    name: "taskboard_move_column",
    description: "Move a column left or right on its board. Index 0 is the leftmost.",
    inputSchema: { type: "object", properties: {
      column: { type: "string" },
      index: { type: "number", description: "Where it should end up, counting from 0." },
      board: owner,
    }, required: ["column", "index"] },
  },
  {
    name: "taskboard_update_task",
    description: "Change a task's title, its description, or what kind of note it is.",
    inputSchema: { type: "object", properties: {
      task: target,
      title: { type: "string", description: "The new title." },
      description: { type: "string", description: "The new description. An empty string clears it." },
      note_type: { type: "string", description: "One of checklist, direction, descriptor, idea." },
      board: owner,
    }, required: ["task"] },
  },
  {
    name: "taskboard_move_task",
    description: "Move a task to another column, or up and down within the one it is in.",
    inputSchema: { type: "object", properties: {
      task: target,
      column: { type: "string", description: "The column to move it to. Leave out to keep it where it is." },
      index: { type: "number", description: "Where in the column, counting from 0. Leave out for the bottom." },
      board: owner,
    }, required: ["task"] },
  },
  {
    name: "taskboard_add_checklist",
    description: "Put another named checklist on a task, so its steps can be grouped.",
    inputSchema: { type: "object", properties: {
      task: target,
      checklist: { type: "string", description: "What to call it." },
      board: owner,
    }, required: ["task", "checklist"] },
  },
  {
    name: "taskboard_update_step",
    description: "Reword a checklist step.",
    inputSchema: { type: "object", properties: {
      task: target,
      step: { type: "string", description: "The step as it reads now." },
      text: { type: "string", description: "What it should say instead." },
      board: owner,
    }, required: ["task", "step", "text"] },
  },
  {
    name: "taskboard_remove_step",
    description: "Take a checklist step off a task, along with any steps under it. A step is part of its task rather "
      + "than a row of its own, so there is no archive for it to sit in - this one really is gone. Archive the task "
      + "instead if you might want it back.",
    inputSchema: { type: "object", properties: {
      task: target,
      step: { type: "string", description: "The step to remove." },
      board: owner,
    }, required: ["task", "step"] },
  },
];

async function call(name, args) {
  // the open board is already cached here, so reading it costs nothing and works even
  // between polls. any other board only the tab can see, so that one goes down as an op
  if (name === "taskboard_board" && !args.board) {
    const board = await state();
    if (!board.ok) return failed(board.message ?? "No board has connected yet. Open Taskboard and switch on Agent access.");
    return text(JSON.stringify(board, null, 2));
  }

  const op = {
    taskboard_board: () => ({ type: "readBoard", board: args.board }),
    taskboard_boards: () => ({ type: "listBoards" }),
    taskboard_add_board: () => ({ type: "createBoard", name: args.name }),
    taskboard_add_column: () => ({ type: "createColumn", name: args.name, board: args.board }),
    taskboard_add_task: () => ({ type: "createTask", ...args }),
    taskboard_add_step: () => ({ type: "addStep", ...args }),
    taskboard_complete: () => ({ type: "complete", ...args }),
    // one tool for three levels, since "archive this" is the same thought whichever it is.
    // board_name rather than board, because board already means which board to look on
    taskboard_archive: () => ({
      type: args.board_name ? "archiveBoard" : args.column ? "archiveColumn" : "archiveTask",
      task: args.task, column: args.column, restore: args.restore === true,
      board: args.board_name || args.board,
    }),
    taskboard_rename_board: () => ({ type: "renameBoard", name: args.name, board: args.board }),
    taskboard_update_column: () => ({ type: "updateColumn", ...args }),
    taskboard_move_column: () => ({ type: "moveColumn", ...args }),
    taskboard_update_task: () => ({ type: "updateTask", ...args, noteType: args.note_type }),
    taskboard_move_task: () => ({ type: "moveTask", ...args }),
    taskboard_add_checklist: () => ({ type: "addChecklist", ...args }),
    taskboard_update_step: () => ({ type: "updateStep", ...args }),
    taskboard_remove_step: () => ({ type: "removeStep", ...args }),
  }[name];

  if (!op) return failed(`No tool called ${name}.`);
  const result = await run(op());
  if (!result.ok) return failed(result.message ?? "That did not work.");
  // an op that was a question hands back what was asked for, the rest just say what they did
  return text(result.data === undefined ? (result.message ?? "Done.") : JSON.stringify(result.data, null, 2));
}

/* ---------------------------------------------------------------- the protocol,
   newline delimited json-rpc over stdio */

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const complain = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

let hosting = false;

// whoever holds the port is the host. if they go away, the next tool call picks it up
async function ensureHub() {
  if (hosting) return;
  const started = await startHub();
  if (started.ok) { hosting = true; console.error(`taskboard: hosting the connector on ${PORT}`); }
}

async function handle(message) {
  const { id, method, params } = message;
  // notifications carry no id and want no answer
  if (id === undefined) return;

  if (method === "initialize") {
    return reply(id, {
      // agree to whatever the client speaks rather than insisting on one version
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
  }

  if (method === "tools/list") return reply(id, { tools });

  if (method === "tools/call") {
    await ensureHub();
    announce();
    try {
      return reply(id, await call(params?.name, params?.arguments ?? {}));
    } catch (error) {
      return reply(id, failed(error.message));
    }
  }

  if (method === "ping") return reply(id, {});

  return complain(id, -32601, `Unknown method ${method}`);
}

export async function serve() {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return complain(null, -32700, "Could not parse that"); }
    handle(message).catch((error) => complain(message.id ?? null, -32603, error.message));
  });

  // up front, so the board can connect the moment an agent session starts
  await ensureHub();
  announce();

  const up = await health();
  if (!up.ok) console.error(`taskboard: ${up.message}`);
  else console.error(`taskboard: connector on ${up.port}, board ${up.listening ? "connected" : "not connected yet"}`);
}

// only take over stdio when node was actually pointed at this file
const entry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (entry) serve();
