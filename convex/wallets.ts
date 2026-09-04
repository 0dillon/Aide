import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Wallets and the withdrawal ledger in Convex — shared across instances so a
// wallet provisioned (or a withdrawal recorded) on one serverless instance is
// visible everywhere. Fintech safety lives here: the confirm-word consume is a
// single atomic mutation, and balances are computed from the shared ledger.

async function walletDoc(ctx: QueryCtx | MutationCtx, accountId: string): Promise<Doc<"wallets"> | null> {
  return await ctx.db.query("wallets").withIndex("by_account", (q) => q.eq("accountId", accountId)).first();
}

// Kobo for any stored amount, whichever era wrote it — ledger rows and armed
// withdrawals alike. Anything written before the kobo migration carries naira
// in `amount`; reading one of those as kobo gives a hundredth of the real
// figure. On the ledger that understates what a worker has already taken out
// and invites them to withdraw money that is not there; on a pending it sends
// a hundredth of what they agreed to.
function koboOf(row: { amountKobo?: number; amount?: number }): number {
  if (row.amountKobo !== undefined) return row.amountKobo;
  if (row.amount !== undefined) return Math.round(row.amount * 100);
  // Neither field means an amount we cannot price. Guessing zero would inflate
  // the available balance; refuse instead, and let the caller say so out loud.
  throw new Error("Stored amount carries no figure in either naira or kobo");
}

// Loose match: the user may say "mango" or "the word is mango". ASR is
// imperfect, so we check the confirm word appears among the spoken tokens.
function phraseMatches(spoken: string, phrase: string): boolean {
  return spoken
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .includes(phrase);
}

export const getByAccount = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => await walletDoc(ctx, accountId),
});

export const listActive = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("wallets").collect()).filter((w) => w.status === "active"),
});

// Idempotent: create a default unprovisioned wallet only if none exists.
export const ensure = mutation({
  args: { accountId: v.string(), accountReference: v.string() },
  handler: async (ctx, { accountId, accountReference }) => {
    const existing = await walletDoc(ctx, accountId);
    if (existing) return;
    await ctx.db.insert("wallets", {
      accountId,
      accountReference,
      status: "unprovisioned",
      knownTxRefs: [],
      txSeeded: false,
    });
  },
});

export const setProvisioned = mutation({
  args: {
    accountId: v.string(),
    accountReference: v.string(),
    accountNumber: v.string(),
    bankName: v.string(),
    // Optional so the Monnify path, which has no separate bank-held name,
    // still calls this unchanged.
    accountName: v.optional(v.string()),
    provider: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    const patch = {
      status: "active" as const,
      provider: a.provider,
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      accountName: a.accountName,
      lastError: undefined,
    };
    if (w) await ctx.db.patch(w._id, patch);
    else await ctx.db.insert("wallets", { accountId: a.accountId, accountReference: a.accountReference, knownTxRefs: [], txSeeded: false, ...patch });
  },
});

export const setFailed = mutation({
  args: { accountId: v.string(), accountReference: v.string(), lastError: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (w) await ctx.db.patch(w._id, { status: "failed", lastError: a.lastError });
    else await ctx.db.insert("wallets", { accountId: a.accountId, accountReference: a.accountReference, status: "failed", lastError: a.lastError, knownTxRefs: [], txSeeded: false });
  },
});

export const setPayout = mutation({
  args: { accountId: v.string(), accountReference: v.string(), payoutAccount: v.string(), payoutBankCode: v.string(), payoutAccountName: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    // Re-saving the SAME destination doesn't restart the hold — only pointing
    // the money somewhere new does.
    const changed = w?.payoutAccount !== a.payoutAccount || w?.payoutBankCode !== a.payoutBankCode;
    const patch = {
      payoutAccount: a.payoutAccount,
      payoutBankCode: a.payoutBankCode,
      payoutAccountName: a.payoutAccountName,
      payoutSetAt: changed ? Date.now() : (w?.payoutSetAt ?? Date.now()),
    };
    if (w) await ctx.db.patch(w._id, patch);
    else await ctx.db.insert("wallets", { accountId: a.accountId, accountReference: a.accountReference, status: "unprovisioned", knownTxRefs: [], txSeeded: false, ...patch });
  },
});

// Worker's spoken security phrase — stored only as a hash of the normalized
// text; the Next server hashes candidate word-windows of what was spoken and
// the compare happens here.
export const setSecurityPhrase = mutation({
  args: { accountId: v.string(), accountReference: v.string(), hash: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (w) await ctx.db.patch(w._id, { securityPhraseHash: a.hash });
    else
      await ctx.db.insert("wallets", {
        accountId: a.accountId,
        accountReference: a.accountReference,
        status: "unprovisioned",
        securityPhraseHash: a.hash,
        knownTxRefs: [],
        txSeeded: false,
      });
  },
});

