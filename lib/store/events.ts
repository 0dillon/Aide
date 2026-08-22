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

// The poller is the fallback that makes LOCAL demos work without a public
// tunnel Monnify can reach (in production the webhook is the real path, and a
// serverless setInterval wouldn't survive anyway). It polls every active wallet
// and publishes confirmed payments into Convex, tagged with their real time so
// only genuinely new money is announced.
// How often the poller asks the payment provider for new transactions, and how
// far it backs off when the provider cannot be reached at all. A fixed interval
// meant an outage produced a doomed request every fifteen seconds forever, each
// one burning its full connect timeout — so the machine spent more time waiting
// on a host that was not answering than doing anything else.
const POLL_BASE_MS = 15_000;
const POLL_MAX_MS = 5 * 60_000;
let pollFailures = 0;

const nextPollDelay = () =>
  pollFailures === 0 ? POLL_BASE_MS : Math.min(POLL_BASE_MS * 2 ** pollFailures, POLL_MAX_MS);

export function ensurePolling(): void {
  // state.pollTimer stays set for the life of the loop — including while a tick
  // is in flight — so repeat calls from other requests cannot start a second one.
  if (state.pollTimer) return;

  const schedule = () => {
    state.pollTimer = setTimeout(tick, nextPollDelay());
  };

  const tick = async () => {
    let watched;
    try {
      watched = await listActiveWallets();
    } catch {
      schedule(); // Convex unreachable this tick — try again later
      return;
    }
    if (watched.length === 0) {
      pollFailures = 0;
      schedule();
      return;
    }

    let reachedProvider = false;
    for (const wallet of watched) {
      try {
        const { content } = await getReservedAccountTransactions(wallet.accountReference);
        reachedProvider = true;
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
        /* transient for this wallet — the backoff below decides how soon to retry */
      }
    }

    // Backing off is about the provider being unreachable, not about one wallet
    // erroring. If anything got through, the connection is fine.
    pollFailures = reachedProvider ? 0 : Math.min(pollFailures + 1, 5);
    schedule();
  };

  schedule();
}
