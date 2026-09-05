// Talking to the bridge. Shared by the MCP server and the CLI so both behave the same.

const BASE = (process.env.TASKBOARD_BRIDGE ?? "http://127.0.0.1:4319").replace(/\/$/, "");

const offline = (error) => ({
  ok: false,
  message: `Cannot reach the Taskboard bridge at ${BASE} (${error.message}). Start it with: npm run bridge`,
});

export async function health() {
  try {
    return await (await fetch(`${BASE}/health`)).json();
  } catch (error) { return offline(error); }
}

// lets the board's walkthrough show that Claude has the tools, nothing depends on it
export async function announce() {
  try { await fetch(`${BASE}/hello`, { method: "POST" }); } catch { /* not up yet, fine */ }
}

export async function state() {
  try {
    return await (await fetch(`${BASE}/state`)).json();
  } catch (error) { return offline(error); }
}

// queue an op, then hang about for the tab to apply it. the tab polls every couple of
// seconds, so a few seconds of waiting is normal rather than a sign anything is wrong
export async function run(op, waitMs = 12_000) {
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

  return { ok: false, message: "The board did not answer in time. Is the tab still open?" };
}
