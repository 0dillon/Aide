import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, walletDoc, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// A wallet provisioned under one provider, on a deployment that has since
// switched to another.
//
// ensureWallet used to return early on `status === "active"` alone. That is
// true of every wallet Monnify ever provisioned, so switching to BMONI left
// those accounts permanently half-migrated: the page kept showing the old
// Monnify NUBAN, no BMONI user was ever created, and every BMONI call failed
// with "No BMONI user provisioned for demo-worker" — balance, bank list and
// card all at once.
//
// It cost real confusion because it looked like a BMONI outage rather than a
// wallet that had never been asked to migrate. Worse, the account number on
// screen stayed plausible and payable, so a worker could still hand it out —
// to an account this app no longer reads.
//
// "Active" therefore has to mean active FOR THE PROVIDER THAT IS LIVE.

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

const bmoni = vi.hoisted(() => ({ ensureWallet: vi.fn() }));
vi.mock("../../lib/banking/bmoni-provider", () => ({
  bmoniProvider: {
    name: "bmoni",
    ensureWallet: (id: string) => bmoni.ensureWallet(id),
    getBalanceKobo: async () => 0,
    listInbound: async () => [],
    listBanks: async () => [],
    verifyDestination: async () => ({ accountNumber: "", accountName: "", bankCode: "", nameVerified: true }),
    payOut: async () => ({ state: "unknown" as const, reference: "", mayAnnounceArrival: false }),
  },
}));

let ensureWallet: typeof import("../../lib/store/payments").ensureWallet;
let calls: ConvexCall[];
let stored: Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "bmoni");
  vi.stubEnv("BMONI_API_KEY", "pk_test");
  ({ ensureWallet } = await import("../../lib/store/payments"));
  calls = [];
  bmoni.ensureWallet.mockReset();
  bmoni.ensureWallet.mockResolvedValue({
    accountNumber: "4534076021",
    bankName: "PROVIDUS BANK",
    accountName: "Dillon Bunch",
  });
});

function install(wallet: Record<string, unknown>) {
  stored = wallet;
  const handlers: Handlers = {
    "accounts:seedDefaults": () => null,
    "wallets:getByAccount": () => stored,
    "wallets:ensure": () => null,
    "wallets:setProvisioned": (a: any) => {
      stored = { ...stored, ...a, status: "active" };
      return null;
    },
    "wallets:setFailed": () => null,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
}

describe("a wallet left behind by a provider switch", () => {
  it("re-provisions a Monnify-era wallet when BMONI is live", async () => {
    // Exactly the row a real deployment carries: active, with a working
    // Monnify NUBAN, and no idea BMONI exists.
    install({ ...walletDoc(), status: "active", accountNumber: "2209049616", bankName: "Sterling bank" });

    const w = await ensureWallet("demo-worker");

    expect(bmoni.ensureWallet).toHaveBeenCalledWith("demo-worker");
    expect(w.accountNumber).toBe("4534076021");
    expect(w.bankName).toBe("PROVIDUS BANK");
  });

  it("stops showing the old provider's account number", async () => {
    // The dangerous half. 2209049616 is a real, payable account — it just is
    // not the one this app can read a balance from any more. Left on screen,
    // a worker hands it to an employer and the money lands where Aide will
    // never see it.
    install({ ...walletDoc(), status: "active", accountNumber: "2209049616", bankName: "Sterling bank" });
    const w = await ensureWallet("demo-worker");
    expect(w.accountNumber).not.toBe("2209049616");
  });

  it("does not re-provision a wallet already on the live provider", async () => {
    // Once migrated it must settle. Re-running provisioning on every request
    // would create a second BMONI wallet, which has no uniqueness guard.
    install({
      ...walletDoc(),
      status: "active",
      provider: "bmoni",
      accountNumber: "4534076021",
      bankName: "PROVIDUS BANK",
    });

    const w = await ensureWallet("demo-worker");

    expect(bmoni.ensureWallet).not.toHaveBeenCalled();
    expect(w.accountNumber).toBe("4534076021");
  });

  it("records which provider provisioned it, so the next request settles", async () => {
    install({ ...walletDoc(), status: "active", accountNumber: "2209049616", bankName: "Sterling bank" });
    await ensureWallet("demo-worker");

    const provisioned = calls.find((c) => c.name === "wallets:setProvisioned");
    expect((provisioned?.args as any)?.provider).toBe("bmoni");
  });

  it("treats a wallet with no recorded provider as Monnify's", async () => {
    // Every row written before this field existed was Monnify's. Guessing the
    // other way would re-provision an untouched Monnify deployment onto BMONI.
    vi.stubEnv("AIDE_PAYMENT_PROVIDER", "monnify");
    const { ensureWallet: ensureMonnify } = await import("../../lib/store/payments");
    install({ ...walletDoc(), status: "active", accountNumber: "2209049616", bankName: "Sterling bank" });

    const w = await ensureMonnify("demo-worker");

    expect(bmoni.ensureWallet).not.toHaveBeenCalled();
    expect(w.accountNumber).toBe("2209049616");
  });
});
