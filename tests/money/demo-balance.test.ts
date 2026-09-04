import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, walletDoc, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// TEMPORARY, and the tests are the part that keeps it honest.
//
// AIDE_DEMO_BALANCE stands in for a figure this app otherwise refuses to
// invent, so it exists on sufferance: it must do nothing unless deliberately
// switched on, it must never override a number the bank actually returned, and
// it must still behave like money — withdrawals come off it.
//
// Delete this file when the stand-in goes.

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

const bank = vi.hoisted(() => ({ transactions: vi.fn() }));

vi.mock("../../lib/monnify", () => ({
  getReservedAccountTransactions: (...a: any[]) => bank.transactions(...a),
  getReservedAccount: () =>
    Promise.resolve({
      accountReference: "aide-u-worker",
      accountName: "Ada Okafor",
      accounts: [{ accountNumber: "1234567890", bankName: "Wema Bank", bankCode: "058" }],
    }),
  createReservedAccount: () =>
    Promise.resolve({
      accountReference: "aide-u-worker",
      accountName: "Ada Okafor",
      accounts: [{ accountNumber: "1234567890", bankName: "Wema Bank", bankCode: "058" }],
    }),
  validateBankAccount: vi.fn(),
  singleTransfer: vi.fn(),
  isValidWebhook: () => true,
  verifyTransaction: vi.fn(),
  spokenProviderError: () => "spoken",
}));

let getBalance: typeof import("../../lib/store/payments").getBalance;
let calls: ConvexCall[];
let handlers: Handlers;
let withdrawn: number; // KOBO — this stands in for the wallets:withdrawnTotal query

const outage = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // These exercise the Monnify adapter specifically — the Monnify HTTP module
  // is what they mock. BMONI is the default provider now, so the rail under
  // test is named rather than assumed; without this they would run against
  // BMONI and fail on a missing sandbox user rather than on anything they are
  // actually asserting.
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "monnify");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ({ getBalance } = await import("../../lib/store/payments"));
  calls = [];
  withdrawn = 0;
  handlers = {
    "accounts:seedDefaults": () => null,
    "wallets:getByAccount": () => walletDoc(),
    "wallets:ensure": () => null,
    "wallets:setProvisioned": () => null,
    "wallets:withdrawnTotal": () => withdrawn,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
  bank.transactions.mockReset();
});

describe("with the stand-in switched off", () => {
  it("fails when the bank is unreachable, rather than inventing a figure", async () => {
    bank.transactions.mockRejectedValue(outage());
    await expect(getBalance("u-worker")).rejects.toThrow();
  });
});

describe("with the stand-in switched on", () => {
  beforeEach(() => vi.stubEnv("AIDE_DEMO_BALANCE", "12000"));

  it("stands in for the balance when the bank cannot be reached", async () => {
    bank.transactions.mockRejectedValue(outage());
    const r = await getBalance("u-worker");
    expect(r.balance).toBe(12000);
    // Flagged, so nothing downstream can mistake it for a confirmed figure.
    expect(r.demo).toBe(true);
  });

  it("still returns the account details, which are ours and were never in doubt", async () => {
    bank.transactions.mockRejectedValue(outage());
    const r = await getBalance("u-worker");
    expect(r.account).toBe("1234567890");
    expect(r.bankName).toBe("Wema Bank");
  });

  it("subtracts withdrawals, so the demo cannot contradict itself", async () => {
    // Withdraw two thousand and the balance has to move. Otherwise the first
    // withdrawal in a demo makes the number visibly wrong.
    withdrawn = 200_000; // ₦2,000 in kobo
    bank.transactions.mockRejectedValue(outage());
    expect((await getBalance("u-worker")).balance).toBe(10000);
  });

  it("never overrides a real balance the bank did return", async () => {
    // The bank answering wins, always — even when it says something small.
    bank.transactions.mockResolvedValue({
      content: [{ amount: 250, paymentStatus: "PAID", transactionReference: "TX" }],
    });
    const r = await getBalance("u-worker");
    expect(r.balance).toBe(250);
    expect(r.demo).toBeUndefined();
  });

  it("is ignored when set to something that is not a usable amount", async () => {
    for (const bad of ["nonsense", "-500", ""]) {
      vi.stubEnv("AIDE_DEMO_BALANCE", bad);
      bank.transactions.mockRejectedValue(outage());
      await expect(getBalance("u-worker"), `"${bad}" should not stand in`).rejects.toThrow();
    }
  });
});
