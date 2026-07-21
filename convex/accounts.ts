import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Accounts in Convex: shared across serverless instances so an account created
// (or a profile edited) on one instance is visible everywhere — the in-memory
// Map behind the old store forked per instance on Vercel. Our own string id
// lives in `key`; Convex's _id is internal.

const role = v.union(v.literal("worker"), v.literal("employer"));

export const getByKey = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    await ctx.db.query("accounts").withIndex("by_key", (q) => q.eq("key", key)).first(),
});

export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const norm = email.trim().toLowerCase();
    const all = await ctx.db.query("accounts").collect();
    return all.find((a) => a.email?.toLowerCase() === norm) ?? null;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("accounts").collect(),
});

// Idempotent create — safe to retry, and never clobbers an existing account.
export const create = mutation({
  args: {
    key: v.string(),
    name: v.string(),
    role,
    email: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    skills: v.array(v.string()),
    bio: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("accounts").withIndex("by_key", (q) => q.eq("key", a.key)).first();
    if (existing) return;
    await ctx.db.insert("accounts", a);
  },
});

export const updateProfile = mutation({
  args: {
    key: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
    bio: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const acc = await ctx.db.query("accounts").withIndex("by_key", (q) => q.eq("key", a.key)).first();
    if (!acc) return;
    const patch: Record<string, unknown> = {};
    if (a.name !== undefined) patch.name = a.name.trim();
    if (a.email !== undefined) patch.email = a.email.trim();
    if (a.skills !== undefined) patch.skills = a.skills.map((s) => s.trim()).filter(Boolean);
    if (a.bio !== undefined) patch.bio = a.bio.trim();
    await ctx.db.patch(acc._id, patch);
  },
});

// Seed the two demo identities once, so the passwordless fallback account
// (demo-worker) exists on a fresh deployment. Idempotent.
export const seedDefaults = mutation({
  args: {
    accounts: v.array(
      v.object({
        key: v.string(),
        name: v.string(),
        role,
        email: v.optional(v.string()),
        skills: v.array(v.string()),
        bio: v.string(),
        createdAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, { accounts }) => {
    for (const a of accounts) {
      const existing = await ctx.db.query("accounts").withIndex("by_key", (q) => q.eq("key", a.key)).first();
      if (!existing) await ctx.db.insert("accounts", a);
    }
  },
});
