import { describe, expect, it } from "vitest";
import { parseCards } from "../../lib/banking/bmoni-cards";

// A card on this page is read by someone who cannot see it, so the states have
// to be distinguishable in words, not just in colour. There are three real
// ones and they mean different things to a worker: no card at all, a card
// asked for and still being issued, and a live card.
//
// The list shape is documented; the issued-card payload is not fully — BMONI
// publishes no field name for a masked PAN or expiry, and none of the wallets
// on the sandbox has an issued card to read. So this parser exposes what is
// documented and does NOT invent a number to print on the front of the card.

describe("the card list", () => {
  it("reports no card when the wallet has none", () => {
    expect(parseCards({ cards: [] })).toEqual([]);
  });

  it("reads a live card", () => {
    const live = {
      cards: [
        {
          id: "card-1",
          cardName: "Aide Wages",
          cardColor: "#1B4332",
          currency: "NGN",
          type: "virtual",
          status: "active",
          fundedAt: "2026-09-04T01:00:00.000Z",
        },
      ],
    };
    expect(parseCards(live)).toEqual([
      {
        id: "card-1",
        name: "Aide Wages",
        color: "#1B4332",
        currency: "NGN",
        type: "virtual",
        status: "active",
        reserved: false,
        spoken: "Your Aide Wages card is active.",
      },
    ]);
  });

  it("keeps a requested-but-unissued card visible as its own state", () => {
    // A reserved entry has no card id — `id` is the issuance proposal id. If
    // this were filtered out, a worker who asked for a card would be told they
    // have none, and would reasonably ask for a second one.
    const reserved = {
      cards: [
        {
          id: "b7c9e9a2-6a54-4f24-9a83-2f6f7c1d9e10",
          proposalId: "b7c9e9a2-6a54-4f24-9a83-2f6f7c1d9e10",
          isReserved: true,
          status: "RESERVED",
          proposalStatus: "PENDING_SIGNATURES",
          cardName: "Aide Wages",
          cardColor: "#1B4332",
          currency: "NGN",
          type: "virtual",
        },
      ],
    };
    const [c] = parseCards(reserved);
    expect(c.reserved).toBe(true);
    expect(c.spoken).toBe("Your Aide Wages card is still being issued.");
  });

  it("does not claim an unknown issuer status is usable", () => {
    // The issuer's status vocabulary is open — BMONI's own docs say to treat it
    // as such and fall through to a neutral state rather than asserting an
    // exhaustive match. Saying "active" for a status we do not recognise would
    // send someone to a shop with a card that declines.
    const [c] = parseCards({
      cards: [{ id: "card-9", cardName: "Aide Wages", currency: "NGN", type: "virtual", status: "restricted" }],
    });
    expect(c.spoken).toBe("Your Aide Wages card is not usable right now.");
  });

  it("reads the status case-insensitively", () => {
    // Documented as the issuer's vocabulary, and observed in both cases.
    const [c] = parseCards({
      cards: [{ id: "card-2", cardName: "Aide Wages", currency: "NGN", type: "virtual", status: "ACTIVE" }],
    });
    expect(c.spoken).toBe("Your Aide Wages card is active.");
  });

  it("never carries a card number", () => {
    // The PAN and CVV come only from POST /cards/sensitive-data, which the docs
    // say to pass straight to the surface that renders it and never cache. A
    // view model that could hold one would eventually be logged.
    const [c] = parseCards({
      cards: [{ id: "card-1", cardName: "Aide Wages", currency: "NGN", type: "virtual", status: "active" }],
    });
    expect(Object.keys(c)).not.toContain("pan");
    expect(JSON.stringify(c)).not.toMatch(/\d{13,19}/);
  });

  it("throws when the response is not a card list", () => {
    expect(() => parseCards({})).toThrow(/cards/);
  });
});
