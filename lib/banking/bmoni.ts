import { bmoniMove, bmoniRead, BmoniError } from "./bmoni-client";
import { koboToDecimalString } from "./amounts";
import { parseCards } from "./bmoni-cards";
import { parseVerifiedAccount, parseWalletTransactions } from "./bmoni-shapes";
import { parseBanks, parseCreatedUser, parseCreatedWallet, parseNgnBalanceKobo, parseNgnDepositAccount } from "./bmoni-shapes";

// The BMONI Embedded operations Aide uses, in lifecycle order:
//
//   user → smart wallet → KYC → rail → fund → move money
//
// The wallet comes BEFORE KYC, which is the opposite of most providers and the
// thing most likely to trip someone reading this later: `start-nigeria` needs
// an `ngnWalletAddress`, so the wallet has to exist first.
//
// Everything that can move money goes through bmoniMove — one attempt, no
// timeout, no retry. Everything else is a read.

export type BmoniUser = { bmoniUserId: string };
export type SmartWallet = { smartWalletId: string; address: string; currency: string };
export type OwnerProofChallenge = { challengeId: string; message: string };
export type SignPayload = { hashToSign: string; deadline?: number };
export type Proposal = { proposalId: string; status: string };

// ---- 1. User ----------------------------------------------------------------

export type NewUser = { firstName: string; lastName: string; email: string; phoneNumber: string };

// A 409 means a previous attempt already created this user, guarded on email
// and phone. It IS recoverable: GET /v1/users lists every partner user with
// their bmoniUserId, email and phone, so the id can be found again. (BMONI's
// own docs name a `findUserByEmail` that does not exist; the list route is
// what actually works.)
//
// The id is still persisted at creation rather than relied on being
// re-findable, because the list is shared across every team on the sandbox and
// matching the wrong row would bind a worker's wages to a stranger's wallet.
export async function createBmoniUser(u: NewUser): Promise<BmoniUser> {
  return parseCreatedUser(await bmoniRead({ path: "/v1/users", method: "POST", body: u }));
}

// ---- 2. Smart wallet --------------------------------------------------------

export async function requestOwnerProofChallenge(
  userId: string,
  userOwnerAddress: string,
  currency = "CNGN",
): Promise<OwnerProofChallenge> {
  return await bmoniRead<OwnerProofChallenge>({
    path: `/v1/users/${userId}/smart-wallets/owner-proof-challenges`,
    method: "POST",
    body: { currency, userOwnerAddress },
  });
}

// Wallet creation has NO uniqueness guard: a blind retry produces a SECOND
// wallet. So this is a move, not a read — one attempt only. If it fails without
// a clear answer, the caller must read balances to see whether the first
// attempt landed before ever trying again.
export async function createSmartWallet(args: {
  userId: string;
  userOwnerAddress: string;
  ownerProofChallengeId: string;
  ownerProofSignature: string;
  currency?: string;
}): Promise<SmartWallet> {
  return parseCreatedWallet(
    await bmoniMove({
    path: `/v1/users/${args.userId}/smart-wallets/create-managed`,
    method: "POST",
    body: {
      currency: args.currency ?? "CNGN",
      userOwnerAddress: args.userOwnerAddress,
      ownerProofChallengeId: args.ownerProofChallengeId,
      ownerProofSignature: args.ownerProofSignature,
    },
    }),
  );
}

// The read-before-retry that makes a failed wallet create safe to recover from.
export async function listBalances(userId: string): Promise<unknown> {
  return await bmoniRead({ path: `/v1/users/${userId}/smart-wallets/account/balances` });
}

// The naira figure, in whole kobo. Throws rather than reporting a zero it did
// not read — see lib/banking/bmoni-shapes.ts.
export async function getNgnBalanceKobo(userId: string): Promise<number> {
  return parseNgnBalanceKobo(await listBalances(userId));
}

// ---- 3. KYC / rail ----------------------------------------------------------

