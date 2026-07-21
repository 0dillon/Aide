import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { AideEvent } from "./store/state";

// Server-side Convex writer: the webhook and the local poller run in Next's
// Node runtime, not the Convex runtime, so they reach Convex over HTTP. Writing
// an event here is what makes it appear in every subscribed browser instantly.

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const client = url ? new ConvexHttpClient(url) : null;

// The shared datastore is required for accounts/wallets/etc. — unlike the
// fire-and-forget event publish, these callers need a hard failure if Convex
// isn't configured rather than silently losing data.
export function convexClient(): ConvexHttpClient {
  if (!client) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is not set. Convex holds all of Aide's data. " +
        "Run `npx convex dev` in a second terminal — it creates a deployment and writes the URL to .env.local. See README.",
    );
  }
  return client;
}

export async function publishConvexEvent(accountId: string, e: AideEvent, at?: number): Promise<void> {
  if (!client) {
    console.warn("NEXT_PUBLIC_CONVEX_URL is not set — payment event not published.");
    return;
  }
  try {
    await client.mutation(api.events.publish, {
      accountId,
      type: e.type,
      amount: e.type === "payment" ? e.amount : undefined,
      from: e.type === "payment" ? e.from : undefined,
      reference: e.type === "payment" ? e.reference : undefined,
      message: e.type === "notify" ? e.message : undefined,
      // Real transaction time, so the client's mount-time cutoff excludes
      // pre-existing history (this replaces the old per-wallet seeding).
      at,
    });
  } catch (err) {
    console.warn("Convex event publish failed:", (err as Error).message);
  }
}
