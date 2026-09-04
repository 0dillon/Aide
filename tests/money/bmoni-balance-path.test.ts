import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, walletDoc, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// The balance the payments page and the greeting now read, end to end: store →
// seam → BMONI adapter. Previously nothing exercised this at the store level,
// because nothing routed through the seam at all.
//
// The thing being pinned down is that Aide does NOT re-derive the figure.
// Monnify has no balance for a reserved account, so its adapter builds one by
// subtracting Aide's own withdrawal ledger from confirmed credits. BMONI holds
// the wallet, and the payouts have already left it — subtracting the ledger a
// second time would understate a worker's money by everything they have ever
// withdrawn.

const hoisted = vi.hoisted(() => ({
  dispatch: (_ref: any, _args: any): any => {
    throw new Error("dispatch not installed");
  },
}));

vi.mock("../../lib/convex-server", () => ({
  convexClient: () => ({
    query: (ref: any, args: any) => hoisted.dispatch(ref, args),
    mutation: (ref: any, args: any) => hoisted.dispatch(ref, args),
  }),
  publishConvexEvent: () => Promise.resolve(),
}));

const bmoni = vi.hoisted(() => ({ balances: vi.fn() }));

// Only the HTTP transport is faked. parseNgnBalanceKobo, the kobo conversion
// and the seam all run for real, so a shape change would surface here.
vi.mock("../../lib/banking/bmoni-client", () => ({
  bmoniRead: (call: any) => bmoni.balances(call),
  bmoniMove: (call: any) => bmoni.balances(call),
  BmoniError: class extends Error {},
}));

let getBalance: typeof import("../../lib/store/payments").getBalance;
let calls: ConvexCall[];

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "bmoni");
  vi.stubEnv("BMONI_API_KEY", "pk_test");
  ({ getBalance } = await import("../../lib/store/payments"));
  calls = [];
  const handlers: Handlers = {
    "accounts:seedDefaults": () => null,
    "wallets:getByAccount": () => ({
      ...walletDoc(),
      status: "active",
      // Provisioned BY BMONI. Without this the wallet reads as a Monnify-era
      // row and ensureWallet correctly re-provisions it before reading a
      // balance — see tests/money/wallet-provider-switch.test.ts.
      provider: "bmoni",
      accountNumber: "4534076021",
      bankName: "PROVIDUS BANK",
      bmoniUserId: "54db4056-620d-4aae-8205-88cb1b6483c8",
      bmoniSmartWalletId: "6ce865d5-a0d6-4e43-b92c-bf3474891443",
    }),
    "wallets:ensure": () => null,
    "wallets:setProvisioned": () => null,
    // Deliberately non-zero: if the store still subtracted this, the assertions
    // below would come out ₦500 short.
    "wallets:withdrawnTotal": () => 50_000,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
  bmoni.balances.mockReset();
});

const balances = (balance: string, currency = "NGN", error: string | null = null) => ({
  smartAccountAddress: "0x7C0d36A19870D267A95338623882E03BCd50c0b4",
  balances: [{ smartWalletId: "6ce865d5-a0d6-4e43-b92c-bf3474891443", currency, balance, error }],
});

describe("the balance, read from BMONI", () => {
  it("reports what BMONI holds, in naira", async () => {
    bmoni.balances.mockResolvedValue(balances("12000.50"));
    expect((await getBalance("demo-worker")).balance).toBe(12000.5);
  });

  it("does not subtract Aide's withdrawal ledger a second time", async () => {
    // BMONI has already debited the wallet for every payout. ₦500 of
    // withdrawals is in the fake ledger above; the answer must ignore it.
    bmoni.balances.mockResolvedValue(balances("12000"));
    expect((await getBalance("demo-worker")).balance).toBe(12000);
  });

  it("reports a genuine zero as zero", async () => {
    // The state the demo worker is actually in. Zero is a real answer and has
    // to survive the whole path — the greeting says it out loud.
    bmoni.balances.mockResolvedValue(balances("0"));
    expect((await getBalance("demo-worker")).balance).toBe(0);
  });

  it("returns the BMONI account details alongside it", async () => {
    bmoni.balances.mockResolvedValue(balances("0"));
    const r = await getBalance("demo-worker");
    expect(r.account).toBe("4534076021");
    expect(r.bankName).toBe("PROVIDUS BANK");
  });

  it("fails rather than reporting zero when BMONI cannot be reached", async () => {
    // Unknown is not empty. A zero here would be read aloud as "your balance is
    // ₦0.00", which is indistinguishable from a true empty account to someone
    // who cannot see the screen.
    bmoni.balances.mockRejectedValue(new Error("fetch failed"));
    await expect(getBalance("demo-worker")).rejects.toThrow(/fetch failed/);
  });

  it("fails rather than reporting zero when BMONI admits it could not price the wallet", async () => {
    // A per-entry `error` arrives inside an HTTP 200, alongside a `balance` of
    // "0" that means nothing.
    bmoni.balances.mockResolvedValue(balances("0", "NGN", "upstream timeout"));
    await expect(getBalance("demo-worker")).rejects.toThrow(/upstream timeout/);
  });
});
