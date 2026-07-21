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
  args: { accountId: v.string(), accountReference: v.string(), accountNumber: v.string(), bankName: v.string() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    const patch = { status: "active" as const, accountNumber: a.accountNumber, bankName: a.bankName, lastError: undefined };
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
    const patch = { payoutAccount: a.payoutAccount, payoutBankCode: a.payoutBankCode, payoutAccountName: a.payoutAccountName };
    if (w) await ctx.db.patch(w._id, patch);
    else await ctx.db.insert("wallets", { accountId: a.accountId, accountReference: a.accountReference, status: "unprovisioned", knownTxRefs: [], txSeeded: false, ...patch });
  },
});

// Arm a withdrawal (step 1). Overwrites any prior un-consumed pending.
export const armPending = mutation({
  args: { accountId: v.string(), amount: v.number(), phrase: v.string(), createdAt: v.number() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (w) await ctx.db.patch(w._id, { pendingWithdrawal: { amount: a.amount, phrase: a.phrase, createdAt: a.createdAt } });
  },
});

// Step 2, atomic: match the spoken phrase against the armed word within TTL and
// clear the pending in ONE transaction, so two concurrent confirms can never
// both authorize the same transfer (no double-spend).
export const consumePending = mutation({
  args: { accountId: v.string(), spokenPhrase: v.string(), now: v.number(), ttlMs: v.number() },
  handler: async (ctx, a) => {
    const w = await walletDoc(ctx, a.accountId);
    if (!w || !w.pendingWithdrawal) return { ok: false as const, reason: "none" as const };
    const p = w.pendingWithdrawal;
    if (a.now - p.createdAt > a.ttlMs) {
      await ctx.db.patch(w._id, { pendingWithdrawal: undefined });
      return { ok: false as const, reason: "expired" as const };
    }
    if (!phraseMatches(a.spokenPhrase, p.phrase)) {
      return { ok: false as const, reason: "mismatch" as const, phrase: p.phrase };
    }
    await ctx.db.patch(w._id, { pendingWithdrawal: undefined });
    return {
      ok: true as const,
      amount: p.amount,
      payoutAccount: w.payoutAccount,
      payoutBankCode: w.payoutBankCode,
      payoutAccountName: w.payoutAccountName,
    };
  },
});

// --- Withdrawal ledger (audit trail; makes balances honest) ---

export const recordWithdrawal = mutation({
  args: { accountId: v.string(), amount: v.number(), accountName: v.string(), status: v.string(), at: v.number() },
  handler: async (ctx, a) => {
    await ctx.db.insert("withdrawals", a);
  },
});

export const listWithdrawals = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) =>
    (await ctx.db.query("withdrawals").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()).sort((a, b) => b.at - a.at),
});

// Total already withdrawn (excludes FAILED) — the debit side of available balance.
export const withdrawnTotal = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const rows = await ctx.db.query("withdrawals").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    return rows.filter((r) => r.status !== "FAILED").reduce((s, r) => s + r.amount, 0);
  },
});
