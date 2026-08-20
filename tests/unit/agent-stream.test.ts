import { describe, expect, it } from "vitest";
import { extractSentences } from "../../app/aide/agent-stream";

// Sentence splitting decides what Aide actually says out loud. A boundary
// missed here is not a cosmetic bug: the sentence either never reaches the
// speaker, or reaches it fused to the next one and gets mispronounced. Both
// have shipped.

const feed = (chunks: string[]) => {
  let unspoken = "";
  const spoken: string[] = [];
  for (const c of chunks) {
    unspoken += c;
    const { sentences, rest } = extractSentences(unspoken);
    unspoken = rest;
    spoken.push(...sentences);
  }
  return { spoken, unspoken };
};

describe("extractSentences", () => {
  it("splits on ordinary sentence punctuation", () => {
    const { spoken } = feed(["Your balance is ready. Say withdraw to move it. "]);
    expect(spoken).toEqual(["Your balance is ready.", "Say withdraw to move it."]);
  });

  it("splits text fused across a tool call, which arrives with no space", () => {
    // The SDK concatenates what the model said before a tool call with what it
    // said after. Left fused, TTS reads the full stop aloud as "dot".
    const { spoken } = feed(["Let me check that for you.I found one job. "]);
    expect(spoken).toEqual(["Let me check that for you.", "I found one job."]);
  });

  it("speaks a finished sentence sitting at the end of the buffer", () => {
    // The opening line is the last thing emitted before a tool runs, so it has
    // no trailing space. It must still be spoken — covering that pause is the
    // only reason it exists. Waiting for the tool to return defeats it.
    const { spoken, unspoken } = feed(["Let me pull those up for you."]);
    expect(spoken).toEqual(["Let me pull those up for you."]);
    expect(unspoken).toBe("");
  });

  it("does not split an initialism", () => {
    const { spoken } = feed(["Call the U.S.A office now. "]);
    expect(spoken).toEqual(["Call the U.S.A office now."]);
  });

  it("does not split a decimal", () => {
    const { spoken } = feed(["I paid 12.5 naira today. "]);
    expect(spoken).toEqual(["I paid 12.5 naira today."]);
  });

  it("does not treat a numbered list marker as a sentence end", () => {
    const { spoken } = feed(["Step 1. Open the app. Step 2. Tap it. "]);
    expect(spoken).toEqual(["Step 1. Open the app.", "Step 2. Tap it."]);
  });

  it("handles a question mark fused to the next sentence", () => {
    const { spoken } = feed(["Is it ready?Yes it is. "]);
    expect(spoken).toEqual(["Is it ready?", "Yes it is."]);
  });

  it("reassembles a sentence arriving one character at a time", () => {
    const text = "Your withdrawal is confirmed. The money is on its way. ";
    const { spoken } = feed(text.split(""));
    expect(spoken).toEqual(["Your withdrawal is confirmed.", "The money is on its way."]);
  });

  // The invariant that matters most: whatever the chunk boundaries, every word
  // the model produced must end up either spoken or still buffered. Nothing may
  // silently vanish — a dropped sentence is invisible to a user who cannot see
  // the transcript.
  it("never loses text, at any chunk size", () => {
    const text =
      "Good morning. You have twelve thousand naira ready.I found three jobs for you. Would you like to hear them?";
    for (const size of [1, 2, 3, 5, 7, 11, 23, 100]) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      const { spoken, unspoken } = feed(chunks);
      // Whitespace may legitimately change — splitting a fused pair inserts a
      // gap the original did not have — but no other character may vanish.
      const roundTrip = (spoken.join("") + unspoken).replace(/\s+/g, "");
      expect(roundTrip, `chunk size ${size}`).toBe(text.replace(/\s+/g, ""));
    }
  });

  it("returns nothing for a buffer with no sentence end yet", () => {
    const { spoken, unspoken } = feed(["I am still speaking and have not"]);
    expect(spoken).toEqual([]);
    expect(unspoken).toBe("I am still speaking and have not");
  });
});
