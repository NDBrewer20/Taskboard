// Running the connector on its own.
//
// You only need this when the board is not on the same machine as Claude Code, say the app
// is on a NAS and you want that box to host the connector. Normally the MCP server starts
// the same thing in its own process and there is nothing to run.

import { DEFAULT_PORT, startHub } from "./hub.mjs";

const host = process.env.TASKBOARD_HOST ?? "127.0.0.1";
const started = await startHub(DEFAULT_PORT, host);

if (started.ok) {
  console.log(`taskboard connector on http://${host}:${DEFAULT_PORT}`);
  console.log("open the board and switch on Claude access under Connect Claude");
} else if (started.reason === "taken") {
  console.log(`something is already hosting the connector on ${DEFAULT_PORT}, nothing to do`);
} else {
  console.error(`could not start the connector: ${started.reason}`);
  process.exitCode = 1;
}
