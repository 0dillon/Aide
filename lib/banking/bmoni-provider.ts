import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { getAccount } from "../store/accounts";
import { decimalStringToKobo } from "./amounts";
import { getNgnBalanceKobo, getNgnDepositAccount, listWalletTransactions, verifyNigerianAccount } from "./bmoni";
import { payOutToBank, provisionBmoniWallet } from "./bmoni-wallet";
import type { InboundCredit, PaymentProvider, PayoutOutcome, VerifiedAccount } from "./provider";

// BMONI behind the seam. Every amount crossing back out of here is kobo.

async function bmoniUserOf(accountId: string): Promise<string> {
  const w = (await convexClient().query(api.wallets.getByAccount, { accountId })) as { bmoniUserId?: string } | null;
  if (!w?.bmoniUserId) throw new Error(`No BMONI user provisioned for ${accountId}`);
  return w.bmoniUserId;
}

export const bmoniProvider: PaymentProvider = {
  name: "bmoni",

  async ensureWallet(accountId) {
    const acc = (await getAccount(accountId)) as {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      email?: string;
    };
    const { bmoniUserId } = await provisionBmoniWallet(accountId, `aide-${accountId}`, acc);
    // The NUBAN a worker actually gives out. Read separately: the wallet is an
    // address, the deposit account is the bank-facing side of it.
    const deposit = await getNgnDepositAccount(bmoniUserId);
    return { accountNumber: deposit.accountNumber, bankName: deposit.bankName };
  },

  // BMONI holds the wallet, so the balance is simply what it reports. Nothing
  // is subtracted here: withdrawals have already left the wallet on BMONI's
  // side, and taking Aide's withdrawal ledger off again would double-count
  // every payout and understate what the worker actually has.
  async getBalanceKobo(accountId) {
    return await getNgnBalanceKobo(await bmoniUserOf(accountId));
  },

  async listInbound(accountId): Promise<InboundCredit[]> {
    const w = (await convexClient().query(api.wallets.getByAccount, { accountId })) as {
      bmoniUserId?: string;
      bmoniSmartWalletId?: string;
    } | null;
    if (!w?.bmoniUserId || !w.bmoniSmartWalletId) {
      // Throwing, not returning []. No wallet means the history is unknown,
      // and an empty list here would be read out as "no payments received".
      throw new Error(`No BMONI wallet provisioned for ${accountId}`);
    }
    return await listWalletTransactions(w.bmoniUserId, w.bmoniSmartWalletId);
  },

  async verifyDestination(accountNumber, bankCode): Promise<VerifiedAccount> {
    // Name enquiry needs a user context in BMONI, unlike Monnify's global one.
    const anyUser = process.env.BMONI_VERIFY_AS_USER_ID?.trim();
    if (!anyUser) {
      throw new Error(
        "BMONI name enquiry is per-user; set BMONI_VERIFY_AS_USER_ID or verify through the paying account.",
      );
    }
    const r = await verifyNigerianAccount(anyUser, accountNumber, bankCode);
    return { accountNumber, bankCode, accountName: r.accountHolderName };
  },

  async payOut(args): Promise<PayoutOutcome> {
    const { proposalId, outcome } = await payOutToBank({
      accountId: args.accountId,
      amountKobo: args.amountKobo,
      accountNumber: args.accountNumber,
      bankCode: args.bankCode,
      bankName: args.bankName,
    });
    return { state: outcome.state, reference: proposalId, mayAnnounceArrival: outcome.mayAnnounceArrival };
  },
};

// Exported for the balance path: BMONI reports balances as decimal strings.
export function balanceToKobo(amount: string): number {
  return decimalStringToKobo(amount);
}
