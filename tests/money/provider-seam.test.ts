import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedProvider } from "../../lib/banking/provider";

// The seam's only job at this stage is to be reversible, and reversibility
// rests on one thing: the default has to be the provider that already works.
//
// A misspelled or half-set env var must not silently move a worker's wages
// onto a sandbox integration. So selection is explicit-opt-in — anything that
// is not exactly "bmoni" is Monnify.

describe("which provider is live", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AIDE_PAYMENT_PROVIDER;
  });

  it("is Monnify when nothing is set", () => {
    expect(selectedProvider()).toBe("monnify");
  });

  it("is BMONI only when explicitly asked for", () => {
    process.env.AIDE_PAYMENT_PROVIDER = "bmoni";
    expect(selectedProvider()).toBe("bmoni");
    process.env.AIDE_PAYMENT_PROVIDER = "  BMONI  ";
    expect(selectedProvider()).toBe("bmoni");
  });

  it("falls back to Monnify on anything unrecognised", () => {
    // A typo must land on the provider that has been running, not the new one.
    for (const v of ["bmon", "bmoni-dev", "BMONEY", "true", "1", ""]) {
      process.env.AIDE_PAYMENT_PROVIDER = v;
      expect(selectedProvider()).toBe("monnify");
    }
  });
});
