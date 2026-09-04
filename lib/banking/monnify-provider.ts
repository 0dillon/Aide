import { randomUUID } from "node:crypto";
import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { getReservedAccountTransactions, singleTransfer, validateBankAccount } from "../monnify";
import { ensureWallet as ensureMonnifyWallet, getWallet } from "../store/payments";
import { sumKobo, toKobo, toNaira } from "../money";
import type { InboundCredit, PaymentProvider, PayoutOutcome, VerifiedAccount } from "./provider";

// Monnify behind the same seam. This wraps the existing, working code rather
// than replacing it — `lib/monnify.ts` and `lib/store/payments.ts` are
// untouched, so selecting BMONI and selecting it back are both config changes.
//
// Monnify speaks naira floats. Conversion happens here and nowhere above.

// Monnify's own status vocabulary. Anything outside it is unknown, never
// completed — the same rule as the BMONI proposal mapping, for the same reason.
const SUCCEEDED = new Set(["SUCCESS", "COMPLETED"]);
const IN_FLIGHT = new Set(["PENDING", "PENDING_AUTHORIZATION", "PROCESSING"]);
const FAILED = new Set(["FAILED", "REVERSED", "EXPIRED"]);

// The NIP codes the payments page used to hardcode. They live here now so the
// UI can stop knowing them — they are Monnify's vocabulary, not Aide's, and
// BMONI's codes for the same banks are different.
const MONNIFY_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "050", name: "Ecobank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank" },
  { code: "214", name: "FCMB" },
  { code: "058", name: "GTBank" },
  { code: "076", name: "Polaris Bank" },
  { code: "221", name: "Stanbic IBTC" },
  { code: "232", name: "Sterling Bank" },
  { code: "032", name: "Union Bank" },
  { code: "033", name: "UBA" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

export const monnifyProvider: PaymentProvider = {
  name: "monnify",

  async ensureWallet(accountId) {
    const w = await ensureMonnifyWallet(accountId);
    return { accountNumber: w.accountNumber, bankName: w.bankName };
  },

  async listInbound(accountId): Promise<InboundCredit[]> {
    const wallet = await getWallet(accountId);
    const { content } = await getReservedAccountTransactions(wallet.accountReference);
    return content
      .filter((t) => t.paymentStatus === "PAID")
      .map((t) => ({
        // Naira in, kobo out. The one conversion this adapter exists to own.
        amountKobo: toKobo(t.amountPaid ?? t.amount),
        reference: t.transactionReference,
        from: t.customerDTO?.name,
        at: typeof t.createdOn === "number" ? t.createdOn : t.createdOn ? Date.parse(t.createdOn) : Date.now(),
      }));
  },

  // Monnify has no balance for a reserved account, so one is derived: what
  // landed on the NUBAN, minus what Aide has already sent out. The withdrawal
  // ledger is Aide's own — Monnify does not deduct payouts from the reserved
  // account's transaction list — so it has to be subtracted here.
  async getBalanceKobo(accountId) {
    const [inbound, withdrawnKobo] = await Promise.all([
      this.listInbound(accountId),
      convexClient().query(api.wallets.withdrawnTotal, { accountId }) as Promise<number>,
    ]);
    return Math.max(0, sumKobo(inbound.map((c) => c.amountKobo)) - withdrawnKobo);
  },

  // Monnify's list is global, so the account is not consulted. Kept in the
  // signature because BMONI's is not.
  async listBanks() {
    return MONNIFY_BANKS.map((b) => ({ ...b }));
  },

  async verifyDestination(_accountId, accountNumber, bankCode): Promise<VerifiedAccount> {
    const r = await validateBankAccount(accountNumber, bankCode);
    // Monnify's sandbox rejects accounts that do not exist, so its answer is a
    // real one on both environments.
    return { accountNumber: r.accountNumber, accountName: r.accountName, bankCode, nameVerified: true };
  },

  async payOut(args): Promise<PayoutOutcome> {
    // singleTransfer already carries the no-retry, no-early-abort rule.
    const r = await singleTransfer({
      amount: toNaira(args.amountKobo),
      // Same shape the existing withdrawal path uses, so transfers made
      // through the seam are recognisable alongside the ones that are not.
      reference: `aide-wd-${randomUUID().slice(0, 8)}`,
      narration: "Aide withdrawal",
      destinationAccountNumber: args.accountNumber,
      destinationBankCode: args.bankCode,
      destinationAccountName: args.accountName,
    });
    const raw = String((r as { status?: string }).status ?? "");
    const state = SUCCEEDED.has(raw) ? "completed" : IN_FLIGHT.has(raw) ? "pending" : FAILED.has(raw) ? "failed" : "unknown";
    return {
      state,
      reference: (r as { reference?: string }).reference ?? "",
      mayAnnounceArrival: state === "completed",
    };
  },
};
