// The two demo accounts already exist at BMONI, and only once.
//
// Every deployment — a teammate's laptop, a Vercel preview, a fresh Convex
// backend — seeds the same two demo accounts with the same email and phone. The
// first one to run provisioning created the BMONI user; every one after it gets
// `409 User already exists with this email` and stops, because recovering the id
// from GET /v1/users is unreliable on the shared hackathon sandbox (the list is
// partner-scoped and came back with zero matches).
//
// So the ids are recorded here rather than rediscovered. They are not secrets —
// they are public identifiers of two sandbox personas, the same way the demo
// account keys are. What is NOT here is the wallet's owner private key, which
// is sealed per-deployment with BMONI_KEY_SECRET and cannot be shared. That is
// the deliberate consequence: a deployment adopting these ids can READ the
// balance, the account number and the bank list, and cannot SIGN a payout. It
// fails loudly at the moment of withdrawal instead of quietly signing with a
// key BMONI never registered.
export type KnownBmoniWallet = {
  bmoniUserId: string;
  smartWalletId: string;
  walletAddress: string;
};

export const KNOWN_BMONI_WALLETS: Readonly<Record<string, KnownBmoniWallet>> = {
  // Bunch Dillon — BVN 95888168924, VBA 4345182418 at PROVIDUS BANK.
  "demo-worker": {
    bmoniUserId: "9ac290f1-cc04-490e-95ef-ec02056f4e7d",
    smartWalletId: "ce91a25e-694b-4bc7-8810-349c4b912f18",
    walletAddress: "0xbb7EF869d8A6451a721cCdB6816405d27Bd529F4",
  },
  // Jabo Samson Joe (ClearVoice Media) — VBA 3095260191 at PROVIDUS BANK.
  "demo-employer": {
    bmoniUserId: "9bd528ff-819d-4a9e-9bae-b5be19d96268",
    smartWalletId: "46ece567-c4dd-4f10-acc6-b344e60c753b",
    walletAddress: "0x36930Bc1E8A45FBd4928bECb5D17eAB9ABcA62B8",
  },
};

export function knownBmoniWallet(accountId: string): KnownBmoniWallet | undefined {
  return KNOWN_BMONI_WALLETS[accountId];
}
