// Which browser this is, and what it takes to stop it putting the board to sleep.
//
// Every one of them does the same thing under a different name - memory saver, sleeping
// tabs, tab unloading - and keeps the exemption in its own place. None of those pages can
// be linked to either, a chrome:// or about: url will not open from a page, so the path is
// handed over as text to paste into the address bar rather than as a link.

export type BrowserGuide = {
  id: string;
  name: string;
  // the settings page to paste in, where there is one worth naming
  settings?: string;
  // what to do once it is open
  steps: string[];
  // whether what it opens on is a list of sites to leave alone, or one switch for the lot
  perSite?: boolean;
  // where there is no exemption list at all, which is worth saying rather than inventing one
  note?: string;
};

// chrome, edge and brave are the ones with a real per site list. the rest of the chromium
// family keeps moving theirs about, so they get pointed at their own settings and a word to
// search for rather than a path that might not be there
const guides: Record<string, BrowserGuide> = {
  chrome: {
    id: "chrome", name: "Chrome",
    settings: "chrome://settings/performance",
    steps: ["Find Memory Saver.", "Add this site under “Always keep these sites active”."],
    perSite: true,
  },
  edge: {
    id: "edge", name: "Edge",
    settings: "edge://settings/system",
    steps: ["Find Sleeping tabs.", "Add this site under “Never put these sites to sleep”."],
    perSite: true,
    note: "Efficiency mode can slow background tabs down on its own, so check that too if it is on.",
  },
  brave: {
    id: "brave", name: "Brave",
    settings: "brave://settings/performance",
    steps: ["Find Memory Saver.", "Add this site under “Always keep these sites active”."],
    perSite: true,
  },
  opera: {
    id: "opera", name: "Opera",
    settings: "opera://settings",
    steps: ["Search the settings for “memory” or “snooze”.", "Turn it off, or add this site to whatever list it offers."],
    perSite: true,
  },
  vivaldi: {
    id: "vivaldi", name: "Vivaldi",
    settings: "vivaldi://settings",
    steps: ["Settings also opens with ctrl+f12.", "Search it for “hibernate” and leave background tabs out of it."],
  },
  chromium: {
    id: "chromium", name: "your browser",
    steps: ["Open its settings and search for “memory” or “sleep”.", "Most Chromium browsers keep this on a Performance page, as a list of sites to leave alone."],
    perSite: true,
  },
  firefox: {
    id: "firefox", name: "Firefox",
    settings: "about:config",
    steps: ["Search for browser.tabs.unloadOnLowMemory.", "Set it to false."],
    note: "Firefox has no per site list. It only unloads tabs when the machine is short of memory, so this is all or nothing.",
  },
  safari: {
    id: "safari", name: "Safari",
    steps: [],
    note: "Nothing to switch off. Safari does not discard tabs the way the others do, so just leave the window open.",
  },
  unknown: {
    id: "unknown", name: "your browser",
    steps: ["Look through its settings for tab sleeping, discarding or memory saving, and leave this site out of it."],
  },
};

// nearly all of them still say Chrome somewhere in the string, so the order is what does
// the work here. brave is the odd one out - its user agent is chrome's, deliberately, and
// the only thing that gives it away is the object it puts on navigator
export function browserGuide(
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  isBrave: boolean = typeof navigator !== "undefined" && "brave" in navigator,
): BrowserGuide {
  const has = (needle: string) => agent.includes(needle);

  if (has("Firefox/") || has("FxiOS/")) return guides.firefox;
  if (has("Edg/") || has("EdgA/") || has("EdgiOS/")) return guides.edge;
  if (has("OPR/") || has("Opera")) return guides.opera;
  if (has("Vivaldi")) return guides.vivaldi;
  if (isBrave) return guides.brave;
  // chromium proper says both, chrome only says Chrome
  if (has("Chromium/")) return guides.chromium;
  if (has("Chrome/") || has("CriOS/")) return guides.chrome;
  if (has("Safari/")) return guides.safari;
  return guides.unknown;
}
