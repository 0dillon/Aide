import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Convex is the shared datastore that replaces the in-memory globalThis store.
// The whole point: on Vercel serverless, instances don't share memory, so the
// webhook that records a payment and the browser's live subscription land on
// different machines. Convex tables + reactive queries make that cross-instance
// by construction — the "money just landed" alert fires no matter which
// instance the webhook hit.
//
// Our own string ids ("demo-worker", "u-xxxx", "aide-<id>") are kept as plain
// fields (accountId / key), separate from Convex's own _id, so existing cookies,
// wallet references, and Monnify customer records keep working unchanged.

const role = v.union(v.literal("worker"), v.literal("employer"));

const applicationStatus = v.union(
  v.literal("applied"),
  v.literal("assessed"),
  v.literal("hired"),
  v.literal("rejected"),
  v.literal("paid"),
  v.literal("cancelled"),
);

export default defineSchema({
  accounts: defineTable({
    key: v.string(), // our string id, e.g. "demo-worker" or "u-ab12cd34"
    name: v.string(),
    email: v.optional(v.string()),
    role,
    createdAt: v.number(),
    skills: v.array(v.string()),
    bio: v.string(),
    passwordHash: v.optional(v.string()), // never leaves the server
  })
    .index("by_key", ["key"])
    .index("by_email", ["email"]),

  wallets: defineTable({
    accountId: v.string(),
    accountReference: v.string(),
    status: v.union(v.literal("unprovisioned"), v.literal("active"), v.literal("failed")),
    accountNumber: v.optional(v.string()),
    bankName: v.optional(v.string()),
    lastError: v.optional(v.string()),
    payoutAccount: v.optional(v.string()),
    payoutBankCode: v.optional(v.string()),
    payoutAccountName: v.optional(v.string()),
    payoutSetAt: v.optional(v.number()),
    // Worker's personal spoken security phrase (hash of the normalized text).
    // Replaces SMS OTP, which a blind user cannot read: withdrawals from
    // worker accounts are confirmed by speaking this phrase. Employers keep
    // the per-withdrawal random confirm word instead.
    securityPhraseHash: v.optional(v.string()),
    pendingWithdrawal: v.optional(
      v.object({
        amount: v.number(),
        phrase: v.string(),
        // "word": match the random word in `phrase` (employers).
        // "passphrase": match the wallet's securityPhraseHash (workers).
        mode: v.optional(v.union(v.literal("word"), v.literal("passphrase"))),
        // Per-withdrawal destination — users are not locked to one account.
        destAccount: v.optional(v.string()),
        destBankCode: v.optional(v.string()),
        destAccountName: v.optional(v.string()),
        createdAt: v.number(),
      }),
    ),
    // knownTxRefs is a Set in memory; Convex stores it as an array we treat as a set.
    knownTxRefs: v.array(v.string()),
    txSeeded: v.boolean(),
  }).index("by_account", ["accountId"]),

  withdrawals: defineTable({
    accountId: v.string(),
    amount: v.number(),
    accountName: v.string(),
    status: v.string(),
    at: v.number(),
  }).index("by_account", ["accountId"]),

  // Saved withdrawal destinations ("beneficiaries"), per account. Offered for
  // saving after a successful payment to a new account — voice or screen.
  beneficiaries: defineTable({
    accountId: v.string(),
    accountName: v.string(),
    accountNumber: v.string(),
    bankCode: v.string(),
    bankName: v.optional(v.string()),
    at: v.number(),
  }).index("by_account", ["accountId"]),

  // Employer-posted gigs only. The four seeded demo jobs stay static in code
  // (they never change); anything an employer posts at runtime must be shared
  // across instances or it vanishes for everyone but the instance that took it.
  postedJobs: defineTable({
    jobId: v.string(),
    title: v.string(),
    task: v.string(),
    skill: v.string(),
    pay: v.number(),
    employer: v.string(),
    requiresAssessment: v.boolean(),
    assessmentType: v.optional(v.union(v.literal("oral"), v.literal("mcq"))),
    assessmentQuestion: v.optional(v.string()),
    mcqQuestions: v.optional(
      v.array(v.object({ question: v.string(), options: v.array(v.string()), correctIndex: v.number() })),
    ),
    timeLimit: v.optional(v.number()),
    at: v.number(),
  }).index("by_jobId", ["jobId"]),

  // Assessment start timestamps, for time-limited assessments.
  attempts: defineTable({
    key: v.string(), // `${userId}-${jobId}`
    startedAt: v.number(),
  }).index("by_key", ["key"]),

  applications: defineTable({
    accountId: v.string(),
    jobId: v.string(),
    status: applicationStatus,
    verified: v.boolean(),
    assessmentResult: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_job", ["accountId", "jobId"]),

  // The reactive replacement for the subscriber-set + SSE + poller. The webhook
  // (or the poller) inserts an event row; the browser's useQuery on this table
  // reactively receives it — even across serverless instances. Payment events
  // are deduped per account by (accountId, reference) before insert.
  events: defineTable({
    accountId: v.string(),
    type: v.union(v.literal("payment"), v.literal("notify")),
    amount: v.optional(v.number()),
    from: v.optional(v.string()),
    reference: v.optional(v.string()),
    message: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_account_ref", ["accountId", "reference"]),

  // External listings Aide scraped from the open web, and the ones the worker
  // is tracking — both were per-session arrays on globalThis.
  externalJobs: defineTable({
    accountId: v.string(),
    extId: v.string(),
    title: v.string(),
    company: v.string(),
    url: v.string(),
    skill: v.string(),
    source: v.string(),
  }).index("by_account", ["accountId"]),

  externalApps: defineTable({
    accountId: v.string(),
    externalJobId: v.string(),
    title: v.string(),
    company: v.string(),
    url: v.string(),
    status: v.literal("tracked"),
    at: v.number(),
  }).index("by_account", ["accountId"]),
});
