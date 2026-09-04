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
    // Durable facts the user has asked Aide to remember ("I can only work
    // mornings"). Deliberately separate from the conversation: the transcript
    // is a verbatim log and is no longer persisted anywhere, while these are
    // the few things worth keeping — said once, and still here tomorrow.
    // Optional so accounts written before this field existed still validate.
    preferences: v.optional(v.array(v.string())),
    passwordHash: v.optional(v.string()), // never leaves the server
    // BMONI needs a first/last name split and a phone number, neither of which
    // Aide collected — `name` is one free-text string and phone was never
    // asked for. Optional so every existing account still validates; the BMONI
    // provisioning path refuses rather than inventing a split it cannot know.
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phoneNumber: v.optional(v.string()), // E.164, e.g. +2348000000000
    // Bank Verification Number, 11 digits. Nigerian onboarding needs it to
    // issue the virtual account a worker is paid into. Optional because most
    // accounts do not have one yet, and provisioning refuses rather than
    // guessing — a wrong BVN fails KYC in a way nobody can debug later.
    bvn: v.optional(v.string()),
  })
    .index("by_key", ["key"])
    .index("by_email", ["email"]),

  wallets: defineTable({
    accountId: v.string(),
    accountReference: v.string(),
    status: v.union(v.literal("unprovisioned"), v.literal("active"), v.literal("failed")),
    // Which provider provisioned this wallet. A row without one predates the
    // field and is Monnify's, because Monnify is all there was.
    //
    // This is what makes "active" mean anything after a provider switch:
    // without it, a wallet Monnify provisioned looks finished forever, so it
    // is never given a BMONI wallet and every BMONI call fails on an account
    // that appears perfectly healthy.
    provider: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    bankName: v.optional(v.string()),
    // The name the BANK holds for this account. Not the Aide profile name —
    // BMONI returns "Dillon Bunch" for a profile reading "Bunch Dillon", and
    // "Jabo Samson Joe" for one reading "ClearVoice Media". Whoever pays in
    // sees this during their own name enquiry, so it is the only name Aide may
    // present as the account holder.
    accountName: v.optional(v.string()),
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
        // Kobo in `amountKobo`. `amount` is the pre-migration naira field, kept
        // readable and still written: a pending armed minutes before a deploy
        // is confirmed after it, and that confirmation must move the amount the
        // worker actually agreed to — in whichever era either half ran.
        amount: v.optional(v.number()),
        amountKobo: v.optional(v.number()),
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

    // ---- BMONI Embedded ----
    // All optional: Monnify remains the default provider and a wallet that has
    // never touched BMONI carries none of these.
    //
    // bmoniUserId is the one that must survive a crash. BMONI guards
    // create-user with a uniqueness check and returns 409 on a repeat, but
    // publishes no endpoint to ask WHICH user collided — so if we lose this
    // value we can neither use the user nor recreate them. It is written
    // before anything else depends on it for that reason.
    bmoniUserId: v.optional(v.string()),
    bmoniSmartWalletId: v.optional(v.string()),
    bmoniWalletAddress: v.optional(v.string()),
    // The owner key's public address, registered with BMONI at wallet
    // creation. The proposal signer must recover to exactly this; if it does
    // not, BMONI records the signature and silently never executes it.
    bmoniOwnerAddress: v.optional(v.string()),
    // The owner private key, AES-256-GCM sealed (see lib/banking/keys.ts).
    // Never returned to the client, never logged. Whoever holds the plaintext
    // can sign a transfer out of this wallet.
    bmoniSealedOwnerKey: v.optional(v.string()),
    // Registered Nigerian withdrawal destinations, BMONI's bankAccountId keyed
    // by "accountNumber:bankCode" so a repeat withdrawal skips re-registering.
    bmoniBankAccountIds: v.optional(v.array(v.object({ key: v.string(), id: v.string() }))),
    // An offramp or transfer that has been CREATED at BMONI but not yet seen
    // through to a terminal status.
    //
    // This is the double-payment guard. The payout flow is several calls —
    // create, approve, fetch payload, sign — and a failure anywhere after the
    // first one leaves a real proposal sitting at BMONI. Starting over would
    // create a SECOND payout for the same wages. So the id is recorded the
    // moment it exists, and no new payout may start while one is in flight:
    // the flow resumes from here instead.
    bmoniPendingProposal: v.optional(
      v.object({ proposalId: v.string(), amountKobo: v.number(), createdAt: v.number() }),
    ),
  }).index("by_account", ["accountId"]),

  // Money here is integer kobo, in `amountKobo`. `amount` is the pre-migration
  // naira field: still readable so rows written before the change keep counting
  // (see koboOf in wallets.ts), and still written alongside so rolling back to
  // the previous deploy does not read every row as a hundredth of itself. Drop
  // it once no deployed code reads `amount`.
  withdrawals: defineTable({
    accountId: v.string(),
    amount: v.optional(v.number()),
    amountKobo: v.optional(v.number()),
    accountName: v.string(),
    status: v.string(),
    at: v.number(),
    // Who actually moved the money. Absent means Monnify: every row written
    // before this field existed was theirs, and a Monnify reference can never
    // advance once the deployment has switched — so those rows sit at
    // "processing" for ever and must not be read out as money still in flight.
    provider: v.optional(v.string()),
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
    // Who posted it. `employer` is a display name and two accounts can share
    // one, so it cannot decide who may edit or delete a gig. Optional because
    // gigs written before this field existed must still validate.
    employerAccountId: v.optional(v.string()),
    requiresAssessment: v.boolean(),
    assessmentType: v.optional(v.union(v.literal("oral"), v.literal("mcq"))),
    assessmentQuestion: v.optional(v.string()),
    mcqQuestions: v.optional(
      v.array(v.object({ question: v.string(), options: v.array(v.string()), correctIndex: v.number() })),
    ),
    timeLimit: v.optional(v.number()),
    at: v.number(),
  })
    .index("by_jobId", ["jobId"])
    .index("by_employer", ["employerAccountId"]),

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
    .index("by_account_job", ["accountId", "jobId"])
    // An employer starts from their gig, not from a worker: hiring, rejecting
    // and marking paid all need "who applied to this job". Without it those
    // paths had to guess, and guessed the demo worker every time.
    .index("by_job", ["jobId"]),

  // The post-hire onboarding channel. Once an employer hires an applicant, this
  // is the only place they can pass job-specific directives, credentials, or
  // next steps. Keyed by the gig (jobId) — one applicant per gig in this demo —
  // and reactive, so each new message reaches the other party's browser (and
  // their Aide, which reads it aloud) across serverless instances, exactly like
  // the events feed. `from` records which side spoke; workerAccountId ties the
  // thread to the applicant it belongs to.
  messages: defineTable({
    jobId: v.string(),
    workerAccountId: v.string(),
    from: v.union(v.literal("worker"), v.literal("employer")),
    // Who actually wrote it. authorName is a display name and cannot authorise
    // a delete. Optional so messages written before this field existed validate.
    authorAccountId: v.optional(v.string()),
    authorName: v.string(),
    text: v.string(),
    at: v.number(),
  }).index("by_job", ["jobId"]),

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
