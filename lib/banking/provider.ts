import { toKobo } from "../money";

// The seam between Aide and whoever is actually holding the money.
//
// Additive by design. Monnify remains the default and `lib/monnify.ts` is
// untouched, so selecting BMONI is a config change and selecting it back is
// the same change in reverse. That matters more than usual here: this is a
// hackathon integration against a sandbox, and the ability to put it back
// should not depend on a revert landing cleanly.
//
// The interface is deliberately narrow — four things the store layer actually
// needs — rather than the union of both providers' APIs. A seam wide enough to
// express everything both sides can do is not a seam.
//
// AMOUNTS ACROSS THIS BOUNDARY ARE KOBO. Monnify speaks naira and BMONI speaks
// decimal strings, and each adapter converts at its own edge. Nothing in the
// middle handles a naira float, because the one bug this seam could introduce
// is a unit mix-up that no type would catch: both are `number`.

export type ProviderName = "monnify" | "bmoni";

// A destination account, already name-enquiry verified.
export type VerifiedAccount = { accountNumber: string; accountName: string; bankCode: string };

// What a payout attempt is allowed to report. Mirrors proposal-status: there is
// no "probably worked". An unknown answer must not become a spoken
// confirmation.
export type PayoutOutcome = {
  state: "completed" | "pending" | "failed" | "unknown";
  reference: string;
  mayAnnounceArrival: boolean;
};

export type InboundCredit = { amountKobo: number; reference: string; from?: string; at: number };

export interface PaymentProvider {
  readonly name: ProviderName;

  // Make sure the account can receive money, and return where it lands.
  ensureWallet(accountId: string): Promise<{ accountNumber?: string; bankName?: string }>;

  // Confirmed money IN, in kobo. The credit side of the balance.
  listInbound(accountId: string): Promise<InboundCredit[]>;

  // Name enquiry. Throws if the account does not resolve — never guesses a name.
  verifyDestination(accountNumber: string, bankCode: string): Promise<VerifiedAccount>;

  // Money OUT. Implementations must not retry and must not abort early.
  payOut(args: {
    accountId: string;
    amountKobo: number;
    accountNumber: string;
    bankCode: string;
    bankName: string;
    accountName: string;
  }): Promise<PayoutOutcome>;
}

// Which provider is live. Monnify unless BMONI is explicitly selected, so an
// unset or misspelled value falls back to the one that has been running rather
// than to the new one.
export function selectedProvider(): ProviderName {
  return process.env.AIDE_PAYMENT_PROVIDER?.trim().toLowerCase() === "bmoni" ? "bmoni" : "monnify";
}

// Monnify reports naira as a float; everything above this line is kobo.
export function monnifyNairaToKobo(naira: number): number {
  return toKobo(naira);
}
