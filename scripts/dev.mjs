// Both halves in one terminal: vite on 5173 and the sync api on 4320, with vite proxying
// /api across so the board sees one origin exactly as it does in the container.
//
// No dependency for this - concurrently and npm-run-all are both a package to add for
// something node already does. Children are spawned straight rather than through npm, so
// there is no shell in the way and no npm.cmd business on windows.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const parts = [
  { name: "sync", args: ["server/api.mjs"], colour: "\x1b[36m" },
  { name: "vite", args: ["node_modules/vite/bin/vite.js"], colour: "\x1b[35m" },
];

const running = [];
let stopping = false;

// one prefixed line at a time, so two processes writing at once stay readable
function prefix(part, chunk) {
  const reset = "\x1b[0m";
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) console.log(`${part.colour}${part.name.padEnd(4)}${reset} ${line}`);
  }
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of running) child.kill();
  process.exit(code);
}

for (const part of parts) {
  const child = spawn(process.execPath, part.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);

  child.stdout.on("data", (chunk) => prefix(part, chunk));
  child.stderr.on("data", (chunk) => prefix(part, chunk));

  // if either half falls over the other is no use on its own, so they go together
  child.on("exit", (code) => {
    if (!stopping) console.log(`\n${part.name} stopped${code === null ? "" : ` (${code})`}, so stopping the rest.`);
    stopAll(code ?? 0);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
