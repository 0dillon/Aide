# Aide

**A voice-native work-and-pay platform for blind and visually impaired workers in Nigeria.**
Built for APIConf × Monnify.

A worker talks; Aide does the rest — finds jobs, runs a spoken skill assessment, opens a
real bank account, confirms incoming pay, and reads the balance back aloud. No screen
required.

[**Live demo →** aide-ng.vercel.app](https://aide-ng.vercel.app) · Open in Chrome and just talk.

---

## 1. Project Overview

Aide is a two-sided gig marketplace — workers find and complete work, employers post and
pay for it — rebuilt so that **every step of the earn-verify-get-paid loop happens by
voice**, with a spoken confirmation replacing every visual step a blind user cannot read.

The core value proposition is simple: a visually impaired worker in Nigeria can go from
"I need work" to money confirmed in their own bank account **without ever reading a
screen, an OTP, or a form**. They speak to Aide; Aide navigates, fills forms, runs
assessments, and narrates real financial state back to them.

What makes that credible rather than a demo trick is that **the money is real**. Aide never
invents a number. Every balance, every account detail, and every transfer is a live
Monnify API call, re-verified server-side before Aide is allowed to say it out loud.

**Highlights**

- **Real earnings accounts** — each user is issued a dedicated virtual NUBAN via Monnify.
- **Confirmed-only balances** — the balance is the summed total of `PAID` inbound
  transactions, never an optimistic guess.
- **Voice-confirmed withdrawals** — a real disbursement, gated behind a spoken security
  phrase (the accessible replacement for an SMS OTP).
- **Live, unprompted payment alerts** — a signature-checked Monnify webhook drives a
  reactive announcement the moment money lands.
- **100% voice-controllable** — account creation, profile setup, gig posting (including
  multiple-choice assessments), applications, assessments, hiring, and withdrawals all
  work entirely by voice.
- **Post-hire onboarding channel** — the moment an employer hires an applicant, a private
  employer↔worker message thread unlocks for onboarding directives, credentials, and next
  steps. It works entirely by voice on both sides, and each message is read aloud to the
  other party the instant it arrives.

**Built with:** Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 4 ·
Convex · Vercel AI SDK + DeepSeek · **Monnify API** · Web Speech API · edge-tts.

---

## 2. Powered by Monnify

Monnify is the entire financial backbone of Aide. It is not a mocked or simulated payment
layer — the app talks to the live Monnify sandbox on every money-related action, and the
`lib/monnify.ts` client wraps a focused set of endpoints across four Monnify product
areas. The guiding rule throughout: **Aide may only speak a financial fact that a Monnify
call returned this turn.**

### Authentication

| Endpoint | Method | Role in Aide |
|---|---|---|
| `/api/v1/auth/login` | `POST` | Exchanges `Basic base64(apiKey:secretKey)` for a bearer token. Tokens are cached in-process and refreshed 60s before their ~1h expiry, so the hot path never pays an auth round-trip. |

### Reserved Accounts (dedicated virtual NUBANs) — *how every user receives money*

Each Aide account is backed by its own Monnify **Reserved Account**, keyed by a
deterministic `accountReference` (`aide-<accountId>`) so the same real NUBAN re-attaches
across restarts and serverless instances.

| Endpoint | Method | Role in Aide |
|---|---|---|
| `/api/v2/bank-transfer/reserved-accounts` | `POST` | Mints a dedicated NUBAN for a new user (with BVN/NIN for compliance, `getAllAvailableBanks: true`). Provisioned in the background at signup so account creation never blocks on the payment rail. |
| `/api/v2/bank-transfer/reserved-accounts/{accountReference}` | `GET` | Idempotency guard — fetched first on every provision so a returning/retried account reuses its existing NUBAN instead of erroring on a duplicate reference. |
| `/api/v1/bank-transfer/reserved-accounts/transactions?accountReference=…` | `GET` | **The source of truth for balance.** The confirmed balance is `sum(amount where paymentStatus == "PAID")`, minus the app's own withdrawal ledger. This is what Aide reads aloud. |

### Disbursements — *how workers withdraw*

| Endpoint | Method | Role in Aide |
|---|---|---|
| `/api/v1/disbursements/account/validate?accountNumber=…&bankCode=…` | `GET` | **Name Enquiry.** Powers two things: the inline "✓ Account found: NAME" validation under the withdrawal fields, and the read-back of the real destination name before any withdrawal is armed. |
| `/api/v2/disbursements/single` | `POST` | The actual transfer, executed only after the spoken confirmation passes. Sourced from the merchant wallet. |
| `/api/v2/disbursements/single/validate-otp` | `POST` | OTP-authorization step, wired for the production disbursement flow. |
| `/api/v1/disbursements/wallet-balance?walletId=…` | `GET` | Merchant wallet balance check (used by the standalone proof scripts). |

### Transaction Verification & Webhooks — *how live payments are trusted*

| Mechanism | Role in Aide |
|---|---|
| `/api/v2/transactions/{transactionReference}` (`GET`) | Every inbound payment is **re-fetched server-side** and confirmed `PAID` before Aide announces it. A webhook payload alone is never trusted about money. |
| Webhook receiver (`/api/payments/webhook`) | Verifies a **SHA-512 HMAC** of the *raw* request body against the `monnify-signature` header (`isValidWebhook`), then resolves the paid wallet from the reference and writes an event into Convex. |

**Why the webhook writes to Convex instead of an in-process listener:** on serverless, the
webhook and the user's browser hit different instances. An in-memory subscriber list would
drop the "money just landed" alert silently. Writing the event to Convex makes it reactive
across instances — every listening browser receives it and Aide announces it, unprompted.
A polling fallback covers local development without a public tunnel.

### The withdrawal flow, end to end

1. **Arm** — `prepare_withdrawal` checks the amount against the real available balance,
   runs **Name Enquiry** on the destination (new account, saved beneficiary, or dynamic
   entry), and stores a pending withdrawal in Convex.
2. **Confirm** — the worker speaks their personal **security phrase** (hashed, never
   echoed — the accessible replacement for an SMS OTP). The check-and-clear is a single
   atomic Convex mutation, so no double-spend is possible.
3. **Disburse** — `/api/v2/disbursements/single` runs, and the result is recorded in the
   withdrawal ledger that keeps the balance honest.

> **On sandbox honesty:** third-party disbursement in sandbox returns
> `PENDING_AUTHORIZATION` because live payout is gated behind full business KYC. Aide
> narrates this state truthfully rather than faking a success
> for the mock-free verification log.

---

## 3. The Problem & Solution

### The barrier

Nigeria has a large population of blind and visually impaired people, and the digital
work-and-pay economy is almost entirely inaccessible to them by design:

- **OTPs are unreadable.** The single most common security primitive — the SMS one-time
  code — assumes you can read a screen. For a blind user it is a hard wall in the middle
  of every payment.
- **Forms assume sight.** Signing up, posting a gig, entering a bank account, taking a
  skills test — all of it is built around visually scanning fields and tapping targets.
- **Screen readers retrofit; they don't reimagine.** Bolting a screen reader onto a
  sighted-first UI produces a slow, brittle experience, especially around money where a
  misread number has real cost.

The net effect: a capable worker is locked out of earning not by lack of skill, but by the
interface.

### The solution

Aide inverts the default. Instead of a visual app with voice bolted on, it is a **voice
application** where the screen is the optional mirror:

- **The whole loop is spoken.** Finding work, proving a skill, receiving pay, and
  withdrawing all happen through conversation with Aide.
- **Spoken confirmation replaces the OTP.** Withdrawals are gated behind a personal spoken
  security phrase and a mandatory read-back of the amount and destination name — accessible
  by construction, and never dependent on reading anything.
- **Aide is honest about money.** The agent is architecturally forbidden from stating a
  balance or payment it didn't get from a Monnify tool call this turn, so the voice you
  trust is never guessing.
- **The visual layer is genuinely accessible too.** Atkinson Hyperlegible type (designed by
  the Braille Institute), an Okabe-Ito colorblind-safe palette at WCAG-AAA contrast, 18px+
  text, large touch targets, visible focus rings, reduced-motion support, and no status
  ever conveyed by color alone.

---

## 4. User Journey & Onboarding Flow

A new worker never touches a form unless they want to. The entire journey below is
voice-driven; the screen simply mirrors it.

1. **Arrival & greeting.** The user opens Aide and taps once (browsers require one
   interaction before audio). Aide greets them with their real state and, for a new empty
   profile, offers to set it up.

2. **Voice sign-up.** *"Sign me up."* Aide asks for a name and whether they're joining as a
   worker or an employer, confirms both back, and creates the account. A dedicated Monnify
   NUBAN is minted in the background immediately.

3. **Voice onboarding.** Aide offers to build the profile conversationally — asking what
   work they can do (skills) and about their experience (turned into a short bio), reading
   it all back before saving. This is what matches them to jobs.

4. **Finding & applying for work.** *"Find me transcription jobs paying over twelve
   thousand."* Aide filters the board, reads the matches aloud, and applies on request —
   noting whether a spoken assessment is required.

5. **Proving the skill.** If a gig requires it, Aide runs the assessment — an **oral**
   question (LLM rubric-graded, fair, never reveals answers) or **multiple-choice** (read
   aloud, graded server-side, answer key never leaves the server), optionally time-bound
   with spoken countdown alerts. The worker can cancel by voice with a clear warning.

6. **Getting hired & paid in.** The employer hires (by voice), and Aide announces it out
   loud. The employer pays into the worker's **real NUBAN**; the moment the confirmed
   payment lands, Aide announces the amount — unprompted, via the Monnify webhook → Convex
   reactive path.

7. **Onboarding after the hire.** Hiring unlocks a private message channel between the two
   parties. The employer sends onboarding steps or credentials — *"Aide, message the worker:
   your login is…"* — and the worker hears it read aloud automatically, can ask *"Aide, read
   my messages,"* and replies by voice. It's the missing "now actually do the job" step,
   made accessible. Both sides also see the same live thread on screen.

8. **Withdrawing funds.** *"Send ten thousand naira to my GTBank account."* Aide validates
   the destination by Name Enquiry, reads the verified account name and amount back, and
   asks for the spoken security phrase. On confirmation, the real disbursement runs, and
   Aide offers to save the destination as a beneficiary for next time.

At every step, the user can tap anywhere or press any key to cut Aide off mid-sentence and
speak.

---

## 5. Local Setup & Installation

Aide runs across three processes: the Next.js app, the Convex data layer (kept running
alongside), and a local neural-voice dependency.

### Prerequisites

- **Node.js 20+** and **npm**
- **Python 3** with `edge-tts` (for the local neural voice)
- A **Monnify sandbox** account ([app.monnify.com](https://app.monnify.com) → Developer)
- A **DeepSeek** API key ([platform.deepseek.com](https://platform.deepseek.com)) — powers the agent
- **Google Chrome** — the only browser with `SpeechRecognition`; Aide detects others and falls back to a text box

### Install & run

```bash
# 1. Install dependencies
npm install
pip install -r requirements.txt        # edge-tts, for the local neural voice

# 2. Configure secrets
cp .env.example .env                    # fill from the Monnify Developer page + DeepSeek

# 3. Start the data layer — leave this running.
#    It provisions your own Convex deployment and writes NEXT_PUBLIC_CONVEX_URL
#    (and CONVEX_DEPLOYMENT) into .env.local automatically.
npx convex dev

# 4. Start the app (in a second terminal)
npm run dev                             # → http://localhost:3000
```

The first `npx convex dev` asks you to log in and create a project — take the defaults. The
demo worker and employer accounts seed themselves on first request, so there is nothing to
import.

Open **http://localhost:3000 in Chrome**, allow the microphone, and try:

> *"Find me transcription jobs"* · *"Apply me to the first one"* · *"What's my balance?"*

### Environment variables

| Variable | Required | Purpose |
|---|:---:|---|
| `MONNIFY_API_KEY` | ✅ | Monnify Developer → API Keys |
| `MONNIFY_SECRET_KEY` | ✅ | Monnify Developer → API Keys (also signs/verifies webhooks) |
| `MONNIFY_CONTRACT_CODE` | ✅ | Monnify Developer → Contract Code |
| `MONNIFY_BASE_URL` | | Defaults to `https://sandbox.monnify.com` |
| `MONNIFY_WALLET_ACCOUNT_NUMBER` | | Source account for disbursements |
| `MONNIFY_KYC_BVN` | | BVN attached to reserved accounts (defaults to the sandbox test BVN) |
| `DEEPSEEK_API_KEY` | ✅ | Powers the Aide agent (tool-calling) |
| `AIDE_MODEL` | | Agent model override (default `deepseek-chat`) |
| `EDGE_TTS_VOICE` | | Neural voice (default `en-NG-EzinneNeural`) |
| `PYTHON_BIN` | | Override if `python3`/`python` isn't auto-detected |
| `NEXT_PUBLIC_CONVEX_URL` | auto | Written by `npx convex dev` into `.env.local` — do not set by hand |

### Verifying the Monnify loop (optional)

Standalone scripts verify the payment loop independently of the UI:

```bash
npm run proof      # auth → reserved account → name enquiry → attempt disbursement
npm run webhook    # signed inbound webhook receiver (pair with: npx localtunnel --port 4000)
npm run balance    # wallet balance check
```

`npm run proof` prints `SUCCESS` or the documented `PENDING_AUTHORIZATION` sandbox state

### Troubleshooting

| Symptom | Fix |
|---|---|
| `NEXT_PUBLIC_CONVEX_URL is not set` | `npx convex dev` isn't running, or `npm run dev` started before it wrote `.env.local`. Restart `npm run dev`. |
| Aide never speaks | Browsers block audio until you interact — click the page once. Aide replays what it was going to say. |
| Aide can't hear you | Check the OS mic isn't muted. Aide announces this aloud after a few seconds of silence. Use Chrome. |
| No neural voice locally | `pip install -r requirements.txt`, and set `PYTHON_BIN` if `python` isn't on PATH. Aide falls back to the browser voice. |

---

## 6. Accessibility Design Rationale

Aide's users are blind, low-vision, and colorblind workers, so the interface is not a
sighted-first design with accessibility retrofitted — every visual decision starts from a
documented accessibility need. The voice layer serves users who can't see the screen at
all; this section covers the *visual* layer, for low-vision and colorblind users who use
their remaining sight. All of the values below live as design tokens in
[`app/globals.css`](app/globals.css).

### Typography — Atkinson Hyperlegible

The body font is **Atkinson Hyperlegible**, commissioned by the **Braille Institute of
America** specifically for low-vision readers. Conventional typefaces optimize for aesthetic
uniformity, which is precisely what harms legibility: the letter pairs that low-vision
readers most often confuse — `I` / `l` / `1`, `O` / `0`, `b` / `d`, `rn` / `m` — are drawn
to look similar. Atkinson Hyperlegible does the opposite, deliberately **exaggerating the
differences** between similar characters (distinct letter terminals, a slashed/oval-vs-round
zero, unambiguous ascenders) so each glyph is identifiable even when it lands on a damaged or
low-acuity region of the retina. Fewer character confusions means fewer misreads — which
matters most for the one thing this app is about: **account numbers and money amounts**. The
font is self-hosted at build time via `next/font`, so it never depends on a slow third-party
request to render.

### Sizing scale — large by default, not by zoom

- **18px base font size** (`html { font-size: 112.5% }`). WCAG treats 18px (or 14px bold)
  as the "large text" threshold, and low-vision users routinely need to zoom sighted-first
  sites to reach it. Starting there means the interface is usable **without** the user having
  to discover and operate a zoom control they may not see.
- **1.6 line-height and a generous type scale.** Extra leading reduces the "line crowding"
  that causes low-vision readers to lose their place or skip lines; headings and money
  figures are set large so the most important information is the easiest to read.
- **~48px minimum touch/click targets** (`min-h-12` throughout). Large targets help users
  with low vision *and* co-occurring motor impairments acquire controls reliably, per WCAG
  2.5.5 Target Size.

### Color — colorblind-safe *and* high-contrast

The palette is built on the **Okabe–Ito** qualitative palette, the de-facto standard for
color-vision-deficient (CVD) safe design, chosen so hues stay distinguishable across
deuteranopia, protanopia, and tritanopia. Two rules govern it:

1. **No meaning is ever carried by color alone.** This is the single most important rule for
   colorblind users. Every status in Aide is *also* stated in text and/or shape — "✓ Hired",
   "Applied — hired", "✓ Skill verified", "Declined" — and the active nav item is marked
   three independent ways (an `aria-current` attribute, inverted colors, **and** an
   underline). There are **no red/green pairs** used as the sole signal, because red↔green is
   the most common form of color blindness.
2. **Every foreground meets WCAG AAA contrast (≥ 7:1) on the paper background**, well beyond
   the AA (4.5:1) minimum, because low-vision users need contrast headroom, not the bare
   pass:
   - `--ink` `#191919` body text — **~15.8:1**
   - `--ink-soft` `#474e58` secondary text — **~8.4:1**
   - `--accent` `#005a9e` blue (links/actions) — **~7.3:1**, and a hue that stays legible in
     all common CVD types
   - `--alert` `#9e3900` dark vermillion (errors) — **~7:1**
   - `--good` `#006b54` dark teal (success) — always paired with a text label

The background is a **warm off-white (`#fffdf7`)** rather than pure `#ffffff`: maximal
white-on-black glare triggers photophobia and visual fatigue common in low-vision
conditions, and a slightly warm, slightly dimmed paper reduces that without sacrificing
contrast.

### Reinforcing signals for the remaining sight

- **Visible keyboard focus** — a 3px `--focus` outline with offset on every focusable
  element, switched to a brighter blue on dark surfaces so it never disappears against the
  transcript panel.
- **Interactive cursor feedback** — a pointer cursor on everything clickable and a
  not-allowed cursor on anything disabled, applied application-wide, so a low-vision user
  moving a large cursor can feel out what is actionable without reading fine print.
- **Reduced-motion support** — `prefers-reduced-motion` disables animation (which can cause
  disorientation or nausea) while preserving Aide's "speaking" glow as a static, non-moving
  cue.
- **Semantic structure for screen readers** — landmark regions (`banner`, `nav`, `main`,
  labelled `region`s), `role="log"` transcript and message threads with `aria-live` so new
  speech and incoming messages are announced automatically, `role="alert"` on errors,
  properly associated `<label>`s on every control, and a skip-to-content link.

The throughline: **redundancy**. Text, shape, contrast, and voice each carry the meaning on
their own, so no single sensory channel is load-bearing — which is what lets one interface
serve blind, low-vision, and colorblind users at the same time.

---

## Project layout

| Path | What it holds |
|---|---|
| `app/` | Next.js App Router UI: voice page, screens, API routes |
| `app/aide/` | The voice engine (mic, TTS queue, interrupts) and its React provider |
| `app/jobs/message-thread.tsx` | The reactive post-hire onboarding thread, shared by both parties |
| `app/employer/` | Employer "payout desk" showing the worker's real NUBAN to pay into |
| `convex/` | Schema and server functions — accounts, wallets, applications, events, messages |
| `lib/monnify.ts` | Monnify client: auth, reserved accounts, verify, transfer, webhook HMAC |
| `lib/agent/` | Aide's system prompt and tool definitions |
| `lib/store/` | Domain layer over Convex: accounts, payments, applications, jobs, events, messages |
| `src/*.ts` | Standalone CLI proof scripts |

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, data flow, extension points
