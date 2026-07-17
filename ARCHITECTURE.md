# Architecture

How Aide is put together, and the rules that keep it trustworthy about money. Read this
before extending the app.

## The one hard rule

**The language model never decides a financial fact.** It only narrates what a Monnify
tool returned *this turn*. Balances, payment statuses, account names, and transfer results
all come from real API calls. This is enforced in two places — the system prompt
(`lib/agent/system.ts`) tells the model never to invent a number, and the tools
(`lib/agent/tools.ts`) are the only path to a money value. Keep both in sync when you add
capabilities.

## Request flow

A spoken command travels through the system like this:

```
Browser (app/page.tsx)
  │  Web Speech API: speech → text  (app/useVoice.ts)
  ▼
POST /api/agent   (app/api/agent/route.ts)
  │  full message history + system prompt
  ▼
DeepSeek (Vercel AI SDK, generateText, maxSteps: 6)
  │  chooses tools
  ▼
Aide tools (lib/agent/tools.ts)
  │  every money fact goes through…
  ▼
Monnify client (lib/monnify.ts)  ──►  Monnify sandbox API
  │
  ▼
reply text + state snapshot  ──►  browser speaks it, side-panel mirrors it
```

The API route is stateless per request: the browser sends the whole `messages` array each
time, and the route returns both the spoken `reply` and a `state` snapshot for the live view.

## Layers

| Layer | File(s) | Responsibility |
|---|---|---|
| Voice I/O | `app/useVoice.ts` | Browser STT/TTS wrapper. Loosely typed — Web Speech isn't in `lib.dom`. |
| UI | `app/page.tsx` | Mic button, spoken-reply display, type fallback, live observer panel. |
| Agent endpoint | `app/api/agent/route.ts` | Runs the model with the system prompt + tools; returns reply + state. |
| Agent brain | `lib/agent/system.ts`, `lib/agent/tools.ts` | Persona/rules + the tool surface. |
| Domain state | `lib/store.ts` | One demo worker, real reserved account, real balance from confirmed pay. |
| Payments client | `lib/monnify.ts` | Auth (cached bearer), reserved accounts, verify, name enquiry, transfer, webhook HMAC. |
| Config | `lib/env.ts` | Validates required env vars at boot; fails loudly if missing. |
| Proof CLIs | `src/*.ts` | Standalone scripts; `src/monnify.ts` and `src/env.ts` re-export `lib/`. |

The `src/` and `lib/` split is deliberate: `src/` scripts proved the Monnify loop before
any UI existed, and now re-export the same `lib/` code the app uses — one client, verified
two ways.

## Monnify integration notes

- **Auth** is Basic `base64(apiKey:secretKey)` → a bearer token (~1h), cached in
  `lib/monnify.ts` until 60s before expiry.
- **Never trust a webhook payload.** `isValidWebhook` checks the SHA-512 HMAC of the raw
  body, and the handler re-fetches the transaction via `verifyTransaction` before acting.
- **Balance** is computed, not read from a wallet endpoint — it's the sum of `PAID`
  reserved-account transactions (`lib/store.ts:getBalance`).
- **Withdrawal** hits `/disbursements/single`. Sandbox returns `PENDING_AUTHORIZATION`
  because third-party disbursement needs full business KYC — documented in `PROOF.md`.

## State & persistence

`lib/store.ts` is **in-memory** and holds a single seeded demo worker. The reserved account
and balance are real; jobs and applications are demo data. This resets on server restart.
For production, swap `store.ts` for a real datastore (Convex/Postgres) behind the same
function signatures — nothing above it needs to change.

## Adding a capability

1. Add the underlying call to `lib/monnify.ts` (or logic to `lib/store.ts`).
2. Expose it as a tool in `lib/agent/tools.ts` with a clear `description` and Zod params.
3. If it touches money, add a read-back/confirmation rule to `lib/agent/system.ts`.
4. If the UI should reflect it, extend the `snapshot()` shape in `lib/store.ts` and the
   observer panel in `app/page.tsx`.

## Known limits (hackathon scope)

- Single hardcoded demo worker; no auth or multi-tenant.
- In-memory state resets on restart.
- Outbound payouts are gated behind Monnify business activation (see `PROOF.md`).
- Web Speech quality varies by browser; Chrome is the target. A type fallback exists.
