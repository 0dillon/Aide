import { describe, expect, it } from "vitest";
import { forSpeech } from "../../app/aide/voice-engine";

// forSpeech is the last thing to touch a sentence before it becomes audio.
// Every rule here exists because the neural voice got something wrong out
// loud — and for a user who cannot read the transcript, what is said IS the
// product. Money amounts are the sharpest case: "one two zero zero zero" and
// "twelve thousand" are not the same sentence.

describe("forSpeech — money", () => {
  it("turns a naira symbol and digits into spoken naira", () => {
    expect(forSpeech("You have ₦12,000 ready.")).toBe("You have 12000 naira ready.");
  });

  it("handles the NGN prefix too", () => {
    expect(forSpeech("Balance: NGN 7500")).toBe("Balance: 7500 naira");
  });

  it("strips thousands separators so digits are not read one by one", () => {
    expect(forSpeech("It is 1,250,000 exactly")).toBe("It is 1250000 exactly");
  });

  it("leaves a decimal amount intact", () => {
    expect(forSpeech("It is 12.5 percent")).toBe("It is 12.5 percent");
  });
});

describe("forSpeech — pronunciation repairs", () => {
  it("restores the space when a tool call fuses two sentences", () => {
    // Without this the voice reads "you.I" as one token and says "dot".
    expect(forSpeech("for you.I found one")).toBe("for you. I found one");
  });

  it("does not break an initialism apart", () => {
    expect(forSpeech("the U.S.A office")).toBe("the U.S.A office");
  });

  it("turns dashes into a comma's worth of pause", () => {
    expect(forSpeech("Good news — money landed")).toBe("Good news, money landed");
    expect(forSpeech("Good news - money landed")).toBe("Good news, money landed");
  });

  it("keeps hyphenated words whole", () => {
    expect(forSpeech("a well-known employer")).toBe("a well-known employer");
  });

  it("removes markdown the model sometimes emits", () => {
    expect(forSpeech("**Important** _now_ `here`")).toBe("Important now here");
  });

  it("speaks an ampersand as a word", () => {
    expect(forSpeech("work & pay")).toBe("work and pay");
  });

  it("collapses the whitespace its own rewrites leave behind", () => {
    expect(forSpeech("too    many     spaces")).toBe("too many spaces");
  });

  it("never leaves a space before punctuation", () => {
    expect(forSpeech("wait *  * , then go")).not.toMatch(/\s[,.!?]/);
  });
});

describe("forSpeech — safety", () => {
  it("is idempotent, so a re-spoken sentence does not drift", () => {
    const once = forSpeech("You have ₦12,000 — ready to withdraw.");
    expect(forSpeech(once)).toBe(once);
  });

  it("never returns an empty string for real content", () => {
    expect(forSpeech("Your balance is ₦0")).not.toBe("");
  });

  it("handles an empty input without throwing", () => {
    expect(forSpeech("")).toBe("");
  });
});
