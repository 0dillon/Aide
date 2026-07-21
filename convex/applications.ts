import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Job applications in Convex: the worker↔employer loop (apply → assessed →
// hired/rejected/paid) has to be visible to BOTH parties regardless of which
// serverless instance served either request.

const applicationStatus = v.union(
  v.literal("applied"),
  v.literal("assessed"),
  v.literal("hired"),
  v.literal("rejected"),
  v.literal("paid"),
  v.literal("cancelled"),
);

export const listForAccount = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) =>
    await ctx.db.query("applications").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
});

export const getForJob = query({
  args: { accountId: v.string(), jobId: v.string() },
  handler: async (ctx, { accountId, jobId }) =>
    await ctx.db
      .query("applications")
      .withIndex("by_account_job", (q) => q.eq("accountId", accountId).eq("jobId", jobId))
      .first(),
});

// Idempotent apply: re-applying returns the existing application untouched, so
// a cancelled application stays cancelled (the one-way lockout is preserved).
export const apply = mutation({
  args: { accountId: v.string(), jobId: v.string() },
  handler: async (ctx, { accountId, jobId }) => {
    const existing = await ctx.db
      .query("applications")
      .withIndex("by_account_job", (q) => q.eq("accountId", accountId).eq("jobId", jobId))
      .first();
    if (existing) return existing;
    const id = await ctx.db.insert("applications", { accountId, jobId, status: "applied", verified: false });
    return await ctx.db.get(id);
  },
});

export const setStatus = mutation({
  args: {
    accountId: v.string(),
    jobId: v.string(),
    status: v.optional(applicationStatus),
    verified: v.optional(v.boolean()),
    assessmentResult: v.optional(v.string()),
    // Only apply the change when the application is currently in this status
    // (used by cancel, which may only cancel a still-"applied" assessment).
    requireStatus: v.optional(applicationStatus),
    requireUnverified: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const app = await ctx.db
      .query("applications")
      .withIndex("by_account_job", (q) => q.eq("accountId", a.accountId).eq("jobId", a.jobId))
      .first();
    if (!app) return null;
    const blocked =
      (a.requireStatus !== undefined && app.status !== a.requireStatus) ||
      (a.requireUnverified === true && app.verified);
    if (!blocked) {
      const patch: Record<string, unknown> = {};
      if (a.status !== undefined) patch.status = a.status;
      if (a.verified !== undefined) patch.verified = a.verified;
      if (a.assessmentResult !== undefined) patch.assessmentResult = a.assessmentResult;
      if (Object.keys(patch).length > 0) await ctx.db.patch(app._id, patch);
    }
    return await ctx.db.get(app._id);
  },
});
