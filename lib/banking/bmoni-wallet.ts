import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { generateOwnerKey, openPrivateKey, sealPrivateKey } from "./keys";
import { signOwnerProof, signProposalDigest } from "./signing";
import { readProposalOutcome, type ProposalOutcome } from "./proposal-status";
import {
  approveProposal,
  createBmoniUser,
  createNgnOfframp,
  createSmartWallet,
  getProposal,
  getSignPayload,
  listBalances,
  pointDepositsAtWallet,
  registerWithdrawalAccount,
  requestOwnerProofChallenge,
  startNigeriaOnboarding,
  submitProposalSignature,
  verifyNigerianAccount,
  BmoniError,
} from "./bmoni";

// Provisioning and payout, orchestrated so that any step can fail and the flow
// can be picked up again without repeating something that already happened.
//
// That resumability is the whole design. BMONI has no idempotency keys: a
// repeated create makes a second wallet, and a repeated payout pays a worker's
// wages twice. So every step records its result before the next one starts,
// and every entry point reads that record first.

type WalletRow = {
  accountId: string;
  bmoniUserId?: string;
  bmoniSmartWalletId?: string;
  bmoniWalletAddress?: string;
  bmoniOwnerAddress?: string;
  bmoniSealedOwnerKey?: string;
  bmoniBankAccountIds?: Array<{ key: string; id: string }>;
  bmoniPendingProposal?: { proposalId: string; amountKobo: number; createdAt: number };
};

async function row(accountId: string): Promise<WalletRow | null> {
  return (await convexClient().query(api.wallets.getByAccount, { accountId })) as WalletRow | null;
}

// BMONI wants a first and last name; Aide only ever collected one free-text
// `name`. Splitting it is a guess, and a guess about someone's legal name is
// one that fails KYC in a way nobody can debug later. So the account must carry
// the split explicitly, and this refuses when it does not.
function requireIdentity(acc: { firstName?: string; lastName?: string; phoneNumber?: string; email?: string }): {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
} {
  const missing = (["firstName", "lastName", "phoneNumber", "email"] as const).filter((k) => !acc[k]?.trim());
  if (missing.length) {
    throw new Error(
      `Cannot provision a BMONI wallet without ${missing.join(", ")}. ` +
        `BMONI needs a first/last name split and an E.164 phone; Aide stores one free-text name, ` +
        `and splitting it would be a guess about someone's legal identity.`,
    );
  }
  return {
    firstName: acc.firstName!.trim(),
    lastName: acc.lastName!.trim(),
    phoneNumber: acc.phoneNumber!.trim(),
    email: acc.email!.trim(),
  };
}

// ---- Provisioning -----------------------------------------------------------

export type ProvisionResult = { bmoniUserId: string; smartWalletId: string; walletAddress: string };

