import { describe, expect, it } from "vitest";
import { normalizePidgin, pidginScore, bestAlternative } from "../../lib/voice/pidgin";

// Nigerian Pidgin through an English recognizer.
//
// The Web Speech API has no Nigerian Pidgin model — `pcm` is not a language it
// accepts — so pidgin arrives transcribed by an English one, which renders it
// as the nearest English words: "dey" as "day", "wetin" as "we tin", "sabi" as
// "savvy". The model that has to act on the sentence then sees English that
// means something else, or nothing.
//
// Two repairs, in this order of importance:
//   1. Pick the best of the recognizer's alternatives, since the right words
//      are often in the list but not first.
//   2. Repair the mishearings that survive.
//
// The hard rule throughout: NEVER touch anything that could be an amount. This
// text becomes a withdrawal. A rewrite that turns "one thousand" into
// something else is worse than any amount of misunderstood pidgin, because the
// user cannot see the figure to catch it.

describe("leaving amounts alone", () => {
  // These run first because they are the ones that must never regress.
  it("does not alter digits", () => {
    expect(normalizePidgin("send 25000 give am")).toContain("25000");
    expect(normalizePidgin("I wan comot 1500 naira")).toContain("1500");
  });

  it("does not alter number words", () => {
    // "one" is the trap: it is also how a recognizer hears "wan" (want).
    // Rewriting it blindly turns "one thousand naira" into "want thousand".
    for (const said of [
      "send one thousand naira",
      "comot two hundred and fifty naira",
      "I get five thousand for my account",
      "make e be one five zero zero",
    ]) {
      const out = normalizePidgin(said);
      for (const w of ["one", "two", "hundred", "thousand", "fifty", "five", "zero"]) {
        if (said.includes(w)) expect(out).toContain(w);
      }
    }
  });

  it("still repairs 'wan' when it is clearly the verb, not the number", () => {
    // "I one comot money" is never "the number one". The pronoun in front is
    // what makes it safe to change.
    expect(normalizePidgin("I one comot money")).toContain("wan");
    expect(normalizePidgin("I one comot money")).not.toContain("one comot");
  });

  it("leaves 'one' alone when a number follows it", () => {
    // "I one thousand" is someone saying an amount badly, not "I want".
    expect(normalizePidgin("I one thousand naira")).toContain("one thousand");
  });
});

describe("repairing what an English recognizer does to pidgin", () => {
  it("hears 'dey' behind 'day'", () => {
    expect(normalizePidgin("how much day my account")).toContain("dey my account");
    expect(normalizePidgin("I day find work")).toContain("I dey find work");
    expect(normalizePidgin("money no day")).toContain("money no dey");
  });

  it("does not touch 'day' when it really means a day", () => {
    // "two day work", "every day", "next day" are ordinary English.
    expect(normalizePidgin("I fit work every day")).toContain("every day");
    expect(normalizePidgin("the work na three day")).toContain("three day");
  });

  it("hears 'wetin' behind its spellings", () => {
    for (const said of ["we tin dey happen", "weting dey happen", "wetin dey happen"]) {
      expect(normalizePidgin(said)).toContain("wetin dey happen");
    }
  });

  it("hears 'abeg' behind 'I beg' and 'a beg'", () => {
    expect(normalizePidgin("a beg check my balance")).toContain("abeg");
    expect(normalizePidgin("I beg check my balance")).toContain("abeg");
  });

  it("hears 'comot' behind 'come out'", () => {
    // "comot my money" is a withdrawal. "come out my money" is not English at
    // all, so there is nothing to lose by repairing it.
    expect(normalizePidgin("come out my money")).toContain("comot my money");
  });

  it("hears 'sabi' behind 'savvy'", () => {
    expect(normalizePidgin("I no savvy computer")).toContain("sabi");
  });

  it("is case-insensitive and keeps the rest of the sentence", () => {
    expect(normalizePidgin("Abeg How Much Day My Account")).toMatch(/dey my account/i);
  });

  it("leaves plain English untouched", () => {
    const said = "please check my balance and find me a transcription job";
    expect(normalizePidgin(said)).toBe(said);
  });
});

describe("choosing between the recognizer's alternatives", () => {
  it("scores a sentence by how much pidgin is in it", () => {
    expect(pidginScore("wetin dey my account")).toBeGreaterThan(pidginScore("we tin day my account"));
  });

  it("picks the alternative that reads as pidgin", () => {
    // The right words are often present but ranked second, because the
    // recognizer's language model prefers ordinary English.
    expect(bestAlternative(["we tin day happen", "wetin dey happen"])).toBe("wetin dey happen");
  });

  it("keeps the recognizer's first choice when nothing looks like pidgin", () => {
    // The recognizer is better at English than this heuristic is. Only
    // outright pidgin markers may override it.
    expect(bestAlternative(["check my balance", "cheque my balance"])).toBe("check my balance");
  });

  it("keeps the first choice on a tie", () => {
    expect(bestAlternative(["abeg send am", "abeg send am now"])).toBe("abeg send am");
  });

  it("survives an empty list", () => {
    expect(bestAlternative([])).toBe("");
  });
});
