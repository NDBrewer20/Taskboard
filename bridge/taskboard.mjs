// The same thing from a terminal. Handy for a hook, for a quick check that the bridge is
// wired up, or for an assistant that would rather shell out than speak MCP.
//
//   node bridge/taskboard.mjs status
//   node bridge/taskboard.mjs task add "Sprint 1" "Fix the login redirect" --steps "repro,patch,test"
//   node bridge/taskboard.mjs done "Fix the login redirect"

import { health, run, state } from "./client.mjs";

// --flag value pairs come off the end, whatever is left is positional
function parse(argv) {
  const flags = {};
  const words = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word.startsWith("--")) { flags[word.slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index]; }
    else words.push(word);
  }
  return { words, flags };
}

const list = (value) => (value ? String(value).split(",").map((part) => part.trim()).filter(Boolean) : undefined);

function report(result) {
  console.log(result.ok ? result.message ?? "Done." : `x ${result.message ?? "That did not work."}`);
  process.exitCode = result.ok ? 0 : 1;
}

const { words, flags } = parse(process.argv.slice(2));
const [command, ...rest] = words;

// board, column, task and step take a sub command, the rest are a word on their own
const grouped = ["board", "column", "task", "step"];
const key = grouped.includes(command) && rest[0] ? `${command} ${rest[0]}` : command ?? "";
const args = grouped.includes(command) ? rest.slice(1) : rest;

const usage = `taskboard <command>

  status                          is the bridge up, is a board listening
  board                           print the board as json
  board add <name>
  column add <name>               --board <name>
  task add <column> <title>       --desc <text> --steps "a,b,c" --checklist <name> --board <name>
  step add <task> <text>          --under <step> --checklist <name>
  done <task>                     --step <step> --undo
  archive <task>`;

switch (key) {
  case "status": {
    const up = await health();
    if (!up.ok) { console.log(`x ${up.message}`); process.exitCode = 1; break; }
    console.log(`bridge up on ${up.port}, board ${up.listening ? `connected (${up.board ?? "unnamed"})` : "not connected"}`);
    break;
  }

  case "board": {
    const board = await state();
    console.log(JSON.stringify(board, null, 2));
    process.exitCode = board.ok ? 0 : 1;
    break;
  }

  case "board add":
    report(await run({ type: "createBoard", name: args[0] }));
    break;

  case "column add":
    report(await run({ type: "createColumn", name: args[0], board: flags.board }));
    break;

  case "task add":
    report(await run({
      type: "createTask", column: args[0], title: args[1], description: flags.desc,
      steps: list(flags.steps), checklist: flags.checklist, board: flags.board,
    }));
    break;

  case "step add":
    report(await run({ type: "addStep", task: args[0], text: args[1], under: flags.under, checklist: flags.checklist }));
    break;

  case "done":
    report(await run({ type: "complete", task: args[0], step: flags.step, done: !flags.undo }));
    break;

  case "archive":
    report(await run({ type: "archiveTask", task: args[0] }));
    break;

  default:
    console.log(usage);
    process.exitCode = command ? 1 : 0;
}
