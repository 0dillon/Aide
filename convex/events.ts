import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// The reactive event feed that replaces the in-process subscriber set + SSE +
// setInterval poller. The webhook (or the local poller) calls `publish`; every
// browser running `forAccount` for that account receives the new row live —
// even when the webhook and the browser hit different serverless instances,
// which is exactly what broke the old design on Vercel.

export const publish = mutation({
  args: {
    accountId: v.string(),
    type: v.union(v.literal("payment"), v.literal("notify")),
    amount: v.optional(v.number()),
    from: v.optional(v.string()),
    reference: v.optional(v.string()),
    message: v.optional(v.string()),
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Payments are deduped per account by transaction reference, so redelivery
    // from both the webhook and the poller announces the money only once.
    if (args.type === "payment" && args.reference) {
      const existing = await ctx.db
        .query("events")
        .withIndex("by_account_ref", (q) =>
          q.eq("accountId", args.accountId).eq("reference", args.reference),
        )
        .first();
      if (existing) return null;
    }
    await ctx.db.insert("events", {
      accountId: args.accountId,
      type: args.type,
      amount: args.amount,
      from: args.from,
      reference: args.reference,
      message: args.message,
      at: args.at ?? Date.now(),
    });
    return null;
  },
});

// Events for one account newer than `since` (the browser passes its mount time,
// so page history is never re-announced on reload). Ordered oldest-first so the
// client speaks them in the sequence they arrived.
export const forAccount = query({
  args: { accountId: v.string(), since: v.number() },
  handler: async (ctx, { accountId, since }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .filter((q) => q.gte(q.field("at"), since))
      .order("asc")
      .collect();
  },
});
