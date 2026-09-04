import type { ProviderName } from "./provider";

// Whether a name enquiry can be believed.
//
// BMONI's development host does not perform one. It returns a plausible
// Nigerian name for any ten-digit number against any bank code — deterministic
// per number, so two lookups agree and it reads exactly like a real answer.
// Measured 2026-09-04: account 4534076021 came back "Dillon Bunch" against six
// different banks, and 0123456789 came back "Ekon Orji" against a bank it has
// no relationship with.
//
// Aide reads the account holder's name back so the payer can stop before the
// money moves. Against a fabricator that check is worse than absent: it takes
// a mistyped account number and answers it with a confident name, and the
// person listening has no screen on which to notice the name means nothing.
//
// So the name is marked unverified, and the confirmation falls back to
// something the user can actually check: the digits they typed.

// Distrust unless the host is recognisably production. A new hostname should
// arrive as "we cannot vouch for this", not as "verified".
const BMONI_PRODUCTION = /^https?:\/\/embedded\.bmoni\.com\/?$/i;

export function isFabricatedNameEnquiry(provider: ProviderName, baseUrl: string | undefined): boolean {
  // Monnify's sandbox does real name enquiry — it rejects accounts that do not
  // exist — so this is a fact about BMONI's dev host, not about sandboxes.
  if (provider !== "bmoni") return false;
  if (!baseUrl?.trim()) return true;
  return !BMONI_PRODUCTION.test(baseUrl.trim());
}

// Spoken as separate digits. "3463455722" reaches a screen reader as one
// enormous number — "three billion, four hundred and sixty-three million…" —
// which nobody can check against the number they meant to type. One digit at a
// time is what makes a wrong one audible.
export function spellDigits(accountNumber: string): string {
  return accountNumber.replace(/\D/g, "").split("").join(" ");
}

// The destination, as Aide says it in the breath before money moves.
export function destinationConfirmation(dest: {
  accountName: string;
  accountNumber: string;
  nameVerified: boolean;
}): string {
  if (dest.nameVerified) return `to ${dest.accountName}, account ${dest.accountNumber}`;
  // The unverified name is deliberately not spoken at all. Said aloud in any
  // form — even hedged — it is the thing the listener will remember as
  // confirmation.
  return (
    `to account ${spellDigits(dest.accountNumber)}. ` +
    `I could not confirm the account holder's name on this connection, so please check those digits yourself`
  );
}
