import { getReservedAccountTransactions } from "../monnify";
import { state, type AideEvent } from "./state";
import { cacheWalletBalance, listActiveWallets } from "./payments";
import { publishConvexEvent } from "../convex-server";

// Live events: confirmed payments announced the moment they land, unprompted.
// The reactive fan-out lives in Convex (see convex/events.ts) — writing an
// event row there reaches every subscribed browser, across serverless
// instances. This module is the Node-side WRITER: the webhook and the local
// poller both call publishEvent, which forwards to Convex.

// Push a confirmed event to the account's reactive Convex feed. `at` carries the
// real transaction time so the browser's mount-time cutoff excludes history;
// payments are deduped in Convex by (accountId, reference), so webhook + poller
// redelivery announces the money only once.
export function publishEvent(accountId: string, e: AideEvent, at?: number): void {
  void publishConvexEvent(accountId, e, at);
}

let pollBusy = false;

// The poller is the fallback that makes LOCAL demos work without a public
// tunnel Monnify can reach (in production the webhook is the real path, and a
// serverless setInterval wouldn't survive anyway). It polls every active wallet
// and publishes confirmed payments into Convex, tagged with their real time so
// only genuinely new money is announced.
export function ensurePolling(): void {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (pollBusy) return;
    let watched;
    try {
      watched = await listActiveWallets();
    } catch {
      return; // Convex unreachable this tick — try again next time
    }
    if (watched.length === 0) return;
    pollBusy = true;
    try {
      for (const wallet of watched) {
        try {
          const { content } = await getReservedAccountTransactions(wallet.accountReference);
          const paid = content.filter((t) => t.paymentStatus === "PAID");
          await cacheWalletBalance(wallet.accountId, paid.reduce((s, t) => s + t.amount, 0));
          for (const t of paid) {
            const parsed = typeof t.createdOn === "number" ? t.createdOn : t.createdOn ? Date.parse(t.createdOn) : Date.now();
            publishEvent(
              wallet.accountId,
              {
                type: "payment",
                amount: t.amountPaid ?? t.amount,
                from: t.customerDTO?.name ?? "a bank transfer",
                reference: t.transactionReference,
              },
              Number.isNaN(parsed) ? Date.now() : parsed,
            );
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
