// Money inside Aide is integer kobo. Naira is an edge format only: what the
// payment provider speaks, what the screen shows, and what Aide says out loud.
//
// The reason is not tidiness. Naira as float64 loses a kobo on amounts a user
// can actually type — ₦1.15 * 100 is 114.99999999999999 — and ten ₦0.10 credits
// summed as naira come to ₦0.99. A worker who cannot see the screen has no way
// to notice the missing kobo, and no way to dispute it. Integers cannot drift.
//
// Every function here throws rather than returning a wrong number. A thrown
// error surfaces as "I could not check that just now", which is true. A silently
// wrong amount would be Aide stating a financial fact that is not so.

const KOBO_PER_NAIRA = 100;

// Naira in (a provider response, a typed amount, a seeded job pay) -> kobo.
export function toKobo(naira: number): number {
  if (!Number.isFinite(naira)) {
    throw new Error(`Not a usable naira amount: ${naira}`);
  }
  const kobo = Math.round(naira * KOBO_PER_NAIRA);
  if (!Number.isSafeInteger(kobo)) {
    throw new Error(`Naira amount is too large to hold exactly in kobo: ${naira}`);
  }
  return kobo;
}

// Kobo -> naira, for the provider, the screen, and anything Aide speaks.
// Rejects a non-integer, because the only way one gets here is a naira figure
// that was never converted — the exact unit mix-up this module exists to stop.
export function toNaira(kobo: number): number {
  assertKobo(kobo);
  return kobo / KOBO_PER_NAIRA;
}

// Totalling a ledger. Exact by construction, unlike the naira reduce it replaces.
export function sumKobo(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertKobo(v);
    total += v;
  }
  if (!Number.isSafeInteger(total)) {
    throw new Error("Ledger total is too large to hold exactly in kobo");
  }
  return total;
}

// Screen display. Always two decimal places: a balance shown as "₦1,200" when
// it is ₦1,200.45 is a small lie, and this app does not tell small lies.
export function formatNaira(kobo: number): string {
  return (
    "₦" +
    toNaira(kobo).toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

// The guard every boundary uses. Exported so callers can validate an amount
// before it reaches a ledger write or a transfer.
export function assertKobo(kobo: number): void {
  if (!Number.isInteger(kobo)) {
    throw new Error(`Amount is not whole kobo — a naira figure was not converted: ${kobo}`);
  }
  if (!Number.isSafeInteger(kobo)) {
    throw new Error(`Kobo amount is outside the exactly-representable range: ${kobo}`);
  }
}
