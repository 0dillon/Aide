# Architecture

How Aide is put together, and the rules that keep it trustworthy about money. Read this
before extending the app.

## The one hard rule

**The language model never decides a financial fact.** It only narrates what a tool
returned *this turn*. Balances, payment statuses, account names, and transfer results all
come from real Monnify API calls. This is enforced in two places — the system prompt
(`lib/agent/system.ts`) tells the model never to invent a number, and the tools
(`lib/agent/tools.ts`) are the only path to a money value. Keep both in sync when you add
capabilities.

## Request flow

A spoken command travels through the system like this:

```
Browser (app/page.tsx + app/aide/*)
  │  Web Speech API: speech → text  (app/aide/voice-engine.ts)
  ▼
POST /api/agent   (app/api/agent/route.ts)  — streams NDJSON back
  │  full message history + system prompt
  ▼
DeepSeek (Vercel AI SDK, streamText, maxSteps: 6)
  │  chooses tools, streams reply text sentence-by-sentence
  ▼
Aide tools (lib/agent/tools.ts)
  │  domain reads/writes go through lib/store/* ; every money fact through…
  ▼
Monnify client (lib/monnify.ts)  ──►  Monnify sandbox API
  │
  ▼
streamed reply → browser speaks each sentence as it lands (edge_tts, app/api/tts)
```

The agent route streams the reply as newline-delimited JSON (`delta` / `done` / `error`),
so the browser starts speaking the first sentence while the rest is still generating
(`app/aide/agent-stream.ts`). The `done` frame carries navigation and account-switch
metadata, since cookies can't be set mid-stream.

## Layers

| Layer | File(s) | Responsibility |
|---|---|---|
| Voice I/O | `app/aide/voice-engine.ts` | Always-on browser STT/TTS wrapper. Loosely typed — Web Speech isn't in `lib.dom`. |
| Aide provider | `app/aide/index.tsx` | Global always-listening Aide, mounted in the root layout; follows the user across pages, speaks reactive alerts. |
| Agent client | `app/aide/agent-stream.ts` | Consumes the NDJSON stream; sentence splitter that decides when a chunk is ready to speak. |
| UI | `app/page.tsx`, `app/jobs/*`, `app/payments/*`, `app/profile/*`, `app/employer/*` | Screens the voice flow mirrors. Everything doable by voice is also doable here. |
| Agent endpoint | `app/api/agent/route.ts` | Runs the model with the system prompt + tools; streams reply + emits navigation/account metadata. |
| Agent brain | `lib/agent/system.ts`, `lib/agent/tools.ts` | Persona/rules + the tool surface. |
| Domain store | `lib/store/*` | Accounts, jobs, applications, wallets, events, and post-hire messages — Convex-backed. `state.ts` holds the in-memory seeded demo worker + static seed gigs. |
| Datastore | `convex/*.ts` | The shared, reactive datastore (see below). |
| Payments | `lib/monnify.ts`, `lib/payments.ts` | Auth (cached bearer), reserved accounts, verify, name enquiry, transfer, webhook HMAC, voice-confirmed withdrawals. |
| Speech synth | `app/api/tts/route.ts`, `scripts/tts_worker.py`, `api/speak.py` | Neural Nigerian-English voice via edge_tts (long-lived Python worker locally; a Vercel Python function in production). |
| Config | `lib/env.ts` | Validates required env vars at boot; fails loudly if missing. |
| Proof CLIs | `src/*.ts` | Standalone scripts that proved the Monnify loop; `src/monnify.ts` and `src/env.ts` re-export `lib/`. |

## Why Convex

On Vercel serverless, instances don't share memory — the webhook that records a payment and
the browser's live subscription land on different machines. Convex tables + reactive queries
make cross-instance delivery work by construction: writing a row reaches every subscribed
browser, wherever it's served. This powers three live features:

- **Payment alerts** — `convex/events.ts`. The webhook (or local poller) inserts an event
  row; the browser's `useQuery` speaks it aloud the moment it lands.
- **The apply → hire → pay loop** — `convex/applications.ts`. Both worker and employer see
  the same application state regardless of which instance served them.
- **Post-hire onboarding messages** — `convex/messages.ts`. Once an employer hires an
  applicant, a private channel opens between the two parties (`lib/store/messages.ts`,
  `app/api/messages/route.ts`, the `send_message` / `read_messages` voice tools, and the
  reactive `app/jobs/message-thread.tsx`). Each message is also announced to the other
  party's event feed, so their Aide reads it aloud — the accessible equivalent of a
  notification. The channel is gated: it only opens after hiring.

Our own string ids (`demo-worker`, `u-xxxx`, `aide-<id>`) are kept as plain fields, separate
from Convex's `_id`, so cookies, wallet references, and Monnify customer records keep working.

## Monnify integration notes

- **Auth** is Basic `base64(apiKey:secretKey)` → a bearer token (~1h), cached in
  `lib/monnify.ts` until 60s before expiry.
- **Never trust a webhook payload.** `isValidWebhook` checks the SHA-512 HMAC of the raw
  body, and the handler re-fetches the transaction via `verifyTransaction` before acting.
- **Balance** is computed, not read from a wallet endpoint — it's the sum of confirmed
  `PAID` reserved-account transactions.
- **Withdrawal** is two steps, voice-confirmed (a spoken security phrase for workers, a
  random confirm word for employers), and hits `/disbursements/single`. Sandbox returns
  `PENDING_AUTHORIZATION` because third-party disbursement needs full business KYC —
  documented in `PROOF.md`.

## Adding a capability

1. Add the underlying call to `lib/monnify.ts` (money) or a `lib/store/*` module (domain).
2. If it must be visible across instances or reactive, back it with a `convex/*.ts` table
   and function, then run `npx convex dev` (or `codegen`) to regenerate `convex/_generated`.
3. Expose it as a tool in `lib/agent/tools.ts` with a clear `description` and Zod params.
4. If it touches money, add a read-back/confirmation rule to `lib/agent/system.ts`.
5. If the UI should reflect it, add or extend a screen — and keep it operable by voice.

## Known limits (hackathon scope)

- Single seeded demo worker; applications belong to that worker.
- The in-memory `state.ts` (demo worker + seed gigs) resets on server restart; Convex data
  persists.
- Outbound payouts are gated behind Monnify business activation (see `PROOF.md`).
- Web Speech quality varies by browser; Chrome is the target. A type fallback exists.
