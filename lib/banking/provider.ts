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
  //
  // `accountName` is the name the BANK holds, which is not the Aide profile
  // name. Whoever pays in sees it during their own name enquiry, so it is the
  // only name Aide may present as the account holder.
  ensureWallet(accountId: string): Promise<{ accountNumber?: string; bankName?: string; accountName?: string }>;

  // Confirmed money IN, in kobo. The credit side of the balance.
  //
  // An empty list means no money has arrived, and callers may say so. A
  // provider that cannot answer must throw rather than return [] — "nobody has
  // paid you" is a claim about the worker's employer, and it must never be
  // made on the strength of a failed read.
  listInbound(accountId: string): Promise<InboundCredit[]>;

  // The spendable balance, in kobo.
  //
  // Separate from listInbound because the two providers know it in genuinely
  // different ways. Monnify has no balance for a reserved account, so its
  // adapter derives one: confirmed credits minus Aide's own withdrawal ledger.
  // BMONI holds the wallet, so it simply reports the figure and Aide must not
  // second-guess it by subtracting a ledger the provider has already applied.
  //
  // Throwing is correct when the figure is unknown. There is no sentinel: a
  // zero returned for "could not check" is the one wrong answer that sounds
  // exactly like a true one when read aloud.
  getBalanceKobo(accountId: string): Promise<number>;

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

// Which provider is live. BMONI now, and by default — it holds the wallets,
// the naira balance and the account numbers workers give out.
//
// Monnify is still reachable by setting AIDE_PAYMENT_PROVIDER=monnify. It stays
// only as a way back if the sandbox goes down mid-demo; nothing routes to it
// unless it is asked for by name.
export function selectedProvider(): ProviderName {
  return process.env.AIDE_PAYMENT_PROVIDER?.trim().toLowerCase() === "monnify" ? "monnify" : "bmoni";
}

// Monnify reports naira as a float; everything above this line is kobo.
export function monnifyNairaToKobo(naira: number): number {
  return toKobo(naira);
}
