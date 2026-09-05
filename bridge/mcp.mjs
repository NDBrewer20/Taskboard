// The native side of it. An MCP server over stdio, so Taskboard turns up as real tools in
// Claude Code rather than something it has to shell out to.
//
// It also hosts the connector the board talks to, in this same process, so there is nothing
// for anyone to start by hand. Two Claude sessions at once is fine, the first one to get the
// port hosts it and the rest just use it.
//
// Nothing goes on stdout except protocol messages, anything to say goes to stderr.

import { createInterface } from "node:readline";
import { announce, health, run, state } from "./client.mjs";
import { DEFAULT_PORT, startHub } from "./hub.mjs";

const NAME = "taskboard";
const VERSION = "1.0.0";

const text = (body) => ({ content: [{ type: "text", text: body }] });
const failed = (body) => ({ content: [{ type: "text", text: body }], isError: true });

// a task or a step is named the way you would say it out loud, the board resolves it
const target = { type: "string", description: "Name of the task, or its id. A partial name is fine as long as it only matches one." };

const tools = [
  {
    name: "taskboard_board",
    description: "Read the board: every column, task, and checklist step, with what is done. Start here so you know what exists before changing anything.",
    inputSchema: { type: "object", properties: {
      board: { type: "string", description: "Which board. Defaults to the one that is open." },
    } },
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
    }, required: ["task", "text"] },
  },
  {
    name: "taskboard_complete",
    description: "Tick a task off, or one of its checklist steps. Pass done: false to untick it again.",
    inputSchema: { type: "object", properties: {
      task: target,
      step: { type: "string", description: "Name of a step on that task. Leave out to tick the task itself." },
      done: { type: "boolean", description: "Defaults to true." },
    }, required: ["task"] },
  },
  {
    name: "taskboard_archive",
    description: "Archive a task. It leaves the board but nothing is deleted, it can be restored.",
    inputSchema: { type: "object", properties: { task: target }, required: ["task"] },
  },
];

// how an op comes back as something worth reading
function describe(result) {
  if (result.ok) return text(result.message ?? "Done.");
  return failed(result.message ?? "That did not work.");
}

async function call(name, args) {
  if (name === "taskboard_board") {
    const board = await state();
    if (!board.ok) return failed(board.message ?? "No board has connected yet. Open Taskboard and switch on Claude access.");
    return text(JSON.stringify(board, null, 2));
  }

  const op = {
    taskboard_add_board: () => ({ type: "createBoard", name: args.name }),
    taskboard_add_column: () => ({ type: "createColumn", name: args.name, board: args.board }),
    taskboard_add_task: () => ({ type: "createTask", ...args }),
    taskboard_add_step: () => ({ type: "addStep", ...args }),
    taskboard_complete: () => ({ type: "complete", ...args }),
    taskboard_archive: () => ({ type: "archiveTask", task: args.task }),
  }[name];

  if (!op) return failed(`No tool called ${name}.`);
  return describe(await run(op()));
}

// --- hosting the connector ---

let hosting = false;

// whoever holds the port is the host. if they go away, the next tool call picks it up
async function ensureHub() {
  if (hosting) return;
  const started = await startHub(DEFAULT_PORT, "127.0.0.1");
  if (started.ok) { hosting = true; console.error(`taskboard mcp: hosting the connector on ${DEFAULT_PORT}`); }
}

// --- the protocol, newline delimited json-rpc over stdio ---

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const complain = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

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

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return complain(null, -32700, "Could not parse that"); }
  handle(message).catch((error) => complain(message.id ?? null, -32603, error.message));
});

// up front, so the board can connect the moment a Claude session starts
await ensureHub();
announce();

health().then((up) => {
  if (!up.ok) console.error(`taskboard mcp: ${up.message}`);
  else console.error(`taskboard mcp: connector on ${up.port}, board ${up.listening ? "connected" : "not connected yet"}`);
});
