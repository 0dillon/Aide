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

// --- Preferences: the durable half of Aide's memory ---
//
// The conversation transcript is not persisted anywhere any more, so anything
// worth having next time has to be stated as a preference and kept here, on
// the account. Unlike the old sessionStorage transcript — which died with the
// browser tab — this survives reloads, new tabs, and tomorrow.

// Every preference is injected into the model's prompt on every turn, so this
// cap is a token budget as much as a storage one.
const MAX_PREFERENCES = 30;

export const addPreference = mutation({
  args: { key: v.string(), text: v.string() },
  handler: async (ctx, { key, text }) => {
    const acc = await ctx.db.query("accounts").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (!acc) return { ok: false as const, message: "No account with that id." };
    const clean = text.trim();
    if (!clean) return { ok: false as const, message: "There is nothing to remember." };
    const current = acc.preferences ?? [];
    // Saying the same thing twice must not produce two entries.
    if (current.some((p) => p.toLowerCase() === clean.toLowerCase())) {
      return { ok: true as const, added: false, preferences: current };
    }
    const next = [...current, clean].slice(-MAX_PREFERENCES);
    await ctx.db.patch(acc._id, { preferences: next });
    return { ok: true as const, added: true, preferences: next };
  },
});

export const removePreference = mutation({
  args: { key: v.string(), text: v.string() },
  handler: async (ctx, { key, text }) => {
    const acc = await ctx.db.query("accounts").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (!acc) return { ok: false as const, message: "No account with that id." };
    const needle = text.trim().toLowerCase();
    if (!needle) return { ok: false as const, message: "There is nothing to forget." };
    const current = acc.preferences ?? [];
    // Matched loosely on purpose: someone speaking will paraphrase what they
    // want dropped rather than quote it back word for word.
    const next = current.filter((p) => !p.toLowerCase().includes(needle));
    if (next.length === current.length) {
      return { ok: false as const, message: "No saved preference matches that." };
    }
    await ctx.db.patch(acc._id, { preferences: next });
    return { ok: true as const, removed: current.length - next.length, preferences: next };
  },
});