export async function startNigeriaOnboarding(args: {
  userId: string;
  bvn: string;
  ngnWalletAddress: string;
}): Promise<unknown> {
  // BMONI rejects a BVN that is not exactly 11 digits, but only after a round
  // trip. Checking here keeps the error next to the field that caused it.
  const bvn = args.bvn.trim();
  if (!/^\d{11}$/.test(bvn)) throw new Error(`BVN must be exactly 11 digits, got ${JSON.stringify(args.bvn)}`);
  return await bmoniRead({
    path: `/v1/users/${args.userId}/onboarding/start-nigeria`,
    method: "POST",
    body: { bvn, ngnWalletAddress: args.ngnWalletAddress },
  });
}

// There is no single `status`. The live response is one field per rail —
// anchorStatus, bridgeStatus, moneriumStatus, paytrieStatus, etherfuseStatus —
// each independently "not_started" or beyond. Nigerian onboarding is the
// anchor rail; the others belong to regions Aide does not use.
export type OnboardingStatus = {
  anchorStatus?: string;
  bridgeStatus?: string;
  moneriumStatus?: string;
  paytrieStatus?: string;
  etherfuseStatus?: string;
};

export async function onboardingStatus(userId: string): Promise<OnboardingStatus> {
  return await bmoniRead({ path: `/v1/users/${userId}/onboarding/status` });
}

// ---- 4. Deposits (money in) -------------------------------------------------

// VERIFIED against the sandbox: this requires a `bankAccountId` UUID in the
// body. Calling it with none answers 400 ["bankAccountId must be a UUID"].
//
// Which id, and where it comes from, is still unknown. Before onboarding
// completes the only account BMONI lists is the pooled house one, whose id is
// the literal string "pooled-vba-1" — not a UUID, so it cannot be the answer.
// The per-user virtual account that would have a UUID does not exist until the
// Nigerian anchor rail is onboarded, which needs one of the two sandbox BVN
// personas. So this is left un-guessed on purpose: sending an arbitrary id
// here would point a worker's incoming wages at somebody else's account.
export async function pointDepositsAtWallet(
  userId: string,
  smartWalletId: string,
  bankAccountId: string,
): Promise<unknown> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bankAccountId)) {
    throw new Error(`onramp/vba/nigeria needs a bankAccountId UUID, got ${JSON.stringify(bankAccountId)}`);
  }
  return await bmoniRead({
    path: `/v1/users/${userId}/smart-wallets/${smartWalletId}/onramp/vba/nigeria`,
    method: "POST",
    body: { bankAccountId },
  });
}

// The account number a worker actually gives out to be paid into.
export async function getNgnDepositAccount(userId: string): Promise<{ accountNumber: string; bankName: string; accountName: string }> {
  return parseNgnDepositAccount(await bmoniRead({ path: `/v1/users/${userId}/bank-accounts/deposit-accounts/NGN` }));
}

// ---- 5. Withdrawal destinations --------------------------------------------

export async function listNigerianBanks(userId: string): Promise<Array<{ name: string; code: string }>> {
  return parseBanks(await bmoniRead({ path: `/v1/users/${userId}/bank-accounts/nigerian-banks` }));
}

// Name enquiry. A 404 means no account matches — surface it and let the user
// correct the number rather than pushing on, exactly as with Monnify.
export async function verifyNigerianAccount(
  userId: string,
  accountNumber: string,
  bankCode: string,
): Promise<{ accountNumber: string; accountName: string; bankName: string; bankCode: string }> {
  return parseVerifiedAccount(
    await bmoniRead({
      path: `/v1/users/${userId}/bank-accounts/verify-nigerian-account`,
      method: "POST",
      body: { accountNumber, bankCode },
    }),
  );
}

// Get-or-create: calling again with the same account returns the existing
// record rather than duplicating it, so this is safe to repeat.
export async function registerWithdrawalAccount(args: {
  userId: string;
  accountNumber: string;
  bankCode: string;
  bankName: string;
  accountHolderName: string;
}): Promise<{ id: string }> {
  return await bmoniRead({
    path: `/v1/users/${args.userId}/bank-accounts/withdrawal-accounts/nigeria`,
    method: "POST",
    body: {
      accountNumber: args.accountNumber,
      bankCode: args.bankCode,
      bankName: args.bankName,
      accountHolderName: args.accountHolderName,
    },
  });
}

