import { describe, expect, it } from "vitest";
import { CONTINUING_FILLERS, OPENING_FILLERS, THINKING_FILLERS } from "../../app/aide/voice-engine";
import { SYSTEM_PROMPT } from "../../lib/agent/system";

// Aide is only ever heard, never read. These guard the handful of rules that
// make it bearable to listen to — each one is here because the opposite
// shipped and a user had to sit through it.

describe("the engine filler must not collide with Aide's own opener", () => {
  // The filler covers a stalled reply. Aide also opens its turns with a short
  // covering sentence. When both fired the user heard them stacked —
  // "Let me check. Let me check that for you." — which is what this prevents.
  it("never phrases a mid-reply cover as the start of a turn", () => {
    // These fire AFTER Aide has spoken. "One moment" there sounds like it is
    // starting over, which is how a wait turns into apparent repetition.
    for (const filler of CONTINUING_FILLERS) {
      expect(filler, `"${filler}" reads as an opener`).not.toMatch(/^(let me|one moment|okay|sure|checking|looking)\b/i);
    }
  });

  it("never begins any cover with the model's own habitual opener", () => {
    // "Let me ..." is what the model reaches for. A cover that also starts
    // that way is indistinguishable from Aide repeating itself.
    for (const filler of THINKING_FILLERS) {
      expect(filler, `"${filler}" starts like the model's opener`).not.toMatch(/^let me\b/i);
    }
  });

  it("keeps the two sets disjoint, so the wrong one cannot be picked", () => {
    for (const opening of OPENING_FILLERS) expect(CONTINUING_FILLERS).not.toContain(opening);
  });

  it("uses no wording the system prompt also suggests to the model", () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    for (const filler of THINKING_FILLERS) {
      expect(prompt, `filler "${filler}" is also a prompt example`).not.toContain(filler.toLowerCase());
    }
  });

  it("keeps the fillers distinct from each other", () => {
    expect(new Set(THINKING_FILLERS).size).toBe(THINKING_FILLERS.length);
  });

  it("keeps every filler short enough to be a bridge, not a statement", () => {
    for (const filler of THINKING_FILLERS) expect(filler.split(/\s+/).length).toBeLessThanOrEqual(5);
  });
});

describe("the prompt forbids what a blind user cannot do", () => {
  // Not a test of the model — a test that the rules survive future edits to a
  // long prompt, where a deletion is easy to miss in review.
  it("bans asking whether the user can see something", () => {
    expect(SYSTEM_PROMPT).toMatch(/can you see it/i);
    expect(SYSTEM_PROMPT).toMatch(/never lean on sight/i);
  });

  it("forbids claiming a screen was opened without actually opening it", () => {
    expect(SYSTEM_PROMPT).toMatch(/ACTION, never a claim/);
    expect(SYSTEM_PROMPT).toMatch(/open_page/);
  });

  it("limits the covering opener to once per turn", () => {
    expect(SYSTEM_PROMPT).toMatch(/ONCE per turn/);
  });
});
