// A BMONI spend card, reduced to what Aide is willing to show and say.
//
// Deliberately no PAN, no CVV, no expiry. Those come only from
// POST /v1/users/{userId}/cards/sensitive-data, which BMONI documents as
// "never log it, never cache it, pass it straight to the surface that renders
// it" — so a view model that COULD hold one is a view model that eventually
// ends up in a log line. There is also no documented masked-PAN field on the
// list route, and no issued card on the sandbox to read one from, so printing
// digits on the card face would mean inventing them.

export type CardView = {
  id: string;
  name: string;
  color?: string;
  currency: string;
  type: string;
  status: string;
  // A requested card whose issuance proposal has not completed. Its `id` is
  // the proposal id, not a card id.
  reserved: boolean;
  // What Aide says. The page shows the same sentence, so what is seen and what
  // is heard cannot drift apart.
  spoken: string;
};

// The issuer's vocabulary, not BMONI's, and documented as open — an issuer can
// add a state without any change here. Only `active` is claimed as usable;
// everything else falls through to a neutral sentence rather than an
// exhaustive match that would one day assert something false out loud.
function sentence(name: string, status: string, reserved: boolean): string {
  if (reserved) return `Your ${name} card is still being issued.`;
  switch (status.toLowerCase()) {
    case "active":
      return `Your ${name} card is active.`;
    case "pending":
      return `Your ${name} card has been issued but is not activated yet.`;
    case "frozen":
      return `Your ${name} card is frozen.`;
    case "lost":
    case "stolen":
      return `Your ${name} card is blocked because it was reported ${status.toLowerCase()}.`;
    default:
      return `Your ${name} card is not usable right now.`;
  }
}

export function parseCards(body: unknown): CardView[] {
  const list = (body as { cards?: unknown })?.cards;
  if (!Array.isArray(list)) throw new Error("BMONI cards response has no cards array");

  return list.map((raw) => {
    const c = raw as Record<string, unknown>;
    const name = typeof c.cardName === "string" && c.cardName.trim() ? c.cardName : "BMONI";
    const reserved = c.isReserved === true || String(c.status).toUpperCase() === "RESERVED";
    const status = typeof c.status === "string" ? c.status : "unknown";
    return {
      id: String(c.id ?? c.proposalId ?? ""),
      name,
      color: typeof c.cardColor === "string" ? c.cardColor : undefined,
      currency: typeof c.currency === "string" ? c.currency : "NGN",
      type: typeof c.type === "string" ? c.type : "virtual",
      status,
      reserved,
      spoken: sentence(name, status, reserved),
    };
  });
}
