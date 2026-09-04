import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountDoc, makeDispatch, walletDoc, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// Everything that must be true BEFORE a transfer is armed. Each guard here is
// the difference between a misheard sentence and money leaving an account that
// the owner cannot see the balance of.

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

const bank = vi.hoisted(() => ({
  validate: vi.fn(),
  transactions: vi.fn(),
}));

vi.mock("../../lib/monnify", () => ({
  validateBankAccount: (...a: any[]) => bank.validate(...a),
  getReservedAccountTransactions: (...a: any[]) => bank.transactions(...a),
  getReservedAccount: () => Promise.resolve({ accountReference: "aide-u", accountName: "x", accounts: [{ accountNumber: "1", bankName: "b", bankCode: "058" }] }),
  createReservedAccount: () => Promise.resolve({ accountReference: "aide-u", accountName: "x", accounts: [{ accountNumber: "1", bankName: "b", bankCode: "058" }] }),
  singleTransfer: vi.fn(),
  isValidWebhook: () => true,
  verifyTransaction: vi.fn(),
}));

const { armWithdrawal, getBalance, verifyWithdrawal } = await import("../../lib/store/payments");

let calls: ConvexCall[];
let handlers: Handlers;
// A fresh account id per test: the store keeps a short-lived balance cache
// keyed by account, and reusing ids would leak one test's balance into another.
let seq = 0;
let acct: string;

const baseHandlers = (over: Handlers = {}): Handlers => ({
  "accounts:seedDefaults": () => null,
  "accounts:getByKey": () => accountDoc({ key: acct }),
  "wallets:getByAccount": () => walletDoc({ accountId: acct, hasSecurityPhrase: true, securityPhraseHash: "h" }),
  "wallets:ensure": () => null,
  "wallets:setProvisioned": () => null,
  "wallets:withdrawnTotal": () => 0,
  "wallets:listBeneficiaries": () => [],
  "wallets:armPending": () => null,
  ...over,
});

beforeEach(() => {
  // These exercise the Monnify adapter specifically — the Monnify HTTP module
  // is what they mock. BMONI is the default provider now, so the rail under
  // test is named rather than assumed; without this they would run against
  // BMONI and fail on a missing sandbox user rather than on anything they are
  // actually asserting.
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "monnify");
  acct = `u-worker-${++seq}`;
  calls = [];
  handlers = baseHandlers();
  hoisted.dispatch = makeDispatch(handlers, calls);
  bank.validate.mockReset();
  bank.transactions.mockReset();
  // 50,000 naira confirmed inbound by default.
  bank.transactions.mockResolvedValue({ content: [{ amount: 50000, paymentStatus: "PAID", transactionReference: "TX1" }] });
  bank.validate.mockResolvedValue({ accountName: "ADA OKAFOR", accountNumber: "0123456789", bankCode: "058" });
});

const armed = () => calls.some((c) => c.name === "wallets:armPending");

// A destination registered long enough ago to be past the cooling-off hold.
// Success paths have to go through one of these: a freshly typed account is
// deliberately unusable until the hold expires (see the cooling-off suite).
const trusted = () => [
  { accountId: acct, accountName: "ADA OKAFOR", accountNumber: "0123456789", bankCode: "058", at: Date.now() - 60 * 60 * 1000 },
];

