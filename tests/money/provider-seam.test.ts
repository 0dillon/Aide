import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedProvider } from "../../lib/banking/provider";

// BMONI is the provider now: it holds the wallets, the naira balance and the
// account numbers workers give out. So it is the default, and an unset or
// misspelled env var lands there rather than on the old rail.
//
// Monnify has not been deleted — it is still reachable by name, as the way
// back if the sandbox goes down mid-demo. But it is opt-in now, which is the
// exact reverse of how this file used to read.

describe("which provider is live", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AIDE_PAYMENT_PROVIDER;
  });

  it("is BMONI when nothing is set", () => {
    expect(selectedProvider()).toBe("bmoni");
  });

  it("is Monnify only when explicitly asked for", () => {
    process.env.AIDE_PAYMENT_PROVIDER = "monnify";
    expect(selectedProvider()).toBe("monnify");
    process.env.AIDE_PAYMENT_PROVIDER = "  MONNIFY  ";
    expect(selectedProvider()).toBe("monnify");
  });

  it("falls back to BMONI on anything unrecognised", () => {
    // A typo must land on the provider that actually holds the money, not on
    // the one whose account numbers nobody is being paid into any more.
    for (const v of ["monify", "monnify-sandbox", "MONEY", "true", "1", ""]) {
      process.env.AIDE_PAYMENT_PROVIDER = v;
      expect(selectedProvider()).toBe("bmoni");
    }
  });
});
