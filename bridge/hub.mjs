// The bit in the middle, as something that can be started from anywhere.
//
// Taskboard keeps everything in the browser's IndexedDB and a terminal cannot reach that,
// so this holds the work Claude has queued, the open tab pulls it, applies it through the
// same code paths the UI uses, and posts back what happened. Nothing touches disk.
//
// The MCP server starts this in its own process, which is why nobody has to run anything.
// If the port is already taken, whoever has it is hosting and this just steps aside.

import { createServer } from "node:http";

export const DEFAULT_PORT = Number(process.env.TASKBOARD_PORT ?? 4319);

export function startHub(port = DEFAULT_PORT, host = process.env.TASKBOARD_HOST ?? "127.0.0.1") {
  // ops waiting for the tab, and what came back once it applied them
  const queue = [];
  const results = new Map();
  let snapshot = null;
  let snapshotAt = 0;
  let lastPoll = 0;
  let lastHello = 0;

  const now = () => Date.now();

  // the tab counts as listening if it has asked for work in the last few seconds
  const listening = () => now() - lastPoll < 6000;

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
      // what the walkthrough checks, and where it gets the path for its fallback commands
      if (route === "GET /health") {
        return send(response, 200, {
          ok: true, service: "taskboard-bridge", port,
          root: process.cwd(), listening: listening(), queued: queue.length,
          // set by whoever started the hub, so the walkthrough can say Claude is here
          mcp: now() - lastHello < 600_000,
          board: snapshot?.board ?? null, seenAt: snapshotAt || null,
        });
      }

      // the MCP server says hello on the way up, and whenever a tool is used
      if (route === "POST /hello") { lastHello = now(); return send(response, 200, { ok: true }); }

      // Claude reads the board here, by name, so it never has to know an id
      if (route === "GET /state") {
        if (!snapshot) return send(response, 200, { ok: false, listening: listening(), message: "No board has connected yet." });
        return send(response, 200, { ok: true, listening: listening(), at: snapshotAt, ...snapshot });
      }

      // Claude queues work here
      if (route === "POST /ops") {
        const body = await readBody(request);
        if (!body.type) return send(response, 400, { ok: false, message: "An op needs a type." });
        if (!listening()) return send(response, 200, {
          ok: false, pending: false,
          message: "No board is listening. Open Taskboard and switch on Claude access under Connect Claude.",
        });

        const op = { id: `op_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, at: now(), ...body };
        queue.push(op);
        return send(response, 200, { ok: true, pending: true, id: op.id });
      }

      // and waits here for the tab to say what happened
      if (route === "GET /result") {
        const id = url.searchParams.get("id");
        const result = id && results.get(id);
        if (!result) return send(response, 200, { ok: false, pending: true });
        return send(response, 200, { ...result, pending: false });
      }

      // the tab pulls its work, and says whether the snapshot needs refreshing
      if (route === "GET /ops") {
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
