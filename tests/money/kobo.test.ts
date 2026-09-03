import { describe, expect, it } from "vitest";
import { formatNaira, sumKobo, toKobo, toNaira } from "../../lib/money";

// Money is integer kobo everywhere inside Aide. Naira only exists at the edges:
// what the provider speaks, what the screen shows, and what Aide says out loud.
// These tests pin the boundary, because a wrong conversion here is not a
// rounding error — it is the wrong amount leaving a blind worker's account.

describe("toKobo", () => {
  it("converts a whole naira amount to kobo", () => {
    expect(toKobo(100)).toBe(10_000);
  });

  // ₦1.15 * 100 === 114.99999999999999 in float64. Truncating loses a kobo on
  // an amount a user could have typed. Verified failing cases: 0.29, 0.57,
  // 0.58, 1.13, 1.14, 1.15.
  it("converts kobo precision exactly, despite float64 multiplication", () => {
    expect(toKobo(1.15)).toBe(115);
    expect(toKobo(0.29)).toBe(29);
  });

  it("always returns a safe integer", () => {
    expect(Number.isSafeInteger(toKobo(1.15))).toBe(true);
    expect(Number.isSafeInteger(toKobo(99_999.99))).toBe(true);
  });

  it("rejects an amount that is not a finite number", () => {
    // A NaN reaching the provider as an amount is the worst case: it is not a
    // number the user said, and it is not zero either.
    expect(() => toKobo(Number.NaN)).toThrow();
    expect(() => toKobo(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("toNaira", () => {
  it("converts kobo back to naira for the provider and the screen", () => {
    expect(toNaira(115)).toBe(1.15);
    expect(toNaira(10_000)).toBe(100);
  });

  it("round-trips every kobo amount a user could type", () => {
    for (const naira of [0.29, 0.57, 1.15, 250.5, 99_999.99]) {
      expect(toNaira(toKobo(naira))).toBe(naira);
    }
  });

  it("refuses to convert a non-integer, which would mean kobo got mixed with naira", () => {
    expect(() => toNaira(1.5)).toThrow();
  });
});

describe("sumKobo", () => {
  it("sums exactly where summing naira floats drifts", () => {
    // Ten ₦0.10 credits. In float naira this sums to 0.9999999999999999 and
    // reports ₦0.99 — a kobo of a worker's wages lost to the representation.
    const tenTenKobo = Array(10).fill(10);
    expect(sumKobo(tenTenKobo)).toBe(100);

    const asFloatNaira = Array(10).fill(0.1).reduce((s: number, n: number) => s + n, 0);
    expect(asFloatNaira).not.toBe(1);
  });

  it("is empty-safe", () => {
    expect(sumKobo([])).toBe(0);
  });
});

describe("formatNaira", () => {
  it("renders kobo as a naira string for the screen", () => {
    expect(formatNaira(1_234_500)).toBe("₦12,345.00");
    expect(formatNaira(115)).toBe("₦1.15");
  });
});
