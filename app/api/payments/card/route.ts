import { api } from "@/convex/_generated/api";
import { convexClient } from "@/lib/convex-server";
import { listCards } from "@/lib/banking/bmoni";
import { getAccount } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;

// The worker's BMONI card, for the card panel on the payments page.
//
// Four states, and they are kept distinct on purpose. "BMONI is not switched
// on", "you have no card", "your card is being issued" and "here is your card"
// are four different facts, and collapsing any of them into "no card" would
// have Aide tell a worker who just requested a card that nothing happened —
// so they would request a second one, and be charged the fee twice.
//
// This route never returns a card number. See lib/banking/bmoni-cards.ts.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req)).catch(() => null);
  if (!acc) return Response.json({ state: "unavailable" as const });

  // No key configured means BMONI is simply not switched on here. That is not
  // an error worth reading aloud, and not the same as having no card.
  if (!process.env.BMONI_API_KEY?.trim()) {
    return Response.json({ state: "not-configured" as const });
  }

  const w = (await convexClient()
    .query(api.wallets.getByAccount, { accountId: acc.id })
    .catch(() => null)) as { bmoniUserId?: string; bmoniSmartWalletId?: string } | null;

  if (!w?.bmoniUserId || !w.bmoniSmartWalletId) {
    return Response.json({ state: "no-wallet" as const });
  }

  try {
    const cards = await listCards(w.bmoniUserId, w.bmoniSmartWalletId);
    return Response.json({ state: "ok" as const, cards });
  } catch (e) {
    // Unknown, not empty. Rendering an empty card list on a failed read would
    // tell a worker who has a card that they do not.
    return Response.json({
      state: "unavailable" as const,
      message: `I could not check your card just now. ${(e as Error).message}`,
    });
  }
}
