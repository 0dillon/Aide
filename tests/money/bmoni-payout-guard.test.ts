import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// The double-payment guard.
//
// Paying out through BMONI is four calls — create, approve, fetch payload,
// sign — and BMONI has no idempotency keys. A failure anywhere after the first
// leaves a REAL payout sitting at BMONI. Starting the flow over would create a
// second one for the same wages, and the money is gone from someone else's
// account to pay it.
//
// So the proposal id is claimed in Convex the instant it exists, and any later
// attempt resumes that proposal instead of creating another. The guard is only
// released on a terminal status: an unknown status leaves it in flight on
// purpose, because "we do not know what happened to the last payout" is
// precisely when a second one must not be started.

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

const bmoni = vi.hoisted(() => ({
  createNgnOfframp: vi.fn(),
  getProposal: vi.fn(),
  approveProposal: vi.fn(),
  getSignPayload: vi.fn(),
  submitProposalSignature: vi.fn(),
  verifyNigerianAccount: vi.fn(),
  registerWithdrawalAccount: vi.fn(),
  createBmoniUser: vi.fn(),
  createSmartWallet: vi.fn(),
  requestOwnerProofChallenge: vi.fn(),
  listBalances: vi.fn(),
  startNigeriaOnboarding: vi.fn(),
  pointDepositsAtWallet: vi.fn(),
}));

vi.mock("../../lib/banking/bmoni", async () => {
  const actual = await vi.importActual<any>("../../lib/banking/bmoni");
  return { ...actual, ...bmoni };
});

// A real sealed key, so signing runs for real rather than being stubbed.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HASH = "0x8f5156823a5c2cdc7bedc12253e49e4946c6fff0273034eb485750035d21ad31";

let payOutToBank: typeof import("../../lib/banking/bmoni-wallet").payOutToBank;
let calls: ConvexCall[];
let walletRow: Record<string, unknown>;
let claimResult: { ok: boolean; inFlight?: string };

const PROVISIONED = (over: Record<string, unknown> = {}) => ({
  accountId: "u-worker",
  accountReference: "aide-u-worker",
  status: "active",
  knownTxRefs: [],
  txSeeded: true,
  bmoniUserId: "bm-user-1",
  bmoniSmartWalletId: "sw-1",
  bmoniWalletAddress: "0xwallet",
  bmoniOwnerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  bmoniBankAccountIds: [{ key: "0123456789:058", id: "ba-1" }],
  ...over,
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.BMONI_KEY_SECRET = "0".repeat(64);
  const { sealPrivateKey } = await import("../../lib/banking/keys");
  walletRow = PROVISIONED({ bmoniSealedOwnerKey: sealPrivateKey(ANVIL_KEY) });
  claimResult = { ok: true };
  calls = [];
  const handlers: Handlers = {
    "wallets:getByAccount": () => walletRow,
    "wallets:claimBmoniProposal": () => claimResult,
    "wallets:clearBmoniProposal": () => null,
    "wallets:rememberBmoniBankAccount": () => null,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
  ({ payOutToBank } = await import("../../lib/banking/bmoni-wallet"));

  bmoni.getSignPayload.mockResolvedValue({ hashToSign: HASH });
  bmoni.submitProposalSignature.mockResolvedValue({ proposalId: "p-1", status: "COMPLETED" });
  bmoni.approveProposal.mockResolvedValue({});
});

const DEST = { accountNumber: "0123456789", bankCode: "058", bankName: "Wema Bank" };

describe("a fresh payout", () => {
  it("claims the proposal id the moment it exists, before signing", async () => {
    bmoni.createNgnOfframp.mockResolvedValue({ proposalId: "p-1", status: "PENDING_APPROVALS" });
    bmoni.getProposal
      .mockResolvedValueOnce({ proposalId: "p-1", status: "PENDING_APPROVALS" })
      .mockResolvedValueOnce({ proposalId: "p-1", status: "PENDING_SIGNATURES" })
      .mockResolvedValue({ proposalId: "p-1", status: "COMPLETED" });

    const r = await payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST });
    expect(r.outcome.state).toBe("completed");

    const claimIndex = calls.findIndex((c) => c.name === "wallets:claimBmoniProposal");
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    // The claim must land before any signature is submitted, or a crash in
    // between leaves a payout nobody has a handle on.
    expect(bmoni.submitProposalSignature).toHaveBeenCalled();
    expect(calls[claimIndex].args).toMatchObject({ proposalId: "p-1", amountKobo: 500_000 });
  });

  it("sends the amount as a decimal string, converted from kobo", async () => {
    bmoni.createNgnOfframp.mockResolvedValue({ proposalId: "p-1", status: "COMPLETED" });
    bmoni.getProposal.mockResolvedValue({ proposalId: "p-1", status: "COMPLETED" });
    await payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST });
    expect(bmoni.createNgnOfframp).toHaveBeenCalledWith(expect.objectContaining({ amountKobo: 500_000 }));
  });
});

describe("a payout that is already in flight", () => {
  it("resumes it instead of creating a second one", async () => {
    // This is the case that would pay a worker twice.
    walletRow = PROVISIONED({
      bmoniSealedOwnerKey: walletRow.bmoniSealedOwnerKey,
      bmoniPendingProposal: { proposalId: "p-old", amountKobo: 500_000, createdAt: Date.now() },
    });
    bmoni.getProposal.mockResolvedValue({ proposalId: "p-old", status: "COMPLETED" });

    const r = await payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST });

    expect(bmoni.createNgnOfframp).not.toHaveBeenCalled();
    expect(r.proposalId).toBe("p-old");
  });

  it("refuses when the claim finds a different proposal already in flight", async () => {
    bmoni.createNgnOfframp.mockResolvedValue({ proposalId: "p-new", status: "PENDING_APPROVALS" });
    bmoni.getProposal.mockResolvedValue({ proposalId: "p-new", status: "PENDING_APPROVALS" });
    claimResult = { ok: false, inFlight: "p-other" };

    await expect(payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST })).rejects.toThrow(
      /Two payouts now exist/,
    );
  });
});

describe("releasing the guard", () => {
  it("clears it on a terminal status", async () => {
    bmoni.createNgnOfframp.mockResolvedValue({ proposalId: "p-1", status: "COMPLETED" });
    bmoni.getProposal.mockResolvedValue({ proposalId: "p-1", status: "COMPLETED" });
    await payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST });
    expect(calls.some((c) => c.name === "wallets:clearBmoniProposal")).toBe(true);
  });

  it("does NOT clear it on a status nobody recognises", async () => {
    // The point of failing closed. An unrecognised status means we do not know
    // whether the money moved, and that is exactly when a second payout must
    // stay blocked.
    bmoni.createNgnOfframp.mockResolvedValue({ proposalId: "p-1", status: "WHO_KNOWS" });
    bmoni.getProposal.mockResolvedValue({ proposalId: "p-1", status: "WHO_KNOWS" });

    const r = await payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST });
    expect(r.outcome.state).toBe("unknown");
    expect(r.outcome.mayAnnounceArrival).toBe(false);
    expect(calls.some((c) => c.name === "wallets:clearBmoniProposal")).toBe(false);
  });
});

describe("an unprovisioned wallet", () => {
  it("refuses rather than half-starting a payout", async () => {
    walletRow = { accountId: "u-worker", accountReference: "aide-u-worker", status: "active" };
    await expect(payOutToBank({ accountId: "u-worker", amountKobo: 500_000, ...DEST })).rejects.toThrow(
      /No provisioned BMONI wallet/,
    );
    expect(bmoni.createNgnOfframp).not.toHaveBeenCalled();
  });
});
