import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// The withdrawal ledger, after a provider switch.
//
// The worker's page listed three payouts made through Monnify — ₦50 and ₦100 to
// one stranger, ₦19 to another — all still reading "processing", months old and
// permanently so, because nothing on BMONI will ever advance a Monnify
// reference. The employer's page, having no such history, correctly said
// nothing had been sent.
//
// That is worse than untidy. Aide reads this list aloud. A blind worker asking
// "what have I sent?" would hear three transfers to names they may not know,
// described as still in flight — money apparently leaving their account right
// now, from a provider this deployment no longer talks to. There is no screen
// on which to notice the dates are from another era.
//
// So the ledger is scoped the same way the wallet is: rows belong to the
// provider that made them, and only the live provider's rows are shown.

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

let calls: ConvexCall[];

async function load(provider: string) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", provider);
  vi.stubEnv("BMONI_API_KEY", "pk_test");
  return await import("../../lib/store/payments");
}

function install(rows: unknown[]) {
  const handlers: Handlers = {
    "accounts:seedDefaults": () => null,
    "wallets:listWithdrawals": () => rows,
    "wallets:recordWithdrawal": () => null,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
}

beforeEach(() => {
  calls = [];
});

describe("the withdrawal list, across a provider switch", () => {
  it("asks Convex only for the live provider's rows", async () => {
    const { getWithdrawals } = await load("bmoni");
    install([]);
    await getWithdrawals("demo-worker");

    const q = calls.find((c) => c.name === "wallets:listWithdrawals");
    expect((q?.args as any)?.provider).toBe("bmoni");
  });

  it("records which provider moved the money", async () => {
    // Without this the row is indistinguishable from a Monnify one the moment
    // it is written, and the next switch hides a real payout instead.
    const { recordWithdrawal } = await load("bmoni");
    install([]);
    await recordWithdrawal("demo-worker", { amount: 500, accountName: "Ada Test", status: "PENDING" } as any);

    const m = calls.find((c) => c.name === "wallets:recordWithdrawal");
    expect((m?.args as any)?.provider).toBe("bmoni");
  });

  it("shows an empty history rather than a stranger's name", async () => {
    // What the page should have said all along, and what the employer's page
    // already said: nothing sent yet.
    const { getWithdrawals } = await load("bmoni");
    install([]);
    expect(await getWithdrawals("demo-worker")).toEqual([]);
  });

  it("still lists the live provider's own withdrawals", async () => {
    // The filter must not be so eager that a real payout disappears — a worker
    // told their transfer was never made is the mirror-image lie.
    const { getWithdrawals } = await load("bmoni");
    install([{ accountId: "demo-worker", amount: 500, accountName: "Ada Test", status: "PENDING", at: 1, provider: "bmoni" }]);

    const rows = await getWithdrawals("demo-worker");
    expect(rows).toHaveLength(1);
    expect(rows[0].accountName).toBe("Ada Test");
  });
});
