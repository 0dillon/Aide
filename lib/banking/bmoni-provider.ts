import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { getAccount } from "../store/accounts";
import { decimalStringToKobo } from "./amounts";
import {
  getNgnBalanceKobo,
  onboardingStatus,
  type OnboardingStatus,
  pointDepositsAtWallet,
  startNigeriaOnboarding,
  getNgnDepositAccount,
  listNigerianBanks,
  listWalletTransactions,
  verifyNigerianAccount,
} from "./bmoni";
import { payOutToBank, provisionBmoniWallet } from "./bmoni-wallet";
import { isFabricatedNameEnquiry } from "./name-enquiry";
import type { InboundCredit, PaymentProvider, PayoutOutcome, VerifiedAccount } from "./provider";

// BMONI behind the seam. Every amount crossing back out of here is kobo.

// The BMONI user for this account, provisioning one if it does not exist yet.
//
// It used to throw. That was wrong in a way that only showed up on a
// deployment which had been running on Monnify: the wallet row was already
// `status: "active"` with a Monnify NUBAN, so nothing ever asked BMONI for a
// wallet, and then every BMONI read failed with "No BMONI user provisioned for
// demo-worker" — balance, bank list and card all at once. It looked like a
// BMONI outage. It was an account that had never been asked to migrate.
//
// Provisioning here is safe to reach from a read path because
// provisionBmoniWallet is resumable by construction: it persists each step
// before the next one starts and returns early once complete, so repeated
// calls do not create second users or second wallets.
async function bmoniUserOf(accountId: string): Promise<string> {
  const w = (await convexClient().query(api.wallets.getByAccount, { accountId })) as { bmoniUserId?: string } | null;
  if (w?.bmoniUserId) return w.bmoniUserId;

  const acc = (await getAccount(accountId)) as {
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    email?: string;
  };
  return (await provisionBmoniWallet(accountId, `aide-${accountId}`, acc)).bmoniUserId;
}

async function anchorStatusOf(bmoniUserId: string): Promise<string | undefined> {
  return (await onboardingStatus(bmoniUserId).catch(() => ({}) as OnboardingStatus)).anchorStatus;
}

// The virtual account appears a few seconds after onboarding, so a first visit
// would otherwise fail on an account that is already being issued.
async function withRetry<T>(read: () => Promise<T>, attempts = 6, gapMs = 2500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await read();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  throw last;
}

export const bmoniProvider: PaymentProvider = {
  name: "bmoni",

  async ensureWallet(accountId) {
    const acc = (await getAccount(accountId)) as {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      email?: string;
      bvn?: string;
    };
    const { bmoniUserId, smartWalletId, walletAddress } = await provisionBmoniWallet(
      accountId,
      `aide-${accountId}`,
      acc,
    );

    // The wallet exists but nothing can be paid INTO it until the Nigerian
    // anchor rail is onboarded — that is the call which issues the virtual
    // account. Skipping it left the user with a smart wallet and no NUBAN, so
    // the deposit list held only BMONI's pooled house account and the parser
    // (correctly) refused to hand that out as theirs.
    //
    // Idempotent in practice: start-nigeria on an already-active rail returns
    // the same workflow rather than issuing a second account.
    if (acc.bvn?.trim() && (await anchorStatusOf(bmoniUserId)) !== "active") {
      await startNigeriaOnboarding({
        userId: bmoniUserId,
        bvn: acc.bvn.trim(),
        ngnWalletAddress: walletAddress,
        smartWalletId,
      });
    }

    // The NUBAN a worker actually gives out. Read separately: the wallet is an
    // address, the deposit account is the bank-facing side of it.
    //
    // Issued asynchronously — for a few seconds after onboarding the list
    // holds only the pooled account, and parseNgnDepositAccount throws rather
    // than returning it. Retried briefly so a first visit does not have to
    // fail before the account that is already on its way shows up.
    const deposit = await withRetry(() => getNgnDepositAccount(bmoniUserId));

    // Route deposits at this wallet. Without it the virtual account exists but
    // credits land nowhere Aide can see.
    await pointDepositsAtWallet(bmoniUserId, smartWalletId, deposit.id).catch((e) => {
      // Already linked is not a failure; anything else is worth knowing about
      // without taking the account number down with it.
      console.warn(`[bmoni] could not link deposits for ${accountId}: ${(e as Error).message}`);
    });

    return { accountNumber: deposit.accountNumber, bankName: deposit.bankName, accountName: deposit.accountName };
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

  async listBanks(accountId) {
    return await listNigerianBanks(await bmoniUserOf(accountId));
  },

  // Verified as the account doing the asking, rather than as some configured
  // stand-in user. BMONI scopes name enquiry per user, and borrowing another
  // user's context to ask about a stranger's account is both wrong and
  // unnecessary now that every account has its own BMONI user.
  async verifyDestination(accountId, accountNumber, bankCode): Promise<VerifiedAccount> {
    const r = await verifyNigerianAccount(await bmoniUserOf(accountId), accountNumber, bankCode);
    return {
      accountNumber,
      bankCode,
      accountName: r.accountName,
      // False on the development host, which fabricates. The name still
      // travels — it is needed to register the destination with BMONI — but
      // callers must not show or say it as a confirmation.
      nameVerified: !isFabricatedNameEnquiry("bmoni", process.env.BMONI_BASE_URL),
    };
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
