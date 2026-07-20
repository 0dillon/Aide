import { getReservedAccountTransactions } from "../monnify";
import { state, type AideEvent, type Subscriber } from "./state";
import { cacheWalletBalance, getWallet, listActiveWallets } from "./payments";

// Live events: confirmed payments pushed to the browser so Aide can announce
// money the moment it lands, unprompted — scoped to the wallet that was paid,
// so one user's alert never plays in another user's ears. The Monnify webhook
// route publishes instantly when Monnify can reach the server; the poller
// below is the fallback that makes local demos work without a public tunnel.

const subscribers = state.subscribersByAccount!;

// Deliver an event to one account's listeners; payment events are deduped
// per wallet by transaction reference.
export function publishEvent(accountId: string, e: AideEvent): void {
  if (e.type === "payment") {
    const w = getWallet(accountId);
    if (w.knownTxRefs.has(e.reference)) return; // already announced
    w.knownTxRefs.add(e.reference);
  }
  for (const fn of subscribers.get(accountId) ?? []) {
    try {
      fn(e);
    } catch {}
  }
}

export function subscribeEvents(accountId: string, fn: Subscriber): () => void {
  let set = subscribers.get(accountId);
  if (!set) {
    set = new Set();
    subscribers.set(accountId, set);
  }
  set.add(fn);
  ensurePolling();
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subscribers.delete(accountId);
  };
}

let pollBusy = false;
function ensurePolling(): void {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (subscribers.size === 0 || pollBusy) return;
    pollBusy = true;
    try {
      // Only wallets someone is actually listening to, and only active ones.
      const watched = listActiveWallets().filter((w) => subscribers.has(w.accountId));
      for (const wallet of watched) {
        try {
          const { content } = await getReservedAccountTransactions(wallet.accountReference);
          const paid = content.filter((t) => t.paymentStatus === "PAID");
          cacheWalletBalance(wallet.accountId, paid.reduce((s, t) => s + t.amount, 0));
          if (!wallet.txSeeded) {
            // First look at this wallet: remember history without announcing it as news.
            for (const t of content) wallet.knownTxRefs.add(t.transactionReference);
            wallet.txSeeded = true;
            continue;
          }
          for (const t of paid) {
            if (!wallet.knownTxRefs.has(t.transactionReference)) {
              publishEvent(wallet.accountId, {
                type: "payment",
                amount: t.amountPaid ?? t.amount,
                from: t.customerDTO?.name ?? "a bank transfer",
                reference: t.transactionReference,
              });
            }
          }
        } catch {
          /* transient — next tick retries this wallet */
        }
      }
    } finally {
      pollBusy = false;
    }
  }, 15000);
}
