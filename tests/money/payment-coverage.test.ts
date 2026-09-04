import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, walletDoc, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// "Paid" is a claim about the real world. An employer can press the button, and
// Aide can be asked to say it, but neither may make it true — only money that
// actually arrived can. This is the check that enforces that, and it is the
// only thing standing between a worker and being told they were paid when they
// were not.

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
  getReservedAccount: () => Promise.resolve({ accountReference: "aide-demo-worker", accountName: "x", accounts: [{ accountNumber: "1", bankName: "b", bankCode: "058" }] }),
  createReservedAccount: () => Promise.resolve({ accountReference: "aide-demo-worker", accountName: "x", accounts: [{ accountNumber: "1", bankName: "b", bankCode: "058" }] }),
  validateBankAccount: vi.fn(),
  singleTransfer: vi.fn(),
  isValidWebhook: () => true,
  verifyTransaction: vi.fn(),
}));

// Imported fresh for every test. The store keeps a short-lived balance cache
// keyed by account, and coverage always asks about the same worker — so
// without a module reset the first test's balance would answer them all.
let verifyPaymentCoverage: typeof import("../../lib/store/applications").verifyPaymentCoverage;

// Two gigs, so the "already claimed" arithmetic can be exercised.
const GIG_A = { jobId: "g-a", title: "Gig A", task: "t", skill: "s", pay: 12000, employer: "ClearVoice Media", requiresAssessment: false, at: 1 };
const GIG_B = { jobId: "g-b", title: "Gig B", task: "t", skill: "s", pay: 8000, employer: "ClearVoice Media", requiresAssessment: false, at: 2 };
// Two gigs priced in kobo, chosen because summing them as naira floats drifts:
// 179.19 + 9525.61 comes to fractionally MORE than the 9704.80 that covers
// them, so a fully-paid worker reads as unpaid. Gig pay with kobo in it is
// ordinary — hourly rates and split payments both produce it.
const GIG_KOBO = { jobId: "g-k", title: "Gig K", task: "t", skill: "s", pay: 9525.61, employer: "ClearVoice Media", requiresAssessment: false, at: 3 };
const GIG_KOBO_PRIOR = { jobId: "g-kp", title: "Gig KP", task: "t", skill: "s", pay: 179.19, employer: "ClearVoice Media", requiresAssessment: false, at: 4 };

let calls: ConvexCall[];
let handlers: Handlers;
let inbound: number;
let paidApps: any[];

beforeEach(async () => {
  // These exercise the Monnify adapter specifically — the Monnify HTTP module
  // is what they mock. BMONI is the default provider now, so the rail under
  // test is named rather than assumed; without this they would run against
  // BMONI and fail on a missing sandbox user rather than on anything they are
  // actually asserting.
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "monnify");
  vi.resetModules();
  ({ verifyPaymentCoverage } = await import("../../lib/store/applications"));
  calls = [];
  inbound = 0;
  paidApps = [];
  handlers = {
    "jobs:listPosted": () => [GIG_A, GIG_B, GIG_KOBO, GIG_KOBO_PRIOR],
    "accounts:seedDefaults": () => null,
    "accounts:getByKey": () => ({ key: "demo-worker", name: "Worker", role: "worker", skills: [], bio: "", preferences: [], createdAt: 1 }),
    "wallets:getByAccount": () => walletDoc({ accountId: "demo-worker", accountReference: "aide-demo-worker" }),
    "wallets:ensure": () => null,
    "wallets:withdrawnTotal": () => 0,
    "applications:listForAccount": () => paidApps,
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
  bank.transactions.mockReset();
  // The wallet's confirmed inbound total is whatever the test sets.
  bank.transactions.mockImplementation(() =>
    Promise.resolve({ content: inbound ? [{ amount: inbound, paymentStatus: "PAID", transactionReference: "TX" }] : [] }),
  );
});