describe("amount guards", () => {
  it("refuses a non-positive amount", async () => {
    for (const amount of [0, -1000]) {
      const r = await armWithdrawal(acct, amount, { accountNumber: "0123456789", bankCode: "058" });
      expect(r.ok, `amount=${amount}`).toBe(false);
    }
    expect(armed()).toBe(false);
  });

  it("refuses a number that is not a number", async () => {
    // "withdraw all of it" misheard can produce NaN. It must not arm anything.
    for (const amount of [NaN, Infinity, -Infinity]) {
      expect((await armWithdrawal(acct, amount, { accountNumber: "0123456789", bankCode: "058" })).ok).toBe(false);
    }
    expect(armed()).toBe(false);
  });

  it("caps a single withdrawal, so one spoken sentence cannot empty an account", async () => {
    const r = await armWithdrawal(acct, 100_001, { accountNumber: "0123456789", bankCode: "058" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/cannot be more than/i);
    expect(armed()).toBe(false);
  });

  it("refuses more than the confirmed balance", async () => {
    // Balance is 50,000 confirmed inbound.
    handlers["wallets:listBeneficiaries"] = trusted;
    const r = await armWithdrawal(acct, 60_000, { beneficiaryName: "ADA" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/more than the available balance/i);
    expect(armed()).toBe(false);
  });

  it("counts money already withdrawn against the balance", async () => {
    // 50,000 in, 45,000 already out — only 5,000 is really available.
    handlers["wallets:withdrawnTotal"] = () => 4_500_000; // ₦45,000 in kobo
    handlers["wallets:listBeneficiaries"] = trusted;
    const r = await armWithdrawal(acct, 10_000, { beneficiaryName: "ADA" });
    expect(r.ok).toBe(false);
    expect(armed()).toBe(false);
  });
});

describe("worker security phrase", () => {
  it("blocks a worker's first withdrawal until a phrase is set", async () => {
    handlers["wallets:getByAccount"] = () => walletDoc({ accountId: acct });
    handlers["wallets:listBeneficiaries"] = trusted;
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "ADA" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.needsSecurityPhrase).toBe(true);
    expect(armed()).toBe(false);
  });

  it("puts workers in passphrase mode and never returns the phrase to the model", async () => {
    // Aide must not be able to say, hint at, or guess the worker's phrase.
    handlers["wallets:listBeneficiaries"] = trusted;
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "ADA" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.mode).toBe("passphrase");
    expect(r.ok && r.phrase).toBeUndefined();
  });

  it("gives employers a per-withdrawal word instead, which Aide may read out", async () => {
    handlers["accounts:getByKey"] = () => accountDoc({ key: acct, role: "employer", name: "ClearVoice Media" });
    handlers["wallets:getByAccount"] = () => walletDoc({ accountId: acct });
    handlers["wallets:listBeneficiaries"] = trusted;
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "ADA" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.mode).toBe("word");
    expect(r.ok && r.phrase).toBeTruthy();
  });
});

describe("destination resolution", () => {
  it("asks the bank who owns a typed account before going any further", async () => {
    // Aide reads this name aloud, so it must come from the bank, never the user.
    await armWithdrawal(acct, 1000, { accountNumber: "0123456789", bankCode: "058" });
    expect(bank.validate).toHaveBeenCalledWith("0123456789", "058");
  });

  it("reports the destination name back so Aide can read it out", async () => {
    handlers["wallets:listBeneficiaries"] = trusted;
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "ADA" });
    expect(r.ok && r.accountName).toBe("ADA OKAFOR");
  });

  it("refuses when the bank cannot find the account", async () => {
    bank.validate.mockRejectedValue(new Error("not found"));
    const r = await armWithdrawal(acct, 1000, { accountNumber: "0000000000", bankCode: "058" });
    expect(r.ok).toBe(false);
    expect(armed()).toBe(false);
  });

  it("refuses when no destination is given and none is saved", async () => {
    const r = await armWithdrawal(acct, 1000, {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/no destination/i);
  });

  it("asks which one when a beneficiary name is ambiguous", async () => {
    // Sending to the wrong "Ada" is unrecoverable, so ambiguity must stop.
    const old = Date.now() - 60 * 60 * 1000;
    handlers["wallets:listBeneficiaries"] = () => [
      { accountId: acct, accountName: "ADA OKAFOR", accountNumber: "1", bankCode: "058", at: old },
      { accountId: acct, accountName: "ADA NWOSU", accountNumber: "2", bankCode: "011", at: old },
    ];
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "ada" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/more than one/i);
    expect(armed()).toBe(false);
  });

  it("lists the options when there are several saved and none was named", async () => {
    const old = Date.now() - 60 * 60 * 1000;
    handlers["wallets:listBeneficiaries"] = () => [
      { accountId: acct, accountName: "ADA OKAFOR", accountNumber: "1", bankCode: "058", at: old },
      { accountId: acct, accountName: "BOLA ADE", accountNumber: "2", bankCode: "011", at: old },
    ];
    const r = await armWithdrawal(acct, 1000, {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("ADA OKAFOR");
    expect(!r.ok && r.message).toContain("BOLA ADE");
  });

  it("uses a single saved beneficiary without being asked", async () => {
    handlers["wallets:listBeneficiaries"] = () => [
      { accountId: acct, accountName: "ADA OKAFOR", accountNumber: "1", bankCode: "058", at: Date.now() - 60 * 60 * 1000 },
    ];
    const r = await armWithdrawal(acct, 1000, {});
    expect(r.ok).toBe(true);
    expect(r.ok && r.accountName).toBe("ADA OKAFOR");
  });

  it("refuses a named beneficiary that does not exist", async () => {
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "nobody" });
    expect(r.ok).toBe(false);
    expect(armed()).toBe(false);
  });
});