// Arm a withdrawal (step 1). Overwrites any prior un-consumed pending. Carries
// its own destination so each withdrawal can go to a different account.
export const armPending = mutation({
  args: {
    accountId: v.string(),
    amountKobo: v.number(),
    phrase: v.string(),
    mode: v.union(v.literal("word"), v.literal("passphrase")),
    destAccount: v.string(),
    destBankCode: v.string(),
    destAccountName: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (w)
      await ctx.db.patch(w._id, {
        pendingWithdrawal: {
          amountKobo: a.amountKobo,
          // Naira written alongside, so a rollback to the previous deploy
          // confirms this pending for the right figure rather than 100× it.
          amount: a.amountKobo / 100,
          phrase: a.phrase,
          mode: a.mode,
          destAccount: a.destAccount,
          destBankCode: a.destBankCode,
          destAccountName: a.destAccountName,
          createdAt: a.createdAt,
        },
      });
  },
});

// Step 2, atomic: match what was spoken against the armed check within TTL and
// clear the pending in ONE transaction, so two concurrent confirms can never
// both authorize the same transfer (no double-spend).
//   - mode "word" (employers): the random confirm word must appear among the
//     spoken tokens.
//   - mode "passphrase" (workers): one of the hashed word-windows of the
//     spoken text must equal the wallet's stored securityPhraseHash. This is
//     the accessible replacement for SMS OTP.
export const consumePending = mutation({
  args: {
    accountId: v.string(),
    spokenPhrase: v.string(),
    candidateHashes: v.optional(v.array(v.string())),
    now: v.number(),
    ttlMs: v.number(),
  },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w || !w.pendingWithdrawal) return { ok: false as const, reason: "none" as const };
    const p = w.pendingWithdrawal;
    if (a.now - p.createdAt > a.ttlMs) {
      await ctx.db.patch(w._id, { pendingWithdrawal: undefined });
      return { ok: false as const, reason: "expired" as const };
    }
    if (p.mode === "passphrase") {
      if (!w.securityPhraseHash || !(a.candidateHashes ?? []).includes(w.securityPhraseHash)) {
        return { ok: false as const, reason: "mismatch" as const, mode: "passphrase" as const };
      }
    } else if (!phraseMatches(a.spokenPhrase, p.phrase)) {
      return { ok: false as const, reason: "mismatch" as const, mode: "word" as const, phrase: p.phrase };
    }
    await ctx.db.patch(w._id, { pendingWithdrawal: undefined });
    return {
      ok: true as const,
      amountKobo: koboOf(p),
      // Per-withdrawal destination; legacy payout fields as fallback for any
      // pending armed before destinations existed.
      payoutAccount: p.destAccount ?? w.payoutAccount,
      payoutBankCode: p.destBankCode ?? w.payoutBankCode,
      payoutAccountName: p.destAccountName ?? w.payoutAccountName,
    };
  },
});

// --- BMONI Embedded provisioning ---

// Written the moment BMONI returns a user, BEFORE the wallet is created.
//
// BMONI guards create-user with a uniqueness check and answers a repeat with
// 409, but it publishes no endpoint to ask which user collided. So this id is
// unrecoverable if we lose it: we could neither use that user nor create
// another with the same phone. Persisting it first is what makes the rest of
// provisioning safe to resume after a crash.
export const setBmoniUser = mutation({
  args: { accountId: v.string(), accountReference: v.string(), bmoniUserId: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (w) await ctx.db.patch(w._id, { bmoniUserId: a.bmoniUserId });
    else
      await ctx.db.insert("wallets", {
        accountId: a.accountId,
        accountReference: a.accountReference,
        status: "unprovisioned",
        knownTxRefs: [],
        txSeeded: false,
        bmoniUserId: a.bmoniUserId,
      });
  },
});

// The sealed key is stored with the address it belongs to, in one write. They
// are useless apart: a key whose address BMONI never registered signs
// proposals that are accepted and never execute.
export const setBmoniOwnerKey = mutation({
  args: { accountId: v.string(), ownerAddress: v.string(), sealedOwnerKey: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w) throw new Error("Cannot store a BMONI owner key for an account with no wallet row");
    // Rotating a key after wallet creation would strand the wallet: BMONI's
    // signer snapshot still holds the original address, so the new key's
    // signatures would be recorded and never executed.
    if (w.bmoniOwnerAddress && w.bmoniOwnerAddress !== a.ownerAddress && w.bmoniSmartWalletId) {
      throw new Error("Refusing to replace the owner key of a wallet BMONI has already registered");
    }
    await ctx.db.patch(w._id, { bmoniOwnerAddress: a.ownerAddress, bmoniSealedOwnerKey: a.sealedOwnerKey });
  },
});

