// Keeping the screen on while an agent is working. The board polls every couple of seconds,
// which is no use if the display has gone to sleep and taken the machine down with it.
//
// Two things this is not. It does not keep a hidden tab running - the browser takes the lock
// back the moment you switch away, and it will not hand it over again until you are looking
// at the tab, so a minimised board still gets its timers throttled. And it needs a secure
// context, the same as crypto.randomUUID, so a board self hosted over plain http will not
// have the api at all. Both of those are said out loud in Connect Agents rather than left
// as a switch that quietly does nothing.

import { useEffect, useState } from "react";

export type AwakeState = "off" | "held" | "paused" | "blocked" | "unsupported";

export const canStayAwake = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

export function useStayAwake(active: boolean): AwakeState {
  const [state, setState] = useState<AwakeState>(() => (canStayAwake() ? "off" : "unsupported"));

  useEffect(() => {
    if (!canStayAwake()) { setState("unsupported"); return; }
    if (!active) { setState("off"); return; }

    let stopped = false;
    let lock: WakeLockSentinel | null = null;

    async function take() {
      if (stopped || lock || document.visibilityState !== "visible") return;
      try {
        const held = await navigator.wakeLock.request("screen");
        // the switch can go off while the request is still in flight
        if (stopped) { held.release().catch(() => {}); return; }
        lock = held;
        // the browser can hand it back whenever it likes, battery saver included, so listen
        // for that rather than assuming we still have it
        held.addEventListener("release", () => {
          lock = null;
          if (!stopped) setState(document.visibilityState === "visible" ? "blocked" : "paused");
        });
        setState("held");
      } catch {
        lock = null;
        if (!stopped) setState("blocked");
      }
    }

    // leaving the tab drops the lock on its own, coming back has to ask for it again
    function onVisibility() {
      if (document.visibilityState === "visible") take();
      else setState("paused");
    }

    take();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      lock?.release().catch(() => {});
      lock = null;
    };
  }, [active]);

  return state;
}