// Coverage is now checked against a NAMED worker's wallet rather than a
// hardcoded one, so every call has to say whose money it is talking about.
const WORKER = "demo-worker";

describe("verifyPaymentCoverage", () => {
  it("refuses when no money has arrived at all", async () => {
    inbound = 0;
    const r = await verifyPaymentCoverage(WORKER, "g-a");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no confirmed payment/i);
  });

  it("refuses when the money that arrived is not enough", async () => {
    inbound = 5000; // gig pays 12000
    expect((await verifyPaymentCoverage(WORKER, "g-a")).ok).toBe(false);
  });

  it("allows it once enough has genuinely landed", async () => {
    inbound = 12000;
    expect((await verifyPaymentCoverage(WORKER, "g-a")).ok).toBe(true);
  });

  it("allows it at the exact amount, not a naira more", async () => {
    inbound = 12000;
    const r = await verifyPaymentCoverage(WORKER, "g-a");
    expect(r.ok).toBe(true);
  });

  it("refuses one naira short", async () => {
    inbound = 11999;
    expect((await verifyPaymentCoverage(WORKER, "g-a")).ok).toBe(false);
  });

  it("will not let one payment be claimed by two different gigs", async () => {
    // 12,000 arrived and Gig A already claimed it. Gig B cannot also be paid
    // from the same money — this is the double-count that would let an employer
    // close out several gigs on a single transfer.
    inbound = 12000;
    paidApps = [{ _id: "a1", accountId: "demo-worker", jobId: "g-a", status: "paid", verified: true }];
    const r = await verifyPaymentCoverage(WORKER, "g-b");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already claimed/i);
  });

  it("allows the second gig once enough arrived to cover both", async () => {
    inbound = 20000; // 12000 + 8000
    paidApps = [{ _id: "a1", accountId: "demo-worker", jobId: "g-a", status: "paid", verified: true }];
    expect((await verifyPaymentCoverage(WORKER, "g-b")).ok).toBe(true);
  });

  it("does not count gigs that are merely hired against the balance", async () => {
    // Only "paid" claims money. A hired-but-unpaid gig has taken nothing yet.
    inbound = 12000;
    paidApps = [{ _id: "a1", accountId: "demo-worker", jobId: "g-b", status: "hired", verified: true }];
    expect((await verifyPaymentCoverage(WORKER, "g-a")).ok).toBe(true);
  });

  it("says exactly how much more is needed, so the employer can act", async () => {
    inbound = 5000;
    const r = await verifyPaymentCoverage(WORKER, "g-a");
    expect(r.message).toContain("7000");
  });

  it("allows a gig covered exactly, to the kobo, across two pays that drift as floats", async () => {
    // ₦179.19 is already claimed and ₦9,525.61 is due: ₦9,704.80 exactly, and
    // exactly that much landed. In naira floats the sum lands a hair ABOVE the
    // balance, so the worker is told they have not been paid for money that is
    // sitting in their account.
    inbound = 9704.8;
    paidApps = [{ _id: "a1", accountId: "demo-worker", jobId: "g-kp", status: "paid", verified: true }];
    expect((await verifyPaymentCoverage(WORKER, "g-k")).ok).toBe(true);
  });

  it("never says a shortfall Aide cannot read out loud", async () => {
    // The refusal is spoken. A shortfall of 1.8189894035458565e-12 naira is not
    // a sentence, and the worker cannot glance at the screen to see it is
    // nonsense — so any shortfall must be a real, sayable amount of money.
    inbound = 9704.79; // genuinely one kobo short
    paidApps = [{ _id: "a1", accountId: "demo-worker", jobId: "g-kp", status: "paid", verified: true }];
    const r = await verifyPaymentCoverage(WORKER, "g-k");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\b0\.01 naira more must land/);
  });

  it("refuses a gig that does not exist rather than defaulting to allowed", async () => {
    inbound = 999999;
    expect((await verifyPaymentCoverage(WORKER, "nope")).ok).toBe(false);
  });
});