export const setBmoniWallet = mutation({
  args: { accountId: v.string(), smartWalletId: v.string(), walletAddress: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w) throw new Error("Cannot record a BMONI smart wallet for an account with no wallet row");
    // Wallet creation has no uniqueness guard at BMONI, so a second one can
    // genuinely exist. Refusing here keeps us pointed at the first, which is
    // the one whose address deposits were routed to.
    if (w.bmoniSmartWalletId && w.bmoniSmartWalletId !== a.smartWalletId) {
      throw new Error(`Account already has BMONI smart wallet ${w.bmoniSmartWalletId}; refusing to overwrite`);
    }
    await ctx.db.patch(w._id, { bmoniSmartWalletId: a.smartWalletId, bmoniWalletAddress: a.walletAddress });
  },
});

// Remember a registered withdrawal destination so a repeat withdrawal to the
// same account skips re-registering it.
export const rememberBmoniBankAccount = mutation({
  args: { accountId: v.string(), key: v.string(), bankAccountId: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w) return;
    const rows = w.bmoniBankAccountIds ?? [];
    if (rows.some((r) => r.key === a.key)) return;
    await ctx.db.patch(w._id, { bmoniBankAccountIds: [...rows, { key: a.key, id: a.bankAccountId }] });
  },
});

// Record a proposal the instant BMONI returns one, before it is approved or
// signed. Atomic claim: if another in-flight proposal is already recorded, this
// refuses rather than overwriting it. Overwriting would lose the only handle we
// have on a real payout sitting at BMONI, and the next attempt would create a
// second one for the same wages.
export const claimBmoniProposal = mutation({
  args: { accountId: v.string(), proposalId: v.string(), amountKobo: v.number(), at: v.number() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w) throw new Error("Cannot record a BMONI proposal for an account with no wallet row");
    const existing = w.bmoniPendingProposal;
    if (existing && existing.proposalId !== a.proposalId) {
      return { ok: false as const, inFlight: existing.proposalId };
    }
    await ctx.db.patch(w._id, {
      bmoniPendingProposal: { proposalId: a.proposalId, amountKobo: a.amountKobo, createdAt: a.at },
    });
    return { ok: true as const };
  },
});

// Cleared only once the proposal reached a terminal status. An unknown status
// deliberately does NOT clear it — leaving it in flight blocks a second payout
// until someone establishes what happened to the first.
export const clearBmoniProposal = mutation({
  args: { accountId: v.string(), proposalId: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w || w.bmoniPendingProposal?.proposalId !== a.proposalId) return;
    await ctx.db.patch(w._id, { bmoniPendingProposal: undefined });
  },
});

// --- Beneficiaries: saved withdrawal destinations ---

export const listBeneficiaries = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) =>
    (await ctx.db.query("beneficiaries").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()).sort(
      (a, b) => b.at - a.at,
    ),
});

// Idempotent by (accountNumber, bankCode) per account.
export const saveBeneficiary = mutation({
  args: {
    accountId: v.string(),
    accountName: v.string(),
    accountNumber: v.string(),
    bankCode: v.string(),
    bankName: v.optional(v.string()),
    at: v.number(),
  },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("beneficiaries").withIndex("by_account", (q) => q.eq("accountId", a.accountId)).collect();
    const existing = rows.find((b) => b.accountNumber === a.accountNumber && b.bankCode === a.bankCode);
    if (existing) return { created: false as const };
    await ctx.db.insert("beneficiaries", a);
    return { created: true as const };
  },
});

// --- Withdrawal ledger (audit trail; makes balances honest) ---

export const recordWithdrawal = mutation({
  args: {
    accountId: v.string(),
    amountKobo: v.number(),
    accountName: v.string(),
    status: v.string(),
    at: v.number(),
    provider: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    // `amount` is written too, in naira, so a rollback to the previous deploy
    // still reads a correct figure rather than one a hundred times too big.
    await ctx.db.insert("withdrawals", { ...a, amount: a.amountKobo / 100 });
  },
});

// Scoped to one provider. Rows made through a provider this deployment no
// longer talks to are stuck at whatever status they had when the switch
// happened — "processing", for ever — and Aide reads this list ALOUD. A worker
// asking what they have sent would otherwise hear old transfers to names they
// may not recognise, described as still in flight, with no screen on which to
// notice the dates.
//
// Rows with no provider recorded are Monnify's: the field did not exist until
// BMONI arrived. Filtered in the handler rather than the index because the
// stored value is absent, not "monnify", so there is nothing to match on.
export const listWithdrawals = query({
  args: { accountId: v.string(), provider: v.optional(v.string()) },
  handler: async (ctx, { accountId, provider }) => {
    const rows = await ctx.db
      .query("withdrawals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect();
    const live = provider
      ? rows.filter((r) => (r.provider ?? "monnify") === provider)
      : rows;
    return live.sort((a, b) => b.at - a.at);
  },
});

// Total already withdrawn in KOBO (excludes FAILED) — the debit side of
// available balance. Integer throughout: summing naira floats drifts, and the
// drift lands on someone who cannot see the number to challenge it.
export const withdrawnTotal = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const rows = await ctx.db.query("withdrawals").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    return rows.filter((r) => r.status !== "FAILED").reduce((s, r) => s + koboOf(r), 0);
  },
});
