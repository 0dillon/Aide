import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// The reactive onboarding channel between an employer and the worker they
// hired. `send` appends a message; every browser running `listForJob` for that
// gig receives it live — even when the two parties are served by different
// serverless instances, the same cross-instance guarantee the events feed
// relies on. Access control (only a party to the gig, only after hire) is
// enforced in the Next API route and the agent tools before these run.

export const send = mutation({
  args: {
    jobId: v.string(),
    workerAccountId: v.string(),
    from: v.union(v.literal("worker"), v.literal("employer")),
    authorName: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("messages", { ...args, at: Date.now() });
    return await ctx.db.get(id);
  },
});

// The whole thread for a gig, oldest-first so it reads top-to-bottom.
export const listForJob = query({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) =>
    await ctx.db
      .query("messages")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .order("asc")
      .collect(),
});
