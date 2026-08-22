import { describe, expect, it } from "vitest";
import {
  MUTE_NOTICE,
  TAPS_TO_TOGGLE,
  TRIPLE_TAP_GAP_MS,
  TapRun,
  UNMUTE_NOTICE,
} from "../../app/aide/voice-engine";
import { SYSTEM_PROMPT } from "../../lib/agent/system";

// Three quick taps close Aide's microphone; three more open it. The user
// cannot see whether it worked, so the only feedback is what Aide says — which
// makes both the counting and the wording load-bearing.

const t = (base: number, ...gaps: number[]) => {
  const run = new TapRun();
  let now = base;
  const fired: number[] = [];
  // The first tap starts the run; each gap is the wait before the next one.
  if (run.register(now)) fired.push(now);
  for (const gap of gaps) {
    now += gap;
    if (run.register(now)) fired.push(now);
  }
  return fired;
};

describe("counting a run of taps", () => {
  it("takes exactly three, not two", () => {
    expect(TAPS_TO_TOGGLE).toBe(3);
    expect(t(1000, 100)).toEqual([]);
    expect(t(1000, 100, 100)).toEqual([1200]);
  });

  it("fires on the third tap and not a moment earlier", () => {
    const run = new TapRun();
    expect(run.register(0)).toBe(false);
    expect(run.register(100)).toBe(false);
    expect(run.register(200)).toBe(true);
  });

  it("allows an unhurried gesture, right up to the gap", () => {
    // Someone who cannot see the result of a tap does not rush the next one.
    expect(t(0, TRIPLE_TAP_GAP_MS, TRIPLE_TAP_GAP_MS)).toHaveLength(1);
  });

  it("does not fire when a tap arrives after the gap has lapsed", () => {
    expect(t(0, TRIPLE_TAP_GAP_MS + 1, 50)).toEqual([]);
  });

  it("starts a fresh run rather than counting a stale tap", () => {
    // Two taps, a long pause, then two more is four taps and no gesture.
    expect(t(0, 100, 5_000, 100)).toEqual([]);
  });

  it("does not toggle back on a fourth trailing tap", () => {
    // The failure this prevents: a hand resting on a trackpad flipping Aide's
    // ears on and off, with an announcement every time.
    expect(t(0, 100, 100, 100)).toEqual([200]);
    expect(t(0, 100, 100, 100, 100)).toEqual([200]);
  });

  it("toggles exactly twice over six quick taps — closed, then open again", () => {
    expect(t(0, 100, 100, 100, 100, 100)).toEqual([200, 500]);
  });

  it("forgets a part-finished run when reset", () => {
    const run = new TapRun();
    run.register(0);
    run.register(100);
    run.reset();
    expect(run.register(200)).toBe(false);
    expect(run.register(300)).toBe(false);
    expect(run.register(400)).toBe(true);
  });
});

describe("what Aide says when the microphone closes and opens", () => {
  it("carries the way back inside the closing notice", () => {
    // This is the LAST thing the user hears before Aide goes quiet. If the
    // gesture isn't in it, there is nothing on screen to remind them of it,
    // and the mic stays closed for the rest of the session.
    expect(MUTE_NOTICE).toMatch(/three/i);
    expect(MUTE_NOTICE).toMatch(/tap/i);
  });

  it("says plainly that it has stopped, in both notices", () => {
    expect(MUTE_NOTICE).toMatch(/stop listening/i);
    expect(UNMUTE_NOTICE).toMatch(/listening again/i);
  });

  it("never asks the user to look at anything", () => {
    for (const notice of [MUTE_NOTICE, UNMUTE_NOTICE]) {
      expect(notice).not.toMatch(/\b(see|look|watch|screen shows|on screen)\b/i);
    }
  });

  it("keeps both notices short enough to be heard, not sat through", () => {
    for (const notice of [MUTE_NOTICE, UNMUTE_NOTICE]) {
      expect(notice.split(/\s+/).length).toBeLessThanOrEqual(20);
    }
  });

  it("invites the user back in, rather than just reporting a state", () => {
    // Resuming should hand the turn over. "I'm listening again." alone leaves
    // a blind user unsure whether Aide is waiting on them or still working.
    expect(UNMUTE_NOTICE).toMatch(/\?/);
  });
});

describe("the prompt tells the user how to stop Aide listening", () => {
  it("describes the gesture, so Aide can answer when asked", () => {
    expect(SYSTEM_PROMPT).toMatch(/THREE quick taps/);
  });

  it("forbids Aide claiming it stopped listening by itself", () => {
    // Same failure as the navigation rule: a claim with no action behind it
    // leaves someone believing a microphone is closed when it is open.
    expect(SYSTEM_PROMPT).toMatch(/never say you have stopped listening/i);
  });
});