export async function provisionBmoniWallet(
  accountId: string,
  accountReference: string,
  account: { firstName?: string; lastName?: string; phoneNumber?: string; email?: string },
): Promise<ProvisionResult> {
  const existing = await row(accountId);

  // Already fully provisioned — nothing to do, and certainly nothing to retry.
  if (existing?.bmoniUserId && existing.bmoniSmartWalletId && existing.bmoniWalletAddress) {
    return {
      bmoniUserId: existing.bmoniUserId,
      smartWalletId: existing.bmoniSmartWalletId,
      walletAddress: existing.bmoniWalletAddress,
    };
  }

  const identity = requireIdentity(account);

  // Step 1 — the user. Persisted BEFORE anything depends on it, because a 409
  // on a repeat names the field that collided but gives no way to ask WHICH
  // user it was. Losing this id means the phone number is spent and the user
  // is unreachable.
  let bmoniUserId = existing?.bmoniUserId;
  if (!bmoniUserId) {
    try {
      bmoniUserId = (await createBmoniUser(identity)).bmoniUserId;
    } catch (e) {
      if (e instanceof BmoniError && e.isConflict) {
        throw new Error(
          `BMONI already holds a user for this email or phone (${e.message}), but we have no stored ` +
            `bmoniUserId for ${accountId} and BMONI publishes no lookup endpoint. This needs manual ` +
            `recovery — do not retry, it will keep colliding.`,
        );
      }
      throw e;
    }
    await convexClient().mutation(api.wallets.setBmoniUser, { accountId, accountReference, bmoniUserId });
  }

  // Step 2 — the owner key. Generated and sealed before the wallet exists, so
  // the address we register is one we can still sign with afterwards. Reused if
  // already present: rotating it would strand the wallet, because BMONI's
  // signer snapshot keeps the address registered at creation.
  let ownerAddress = existing?.bmoniOwnerAddress;
  let sealed = existing?.bmoniSealedOwnerKey;
  if (!ownerAddress || !sealed) {
    const key = generateOwnerKey();
    ownerAddress = key.address;
    sealed = sealPrivateKey(key.privateKey);
    await convexClient().mutation(api.wallets.setBmoniOwnerKey, {
      accountId,
      ownerAddress,
      sealedOwnerKey: sealed,
    });
  }

  // Step 3 — wallet creation has NO uniqueness guard, so a blind retry makes a
  // second wallet. If one may already exist, read balances first and refuse
  // rather than guessing.
  if (existing?.bmoniUserId && !existing.bmoniSmartWalletId) {
    const balances = await listBalances(bmoniUserId);
    if (hasWallet(balances)) {
      throw new Error(
        `BMONI already reports a wallet for ${accountId} but none is recorded locally. Creating another ` +
          `would leave two wallets and deposits routed to the wrong one. Recover the smartWalletId manually.`,
      );
    }
  }

  const challenge = await requestOwnerProofChallenge(bmoniUserId, ownerAddress);
  // Owner proof signs the challenge TEXT, with the EIP-191 prefix — the
  // opposite of the proposal signature below.
  const ownerProofSignature = await signOwnerProof(openPrivateKey(sealed), challenge.message);

  const wallet = await createSmartWallet({
    userId: bmoniUserId,
    userOwnerAddress: ownerAddress,
    ownerProofChallengeId: challenge.challengeId,
    ownerProofSignature,
  });

  await convexClient().mutation(api.wallets.setBmoniWallet, {
    accountId,
    smartWalletId: wallet.smartWalletId,
    walletAddress: wallet.address,
  });

  return { bmoniUserId, smartWalletId: wallet.smartWalletId, walletAddress: wallet.address };
}

// Deliberately conservative: anything that looks like a wallet counts. This
// gates "may I create another", so a false positive costs a manual check and a
// false negative costs a duplicate wallet.
function hasWallet(balances: unknown): boolean {
  if (!balances) return false;
  const list = Array.isArray(balances) ? balances : (balances as any)?.wallets ?? (balances as any)?.balances;
  return Array.isArray(list) && list.length > 0;
}

// Activate the NGN rail and point incoming bank transfers at the wallet.
export async function activateNigeriaRail(args: {
  bmoniUserId: string;
  smartWalletId: string;
  walletAddress: string;
  bvn: string;
}): Promise<void> {
  await startNigeriaOnboarding({
    userId: args.bmoniUserId,
    bvn: args.bvn,
    ngnWalletAddress: args.walletAddress,
  });
  await pointDepositsAtWallet(args.bmoniUserId, args.smartWalletId);
}

// ---- Paying out -------------------------------------------------------------

export type PayoutResult = { proposalId: string; outcome: ProposalOutcome };

