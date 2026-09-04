import type { ProviderName } from "./provider";

// Whether a name enquiry can be believed.
//
// KNOWN, MEASURED, AND DELIBERATELY NOT GUARDED AGAINST BY DEFAULT.
//
// BMONI's development host does not perform name enquiry. It returns a
// plausible Nigerian name for any ten-digit number against any bank code,
// deterministic per number, so two look-ups agree and it reads exactly like a
// real answer. Measured 2026-09-04 against embedded-dev.bmoni.com:
//
//   4534076021 against six different banks -> "Dillon Bunch" every time
//   0123456789 / GTBANK -> "Ekon Orji"
//   0000000000 / GTBANK -> "Amarachi Nwosu"
//
// The decision is to surface the provider's answer as-is rather than to
// second-guess the sandbox, so Aide behaves on the dev host exactly as it will
// on production. Aide is therefore capable of speaking a fabricated account
// holder's name on this host. On the sandbox that costs nothing — the wallets
// hold no money and the personas are not real people.
//
// It stops being free the moment this runs against a funded wallet on a host
// whose name enquiry has not been confirmed as real. BMONI's docs are explicit
// about sandbox behaviour for BVN/NIN look-ups (only two personas resolve,
// everything else fails) and say nothing at all about this endpoint, so
// "production is real" is an assumption nobody has checked.
//
// Set BMONI_STRICT_NAME_ENQUIRY=true to refuse to present an unverified name.
// The confirmation then reads the account digits back instead, which is the
// part the user actually supplied and can check.
const BMONI_PRODUCTION = /^https?:\/\/embedded\.bmoni\.com\/?$/i;

export function isFabricatedNameEnquiry(provider: ProviderName, baseUrl: string | undefined): boolean {
  // Off unless asked for. Opt-in, so nothing changes for anyone who has not
  // read the note above and decided.
  if (process.env.BMONI_STRICT_NAME_ENQUIRY?.trim().toLowerCase() !== "true") return false;
  // Monnify's sandbox does real name enquiry — it rejects accounts that do not
  // exist — so even under strict mode this is a fact about BMONI's dev host.
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
  // The digits are spelled out even alongside a verified name. That is an
  // accessibility fix rather than a trust one: a screen reader turns
  // "3463455722" into "three billion, four hundred and sixty-three million…",
  // which cannot be checked against the number someone meant to type.
  if (dest.nameVerified) return `to ${dest.accountName}, account ${spellDigits(dest.accountNumber)}`;
  // The unverified name is deliberately not spoken at all. Said aloud in any
  // form — even hedged — it is the thing the listener will remember as
  // confirmation.
  return (
    `to account ${spellDigits(dest.accountNumber)}. ` +
    `I could not confirm the account holder's name on this connection, so please check those digits yourself`
  );
}
