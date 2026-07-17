# Aide

**Voice-native work & pay platform for blind and visually impaired workers in Nigeria.**
Built for APIConf × Monnify. A worker talks, Aide does everything else — finds jobs, runs
a spoken skill assessment, opens a real bank account, confirms incoming pay, and reads the
balance back aloud. No screen required.

The whole product is one idea: **a blind user can't read an SMS OTP or a screen, so the
entire loop — earn, verify, get paid — has to work by voice with spoken confirmation
replacing every visual step.**

---

## What works today

Everything below is backed by **real Monnify sandbox calls**, not mocks (see
[`PROOF.md`](PROOF.md) for the live verification log):

- **Earnings account** — each worker gets a real reserved NUBAN minted via Monnify.
- **Employer pays in** — inbound payment lands, Aide re-fetches it server-side and only
  then announces the confirmed amount.
- **Balance** — the real sum of confirmed (`PAID`) inbound transactions, spoken aloud.
- **Withdrawal** — a real disbursement call. In sandbox it returns
  `PENDING_AUTHORIZATION` because third-party disbursement is gated behind full business
  KYC (see PROOF.md). Aide narrates this honestly rather than faking success.

## The voice loop

1. Worker taps once and speaks (Web Speech API — STT in, TTS out).
2. The transcript goes to `/api/agent`, which runs the model (DeepSeek) with a tool set.
3. The model never invents a number — every money fact comes from a Monnify tool result.
4. The reply is spoken back, and a live side-panel mirrors state for sighted judges.

---

## Quick start

```bash
npm install
cp .env.example .env     # fill from app.monnify.com/developer
npm run dev              # http://localhost:3000
```

Open in **Chrome** (best Web Speech support), tap the mic, and try:
> "Find me transcription jobs" · "Apply me to the first one" · "What's my balance?"

`.env` needs your Monnify keys plus an `ANTHROPIC_API_KEY` for the Aide agent. See
[`.env.example`](.env.example) for every variable and where to find it.

---

## The money-loop proof (run before trusting the app)

The proof scripts verify the Monnify loop independently of any UI:

```bash
npm run proof      # auth → reserved account → validate → attempt disbursement
npm run webhook    # signed inbound webhook receiver (pair with: npx localtunnel --port 4000)
npm run balance    # wallet balance check
```

`npm run proof` prints `SUCCESS` (no OTP — withdrawals work) or `PENDING_AUTHORIZATION`
(2FA required — the documented sandbox state). Results are captured in [`PROOF.md`](PROOF.md).

---

## Project layout

| Path | What it holds |
|---|---|
| `app/` | Next.js App Router UI — voice page, agent API route |
| `app/useVoice.ts` | Web Speech API wrapper (STT + TTS) |
| `lib/monnify.ts` | Monnify client — auth, reserved accounts, verify, transfer, webhook HMAC |
| `lib/agent/` | Aide's system prompt and tool definitions |
| `lib/store.ts` | Demo worker state + real balance from confirmed inbound payments |
| `src/*.ts` | Standalone CLI proof scripts (thin shims re-export `lib/`) |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how a spoken command flows through the system,
the design rules that keep the agent honest about money, and where to extend it.

---

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, data flow, extension points
- [`POSITIONING.md`](POSITIONING.md) — competitive landscape + how Aide wins
- [`PROOF.md`](PROOF.md) — mock-free Monnify sandbox verification log
- [`PRD.md`](PRD.md) — product requirements

## Tech

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Vercel AI SDK +
DeepSeek · Monnify API · Web Speech API.