// Withdraw to a Nigerian bank account.
//
// The dangerous window is between creating the proposal and signing it: a real
// payout exists at BMONI, and starting over would create a second one. So the
// proposal id is claimed in Convex the instant it exists, and a claim that
// finds another proposal already in flight refuses instead of overwriting.
export async function payOutToBank(args: {
  accountId: string;
  amountKobo: number;
  accountNumber: string;
  bankCode: string;
  bankName: string;
}): Promise<PayoutResult> {
  const w = await row(args.accountId);
  if (!w?.bmoniUserId || !w.bmoniSmartWalletId || !w.bmoniSealedOwnerKey) {
    throw new Error(`No provisioned BMONI wallet for ${args.accountId}`);
  }

  // Resume rather than restart: an in-flight proposal is a payout that already
  // exists. Creating another would pay the same wages twice.
  if (w.bmoniPendingProposal) {
    return await seeProposalThrough(
      args.accountId,
      w.bmoniUserId,
      w.bmoniSealedOwnerKey,
      w.bmoniPendingProposal.proposalId,
    );
  }

  // Name enquiry first — it yields the exact holder name registration needs.
  const destKey = `${args.accountNumber}:${args.bankCode}`;
  let bankAccountId = w.bmoniBankAccountIds?.find((r) => r.key === destKey)?.id;
  if (!bankAccountId) {
    const verified = await verifyNigerianAccount(w.bmoniUserId, args.accountNumber, args.bankCode);
    // Get-or-create at BMONI, so this is safe to repeat.
    const registered = await registerWithdrawalAccount({
      userId: w.bmoniUserId,
      accountNumber: args.accountNumber,
      bankCode: args.bankCode,
      bankName: args.bankName,
      accountHolderName: verified.accountHolderName,
    });
    bankAccountId = registered.id;
    await convexClient().mutation(api.wallets.rememberBmoniBankAccount, {
      accountId: args.accountId,
      key: destKey,
      bankAccountId,
    });
  }

  // From here a real payout can exist at BMONI.
  const proposal = await createNgnOfframp({
    userId: w.bmoniUserId,
    smartWalletId: w.bmoniSmartWalletId,
    bankAccountId,
    amountKobo: args.amountKobo,
  });

  const claim = (await convexClient().mutation(api.wallets.claimBmoniProposal, {
    accountId: args.accountId,
    proposalId: proposal.proposalId,
    amountKobo: args.amountKobo,
    at: Date.now(),
  })) as { ok: boolean; inFlight?: string };
  if (!claim.ok) {
    throw new Error(
      `Created BMONI proposal ${proposal.proposalId} but ${claim.inFlight} was already in flight for ` +
        `${args.accountId}. Two payouts now exist — resolve both before withdrawing again.`,
    );
  }

  return await seeProposalThrough(args.accountId, w.bmoniUserId, w.bmoniSealedOwnerKey, proposal.proposalId);
}

// Approve, sign and read back a proposal that already exists. Safe to re-enter:
// approving twice is harmless, and the sign payload is always fetched fresh
// because it carries a deadline.
async function seeProposalThrough(
  accountId: string,
  bmoniUserId: string,
  sealedOwnerKey: string,
  proposalId: string,
): Promise<PayoutResult> {
  const current = await getProposal(bmoniUserId, proposalId);

  if (current.status === "PENDING_APPROVALS") {
    await approveProposal(bmoniUserId, proposalId);
  }

  const after = await getProposal(bmoniUserId, proposalId);
  if (after.status === "PENDING_SIGNATURES") {
    // Fetched immediately before signing — the payload carries a deadline, and
    // a stale one is rejected after the withdrawal was confirmed out loud.
    const payload = await getSignPayload(bmoniUserId, proposalId);
    // Raw 32-byte digest, NO EIP-191 prefix. The opposite of the owner proof.
    const signature = signProposalDigest(openPrivateKey(sealedOwnerKey), payload.hashToSign);
    await submitProposalSignature(bmoniUserId, proposalId, signature);
  }

  const final = await getProposal(bmoniUserId, proposalId);
  const outcome = readProposalOutcome(final.status);

  // Terminal states release the guard. An unknown status deliberately does
  // NOT: leaving it in flight blocks another payout until a human establishes
  // what happened to this one.
  if (outcome.state === "completed" || outcome.state === "failed") {
    await convexClient().mutation(api.wallets.clearBmoniProposal, { accountId, proposalId });
  }

  return { proposalId, outcome };
}
