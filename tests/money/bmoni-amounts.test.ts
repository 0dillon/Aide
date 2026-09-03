import { describe, expect, it } from "vitest";
import { decimalStringToKobo, koboToDecimalString } from "../../lib/banking/amounts";

// The boundary where Aide's integer kobo meets BMONI's decimal strings.
//
// BMONI mixes three amount formats across its API — decimal strings ("100.00"
// for NGN offramps), minor-unit strings ("100000000"), and plain numbers for
// card transactions — and none of them are type-checked. Every one arrives as
// a `string` or a `number`, so nothing catches a unit mistake but this file.
//
// The direction that matters most is parsing. `parseFloat` is far more
// permissive than an amount of money should ever be: it takes the leading
// digits of "100abc", expands "1e3" to a thousand, and rounds "100.005" UP to
// a kobo that does not exist. Each of those produces a plausible number that
// Aide would then state out loud as fact.
//
// So parsing fails closed. A refusal surfaces as "I could not check that just
// now", which is true; a silently wrong figure is Aide asserting a financial
// fact that is not so, to someone with no screen to check it against.

describe("kobo to a BMONI decimal string", () => {
  it("always carries exactly two decimal places", () => {
    expect(koboToDecimalString(10_000)).toBe("100.00");
    expect(koboToDecimalString(1)).toBe("0.01");
    expect(koboToDecimalString(0)).toBe("0.00");
    expect(koboToDecimalString(12_345)).toBe("123.45");
  });

  it("refuses a figure that is not whole kobo", () => {
    // A naira float that reached here unconverted.
    expect(() => koboToDecimalString(100.5)).toThrow();
  });
});

describe("a BMONI decimal string to kobo", () => {
  it("reads the amounts BMONI actually sends", () => {
    expect(decimalStringToKobo("100.00")).toBe(10_000);
    expect(decimalStringToKobo("0.01")).toBe(1);
    expect(decimalStringToKobo("100")).toBe(10_000);
    expect(decimalStringToKobo("100.5")).toBe(10_050);
  });

  it("round-trips whatever we sent", () => {
    for (const kobo of [1, 7, 99, 100, 101, 12_345, 999_999_99]) {
      expect(decimalStringToKobo(koboToDecimalString(kobo))).toBe(kobo);
    }
  });

  it("refuses trailing garbage instead of taking the leading digits", () => {
    // parseFloat("100abc") is 100. A truncated or corrupted field would be
    // read as a real amount and paid out.
    expect(() => decimalStringToKobo("100abc")).toThrow();
    expect(() => decimalStringToKobo("100.00 NGN")).toThrow();
  });

  it("refuses scientific notation", () => {
    // parseFloat("1e3") is 1000 — a hundred naira becomes a thousand.
    expect(() => decimalStringToKobo("1e3")).toThrow();
  });

  it("refuses precision finer than a kobo rather than rounding it away", () => {
    // parseFloat("100.005")*100 rounds to 10001 — a kobo that never existed.
    // Refusing is the only honest answer: we cannot pay a fraction of a kobo,
    // and inventing one is Aide making up money.
    expect(() => decimalStringToKobo("100.005")).toThrow();
    expect(() => decimalStringToKobo("100.999")).toThrow();
  });

  it("refuses what is not a number at all", () => {
    expect(() => decimalStringToKobo("")).toThrow();
    expect(() => decimalStringToKobo("abc")).toThrow();
    expect(() => decimalStringToKobo("Infinity")).toThrow();
    expect(() => decimalStringToKobo("NaN")).toThrow();
  });

  it("refuses a negative amount", () => {
    // No BMONI field Aide reads is legitimately negative, and a minus sign
    // slipping through would flip the direction money moves.
    expect(() => decimalStringToKobo("-5.00")).toThrow();
  });

  it("tolerates surrounding whitespace, which is not ambiguous", () => {
    expect(decimalStringToKobo(" 100.00 ")).toBe(10_000);
  });
});