// ---- 6. Moving money --------------------------------------------------------

// Withdraw to a Nigerian bank. Returns a PROPOSAL — nothing has moved yet.
export async function createNgnOfframp(args: {
  userId: string;
  smartWalletId: string;
  bankAccountId: string;
  amountKobo: number;
}): Promise<Proposal> {
  return await bmoniMove<Proposal>({
    path: `/v1/users/${args.userId}/smart-wallets/${args.smartWalletId}/offramp/nigeria`,
    method: "POST",
    body: { bankAccountId: args.bankAccountId, fromAmount: koboToDecimalString(args.amountKobo) },
  });
}

// Worker-to-worker / employer-to-worker transfer. Also only a proposal.
export async function createTransferProposal(args: {
  userId: string;
  smartWalletId: string;
  toAddress: string;
  amountKobo: number;
  description?: string;
  currency?: string;
}): Promise<Proposal> {
  return await bmoniMove<Proposal>({
    path: `/v1/users/${args.userId}/smart-wallets/${args.smartWalletId}/proposals`,
    method: "POST",
    body: {
      proposal: {
        type: "TRANSFER",
        toAddress: args.toAddress,
        amount: koboToDecimalString(args.amountKobo),
        currency: args.currency ?? "CNGN",
        ...(args.description ? { description: args.description } : {}),
      },
    },
  });
}

export async function approveProposal(userId: string, proposalId: string): Promise<unknown> {
  return await bmoniMove({
    path: `/v1/users/${userId}/smart-wallets/proposals/${proposalId}/approve`,
    method: "POST",
  });
}

// Fetch immediately before signing. The payload carries a deadline and must not
// be cached across a user session — a stale one fails with "Signature deadline
// exceeded", which for Aide means a withdrawal that was confirmed out loud and
// then quietly did not happen.
export async function getSignPayload(userId: string, proposalId: string): Promise<SignPayload> {
  return await bmoniRead<SignPayload>({
    path: `/v1/users/${userId}/smart-wallets/proposals/${proposalId}/sign-payload`,
  });
}

export async function submitProposalSignature(
  userId: string,
  proposalId: string,
  signature: string,
): Promise<Proposal> {
  return await bmoniMove<Proposal>({
    path: `/v1/users/${userId}/smart-wallets/proposals/${proposalId}/sign`,
    method: "POST",
    body: { signature },
  });
}

export async function getProposal(userId: string, proposalId: string): Promise<Proposal> {
  return await bmoniRead<Proposal>({ path: `/v1/users/${userId}/smart-wallets/proposals/${proposalId}` });
}

export { BmoniError };

// ---- 7. Cards ---------------------------------------------------------------

// Cards are LISTED on the smart-wallet path but CREATED on the user path — the
// asymmetry is real and cost an afternoon: POST to the wallet path is a 404.
// Every partner user, with the bmoniUserId every other endpoint paths on.
// Used to recover from a create-user conflict.
export async function listBmoniUsers(): Promise<
  Array<{ bmoniUserId: string; email?: string; phoneNumber?: string }>
> {
  const body = (await bmoniRead({ path: "/v1/users" })) as { users?: unknown };
  if (!Array.isArray(body?.users)) throw new Error("BMONI /v1/users response has no users array");
  return body.users as Array<{ bmoniUserId: string; email?: string; phoneNumber?: string }>;
}

export async function listCards(userId: string, smartWalletId: string) {
  return parseCards(await bmoniRead({ path: `/v1/users/${userId}/smart-wallets/${smartWalletId}/cards` }));
}

// ---- 8. Wallet history ------------------------------------------------------

// Money in and out of the wallet itself. Paged; the first page is the newest.
export async function listWalletTransactions(userId: string, smartWalletId: string) {
  return parseWalletTransactions(
    await bmoniRead({ path: `/v1/users/${userId}/smart-wallets/${smartWalletId}/transactions` }),
  );
}
