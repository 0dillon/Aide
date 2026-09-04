import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, walletDoc, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// The armed withdrawal is read back to the user out loud — the greeting opens
// with "You have a withdrawal of N naira waiting for your spoken confirmation."
// Since the kobo migration the stored pending carries the figure in
// `amountKobo`, and `amount` is the older naira field that may simply not be
// there. Nothing above the store should have to know that: getWallet resolves
// which era wrote the row and hands back one honest naira figure.
//
// If it hands back undefined instead, Aide says "a withdrawal of undefined
// naira", and the person listening has no screen to check it against.

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

let getWallet: typeof import("../../lib/store/payments").getWallet;
let calls: ConvexCall[];
let pending: Record<string, unknown> | undefined;

const PENDING_BASE = {
  phrase: "mango",
  mode: "word" as const,
  destAccount: "0123456789",
  destBankCode: "058",
  destAccountName: "ADA OKAFOR",
  createdAt: Date.now(),
};

beforeEach(async () => {
  // These exercise the Monnify adapter specifically — the Monnify HTTP module
  // is what they mock. BMONI is the default provider now, so the rail under
  // test is named rather than assumed; without this they would run against
  // BMONI and fail on a missing sandbox user rather than on anything they are
  // actually asserting.
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "monnify");
  vi.resetModules();
  ({ getWallet } = await import("../../lib/store/payments"));
  calls = [];
  pending = undefined;
  const handlers: Handlers = {
    "wallets:getByAccount": () => walletDoc({ pendingWithdrawal: pending }),
    "wallets:ensure": () => null,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
});

describe("the armed amount the greeting speaks", () => {
  it("gives naira for a pending stored in kobo", async () => {
    pending = { ...PENDING_BASE, amountKobo: 500_000 };
    const w = await getWallet("u-worker");
    expect(w.pendingWithdrawal?.amount).toBe(5000);
  });

  it("gives naira for a pending armed before the migration", async () => {
    pending = { ...PENDING_BASE, amount: 5000 };
    const w = await getWallet("u-worker");
    expect(w.pendingWithdrawal?.amount).toBe(5000);
  });

  it("keeps the kobo figure alongside, so callers need not multiply", async () => {
    pending = { ...PENDING_BASE, amount: 5000 };
    const w = await getWallet("u-worker");
    expect(w.pendingWithdrawal?.amountKobo).toBe(500_000);
  });
});