describe("new-beneficiary cooling-off hold", () => {
  // A spoken confirmation cannot defend against someone standing in the room —
  // they hear the word. What protects the money is that it can only go to a
  // destination registered earlier, so redirecting it costs time.
  it("holds an account typed in for the first time, even with the right phrase", async () => {
    // The important case: someone with a moment of access cannot point the
    // wallet at themselves and drain it in the same sitting.
    const r = await armWithdrawal(acct, 1000, { accountNumber: "0123456789", bankCode: "058" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/on hold/i);
    expect(armed()).toBe(false);
  });

  it("holds a beneficiary saved moments ago", async () => {
    handlers["wallets:listBeneficiaries"] = () => [
      { accountId: acct, accountName: "NEW PERSON", accountNumber: "9", bankCode: "058", at: Date.now() },
    ];
    const held = await armWithdrawal(acct, 1000, { beneficiaryName: "NEW PERSON" });
    expect(held.ok).toBe(false);
    expect(!held.ok && held.message).toMatch(/on hold/i);
    expect(armed()).toBe(false);
  });

  it("releases the destination once the hold has passed", async () => {
    handlers["wallets:listBeneficiaries"] = () => [
      { accountId: acct, accountName: "OLD FRIEND", accountNumber: "9", bankCode: "058", at: Date.now() - 60 * 60 * 1000 },
    ];
    const r = await armWithdrawal(acct, 1000, { beneficiaryName: "OLD FRIEND" });
    expect(r.ok).toBe(true);
  });
});

describe("confirmation failures are explained without leaking anything", () => {
  it("says so plainly when nothing is armed", async () => {
    handlers["wallets:consumePending"] = () => ({ ok: false, reason: "none" });
    const r = await verifyWithdrawal(acct, "mango");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/no withdrawal/i);
  });

  it("says so when the confirmation timed out", async () => {
    handlers["wallets:consumePending"] = () => ({ ok: false, reason: "expired" });
    const r = await verifyWithdrawal(acct, "mango");
    expect(!r.ok && r.message).toMatch(/timed out/i);
  });

  it("never reveals the worker's own phrase when it does not match", async () => {
    handlers["wallets:consumePending"] = () => ({ ok: false, reason: "mismatch", mode: "passphrase" });
    const r = await verifyWithdrawal(acct, "wrong");
    expect(!r.ok && r.message).toMatch(/security phrase/i);
    expect(!r.ok && r.message).not.toMatch(/sunny|garden|gate/i);
  });

  it("sends the hashed word-windows of what was spoken, not the raw phrase", async () => {
    // The phrase itself must never be reconstructable from what crosses the wire.
    handlers["wallets:consumePending"] = () => ({ ok: false, reason: "mismatch", mode: "passphrase" });
    await verifyWithdrawal(acct, "sunny garden gate");
    const call = calls.find((c) => c.name === "wallets:consumePending");
    expect(call?.args.candidateHashes.length).toBeGreaterThan(0);
    for (const h of call?.args.candidateHashes ?? []) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("balance is derived, never asserted", () => {
  it("counts only payments the bank confirmed as PAID", async () => {
    bank.transactions.mockResolvedValue({
      content: [
        { amount: 10000, paymentStatus: "PAID", transactionReference: "A" },
        { amount: 99999, paymentStatus: "PENDING", transactionReference: "B" },
        { amount: 88888, paymentStatus: "FAILED", transactionReference: "C" },
      ],
    });
    expect((await getBalance(acct)).balance).toBe(10000);
  });

  it("subtracts what has already been withdrawn", async () => {
    handlers["wallets:withdrawnTotal"] = () => 2_000_000; // ₦20,000 in kobo
    bank.transactions.mockResolvedValue({ content: [{ amount: 50000, paymentStatus: "PAID", transactionReference: "A" }] });
    expect((await getBalance(acct)).balance).toBe(30000);
  });

  it("never reports a negative balance", async () => {
    handlers["wallets:withdrawnTotal"] = () => 99_999_900; // ₦999,999 in kobo
    expect((await getBalance(acct)).balance).toBe(0);
  });

  it("reports zero for an account that has received nothing", async () => {
    bank.transactions.mockResolvedValue({ content: [] });
    expect((await getBalance(acct)).balance).toBe(0);
  });
});
