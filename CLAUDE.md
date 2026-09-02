# Aide

Voice-native work-and-pay marketplace for blind, visually impaired and low-literacy
Nigerian workers. A worker talks; Aide finds gigs, applies, proctors the spoken
assessment, opens them a real bank account, announces wages landing, and moves money
out. The screen is the optional mirror, not the main event.

**Read `ARCHITECTURE.md` first** — request flow, layers, and the one hard rule (the
model never decides a financial fact; it only narrates what a tool returned this turn).

**Read `NEXT.md`** if it exists — current in-flight state, unpushed branches, gotchas.
It is a local scratch note, not committed.

## Who this is for, and why it changes decisions

Users cannot see the screen. That is not an accessibility checkbox here, it is the
design constraint:

- **A wrong spoken claim is unfalsifiable.** If Aide says it opened a page, or closed
  the microphone, or moved money, the user has no way to glance up and discover it
  didn't. Never let Aide state an action it did not actually perform.
- **Silence is indistinguishable from a crash.** There is no spinner. Long waits need a
  spoken cover.
- **There is no button they can find.** Controls that need a target on screen don't
  work; the mic hold is three taps anywhere for this reason.

When choosing between two implementations, the one that cannot lie out loud wins.

## Verifying

```bash
npm run typecheck   # must be clean
npm run lint        # gate is 0 ERRORS; ~484 warnings are a known documented backlog
npm test            # full suite, no network or deployment needed
npm run build       # succeeds with zero secrets, by design (lib/env.ts uses lazy getters)
```

- `.next` goes stale when switching branches and makes `typecheck` fail on
  `.next/types` referencing routes that don't exist. `rm -rf .next`. Not a real error.
- Tests need the Monnify/DeepSeek env vars present. Without `.env.local`, prefix with
  `MONNIFY_API_KEY=ci-placeholder MONNIFY_SECRET_KEY=ci-placeholder
  MONNIFY_CONTRACT_CODE=0000000000 DEEPSEEK_API_KEY=ci-placeholder
  NEXT_PUBLIC_CONVEX_URL=https://ci-placeholder.convex.cloud`.
- Chrome only for speech recognition. Other browsers get a typed fallback.

## Money

- Balances derive from an append-only ledger, never a mutable column.
- An unknown provider status must never map to "completed". Fail closed.
- **Never retry a money-moving call, and never abort one early.** A read that gives up
  costs a retry; a transfer that gives up costs a worker their wages. Monnify's
  disbursement endpoint takes no idempotency key.
- Known defect, not yet fixed: money is float64 naira and should be kobo integers.

## Wema / ALAT — abandoned

The project was once a Wema Hackaholics submission with an ALAT banking adapter behind
a provider seam. That is over. `main` carries none of it; it survives only on the
`submission`, `feat/banking-provider-seam` and `wema-archive/*` branches.

**Never push those branches or their files** (`lib/banking/alat*`, `docs/alat/`,
`src/alat-check.ts`, `SOLUTION.md`). A local `pre-push` hook enforces this on Dillon's
machine.

**But do not strip the word "Wema".** Wema Bank is a real Nigerian bank and a live
payout destination (NIP code 035, see `app/payments/page.tsx` and `lib/agent/tools.ts`).
Removing it breaks withdrawals. The distinction is: the hackathon adapter goes, the
destination bank stays.

## Git

- Only remote is `origin` (0dillon/Aide). Commits are authored by Dillon alone.
- **No `Co-Authored-By` trailers of any kind.** Not Claude, not anyone.
