// Keeping the tab awake while an agent is working.
//
// A tab you are not looking at gets its timers cut right back, and can be frozen or closed
// down altogether to save memory. There is no api for "leave this tab alone" - the screen
// wake lock is not it, that one is handed straight back the moment you look at something
// else. What every browser does leave alone is a tab that is playing something, throttling,
// freezing and discarding all skip it, so that is what this holds: a loop quiet enough not
// to hear and loud enough that the browser counts it as playing. The tab shows the speaker
// icon while it runs, which is the cost of it and is said on the switch rather than hidden.
//
// The screen lock is the other half and its own switch, since it does a different job: it
// stops the display sleeping and taking the machine with it. It only counts while you are
// looking at the tab, and it needs a secure context, so it is the half that does nothing
// over plain http. The tab half works anywhere and works while you are elsewhere.

import { useEffect, useState } from "react";

export type AwakeState = {
  // off, running, waiting on a click to be allowed to start, or refused outright
  tab: "off" | "awake" | "waiting" | "blocked";
  // whether the display is being held open as well, which only happens while tab is in front
  screen: boolean;
};

// a one second mono wav holding a 30Hz tone at about -46dBFS. lower than a speaker will
// reproduce and well above the level a browser counts as silence, which is the line it draws
// between a tab that is playing something and one that is not. exactly 30 cycles fit the
// second, so the loop comes round without a click
function quietLoop() {
  const rate = 8000;
  const frames = rate;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const tag = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i));
  };

  tag(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, frames * 2, true);

  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 30 * 2 * Math.PI) * 160), true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

// the two are separate switches doing separate jobs, so they are separate arguments
export function useStayAwake(keepTab: boolean, keepScreen: boolean): AwakeState {
  const [tab, setTab] = useState<AwakeState["tab"]>("off");
  const [screen, setScreen] = useState(false);

  // the tab half. this is the one that works while you are looking at something else
  useEffect(() => {
    if (!keepTab) { setTab("off"); return; }

    let stopped = false;
    const url = quietLoop();
    const sound = new Audio(url);
    sound.loop = true;

    // nothing plays without a gesture behind it. flipping the switch is one, but the setting
    // is remembered, so a reload comes back without one and has to wait for the next click
    function start() {
      if (stopped) return;
      sound.play().catch(() => { if (!stopped) setTab("waiting"); });
    }

    const onPlay = () => { if (!stopped) setTab("awake"); };
    // the browser can take it back as well as refuse it, so follow the element rather than
    // assume the last play() is still true
    const onStop = () => { if (!stopped) setTab("waiting"); };
    const onGesture = () => { if (sound.paused) start(); };

    sound.addEventListener("play", onPlay);
    sound.addEventListener("pause", onStop);
    sound.addEventListener("error", () => { if (!stopped) setTab("blocked"); });
    document.addEventListener("pointerdown", onGesture);
    document.addEventListener("keydown", onGesture);
    start();

    return () => {
      stopped = true;
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("keydown", onGesture);
      sound.removeEventListener("play", onPlay);
      sound.removeEventListener("pause", onStop);
      sound.pause();
      sound.src = "";
      URL.revokeObjectURL(url);
    };
  }, [keepTab]);

  // and the screen half, which only holds while this is the tab you are looking at
  useEffect(() => {
    if (!keepScreen || !("wakeLock" in navigator)) { setScreen(false); return; }

    let stopped = false;
    let lock: WakeLockSentinel | null = null;

    async function take() {
      if (stopped || lock || document.visibilityState !== "visible") return;
      try {
        const held = await navigator.wakeLock.request("screen");
        if (stopped) { held.release().catch(() => {}); return; }
        lock = held;
        // it gets handed back on its own, hiding the tab and battery saver both do it
        held.addEventListener("release", () => { lock = null; if (!stopped) setScreen(false); });
        setScreen(true);
      } catch { if (!stopped) setScreen(false); }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") take(); else setScreen(false);
    }

    take();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      lock?.release().catch(() => {});
      lock = null;
    };
  }, [keepScreen]);

  return { tab, screen };
}
