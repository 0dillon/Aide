import { paymentProvider } from "../banking";
import { toNaira } from "../money";
import { state, type AideEvent } from "./state";
import { cacheBalanceKobo, listActiveWallets } from "./payments";
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
        // Through the seam. This poller is how Aide gets to say "₦5,000 just
        // landed from Adebayo" — under BMONI it was polling Monnify's
        // reserved-account transactions, an endpoint with nothing in it, so
        // wages would have arrived in silence. Silence is the one thing a
        // blind user cannot distinguish from a crash.
        const provider = paymentProvider();
        const credits = await provider.listInbound(wallet.accountId);
        reachedProvider = true;

        // The balance from the provider rather than a sum of the credits: for
        // BMONI the wallet balance already nets off withdrawals, and summing
        // credits would ignore every payout the worker has made.
        await provider
          .getBalanceKobo(wallet.accountId)
          .then((kobo) => cacheBalanceKobo(wallet.accountId, kobo))
          .catch(() => {
            /* the announcement matters more than the cache; getBalance will ask again */
          });

        for (const c of credits) {
          publishEvent(
            wallet.accountId,
            {
              type: "payment",
              amount: toNaira(c.amountKobo),
              from: c.from ?? "a bank transfer",
              reference: c.reference,
            },
            Number.isFinite(c.at) ? c.at : Date.now(),
          );
        }
      } catch (e) {
        // An answered error is proof the provider is UP — it just said no about
        // this one wallet. lib/monnify.ts marks those, and without checking the
        // mark a rejected wallet was indistinguishable from an unreachable
        // host: a stale or cross-environment accountReference, which is exactly
        // what a local demo accumulates, made every wallet fail and walked the
        // interval from 15s to 5 minutes while Monnify was perfectly healthy.
        // This poller is the only delivery path when no tunnel can reach the
        // webhook, so that is real money landing and Aide saying nothing about
        // it for five minutes.
        if ((e as { answered?: boolean }).answered) reachedProvider = true;
        /* otherwise transient for this wallet — the backoff below decides how soon to retry */
      }
    }

    // Backing off is about the provider being unreachable, not about one wallet
    // erroring. If anything got through, the connection is fine.
    pollFailures = reachedProvider ? 0 : Math.min(pollFailures + 1, 5);
    schedule();
  };

  schedule();
}
