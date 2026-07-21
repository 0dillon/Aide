import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Employer-posted gigs, external listings, and assessment attempt timestamps —
// all shared across instances. The four seeded demo jobs stay static in code.

const mcq = v.object({ question: v.string(), options: v.array(v.string()), correctIndex: v.number() });

export const listPosted = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("postedJobs").collect()).sort((a, b) => a.at - b.at),
});

export const post = mutation({
  args: {
    jobId: v.string(),
    title: v.string(),
    task: v.string(),
    skill: v.string(),
    pay: v.number(),
    employer: v.string(),
    requiresAssessment: v.boolean(),
    assessmentType: v.optional(v.union(v.literal("oral"), v.literal("mcq"))),
    assessmentQuestion: v.optional(v.string()),
    mcqQuestions: v.optional(v.array(mcq)),
    timeLimit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("postedJobs", { ...a, at: Date.now() });
  },
});

// --- Assessment attempts (time-limited assessments) ---

export const getAttempt = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("attempts").withIndex("by_key", (q) => q.eq("key", key)).first();
    return row?.startedAt ?? null;
  },
});

export const recordAttempt = mutation({
  args: { key: v.string(), startedAt: v.number() },
  handler: async (ctx, { key, startedAt }) => {
    const row = await ctx.db.query("attempts").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (row) await ctx.db.patch(row._id, { startedAt });
    else await ctx.db.insert("attempts", { key, startedAt });
  },
});

export const clearAttempt = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("attempts").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (row) await ctx.db.delete(row._id);
  },
});

// --- External listings Aide found on the open web ---

export const listExternalJobs = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) =>
    await ctx.db.query("externalJobs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
});

// A scan replaces the previous result set for that account.
export const setExternalJobs = mutation({
  args: {
    accountId: v.string(),
    jobs: v.array(
      v.object({ extId: v.string(), title: v.string(), company: v.string(), url: v.string(), skill: v.string(), source: v.string() }),
    ),
  },
  handler: async (ctx, { accountId, jobs }) => {
    const old = await ctx.db.query("externalJobs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    for (const row of old) await ctx.db.delete(row._id);
    for (const j of jobs) await ctx.db.insert("externalJobs", { accountId, ...j });
  },
});

export const listExternalApps = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) =>
    (await ctx.db.query("externalApps").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()).sort((a, b) => b.at - a.at),
});

// Idempotent: tracking the same listing twice returns the existing record.
export const trackExternal = mutation({
  args: { accountId: v.string(), externalJobId: v.string() },
  handler: async (ctx, { accountId, externalJobId }) => {
    const existing = (await ctx.db.query("externalApps").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()).find(
      (a) => a.externalJobId === externalJobId,
    );
    if (existing) return existing;
    const job = (await ctx.db.query("externalJobs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect()).find(
      (j) => j.extId === externalJobId,
    );
    if (!job) return null;
    const id = await ctx.db.insert("externalApps", {
      accountId,
      externalJobId,
      title: job.title,
      company: job.company,
      url: job.url,
      status: "tracked",
      at: Date.now(),
    });
    return await ctx.db.get(id);
  },
});
