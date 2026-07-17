# PRD — Aide: a voice-native work & pay platform for blind and visually impaired Nigerians

**Event:** APIConf × Monnify Developer Challenge (`#APIConfXMonnify`)
**Submission:** ~12pm WAT, ~24–25 July 2026 (confirm exact date/time in the `apiconf-hackathon` Slack channel)
**Team size:** 2 (required)
**Constraint:** All finance/payment functionality must use the **Monnify Sandbox API** (no live keys)
**Working product name:** *Aide* (the agent) / *Aide* (the platform) — rename freely.

> This is a hackathon PRD, not a startup PRD. Everything below is scoped to what a 2-person team can ship and *demo live* before the deadline. Anything that doesn't show up in the 3-minute demo is out of scope until it does.

---

## 1. The problem (lead with this in the pitch)

A blind Nigerian who can code, transcribe, translate, or do phone-based customer support cannot use the tools that would get them hired. Job boards, application forms, skills assessments, and — critically — the payment dashboards where their money lands are all built for people who can see a screen and use a keyboard. The result: capable people locked out of digital income not by ability, but by interface.

**The ambulance-test sentence:** *"A blind graduate who can transcribe faster than you can't finish a single job application — because every form, test, and payment screen assumes she can see it."*

**The enemy:** the screen-and-keyboard assumption baked into every fintech and job platform.

## 2. The user

- **Primary:** blind / severely visually impaired Nigerian adults seeking remote, task-based income (transcription, translation, audio QA, phone support, data labeling, simple coding).
- **Secondary:** employers posting accessible, task-based jobs who need a way to verify a candidate's skill and pay them.
- **Never assume the user can:** see a screen, read an OTP, visually confirm an account number, or use a keyboard reliably.

## 3. What it is (one line)

A fully **voice-native** platform where a blind user talks to an agent — **Aide** — that finds jobs, applies on their behalf, runs oral skill assessments, and receives, verifies, and disburses their pay via Monnify — all without a screen or keyboard.

## 4. Goals & success criteria

**Hackathon win condition (the real goal):**
- A live, unmocked demo where a judge (blindfolded or eyes-closed) completes a full loop by voice: *hear a job → apply → take a short oral assessment → get "hired" → receive payment → withdraw to a bank account* — narrated entirely by Aide.
- Every money moment runs on real Monnify sandbox calls, verified server-side.
- Judges *feel* the accessibility problem within the first 20 seconds.

**Explicit non-goals for the hackathon:**
- Real user accounts at scale, real employers, real KYC.
- A visual UI beyond a minimal debug/observer screen (for judges who *can* see, running in parallel to the voice).
- Native mobile app. (Responsive web + Web Speech API or a telephony layer is enough.)

## 5. Scope

### Must-have (this is the demo — build these first)
1. **Voice I/O loop** — STT in, Aide reasons, TTS out. Barge-in tolerable; latency < ~2s per turn.
2. **Aide agent** with a fixed set of tools (see §7). Deterministic on money; conversational on navigation.
3. **Job discovery + application** — a small seeded set of accessible jobs; Aide reads them, user picks, Aide applies.
4. **Oral assessment** — Aide administers a short spoken skills test on behalf of the employer, scores it, and records a pass/fail + a skill verification flag.
5. **Payment receipt** — on "hire + task complete," employer funds land in the user's **Monnify reserved account**; Aide announces it *after server-side verification*.
6. **Withdrawal** — user says "send my money to my bank"; Aide does **name-enquiry read-back** ("Sending to ADEBAYO OKON at GTBank — correct?"), then disburses via Monnify **single transfer**, **without any human reading an OTP**.

### Nice-to-have (only if the loop above is solid)
- Application tracking ("what did I apply to, what's the status").
- Balance/history queries by voice.
- Platform fee via transaction splitting (otherwise hardcode/skip).
- Employer-side voice or web flow to post a job and confirm completion.

### Cut without hesitation
- Auth beyond a magic link / pre-seeded demo users.
- Direct-debit mandates, recurring payments, bulk transfers.
- Multi-language (English + optionally Pidgin prompts only).
- Anything requiring live Monnify keys.

## 6. Core user flows (voice-native)

**F1 — Onboard & find work**
User: "Aide, find me transcription jobs." → Aide lists 2–3 seeded jobs with pay + task. → User: "Apply to the second one." → Aide confirms and applies.

**F2 — Prove the skill (oral assessment)**
Aide: "This job needs a transcription test. I'll play 20 seconds of audio; repeat what you hear." → captures response → scores → marks skill **verified**. Employer sees the verified result.

**F3 — Get paid**
Employer marks task complete + funds the reserved account (in demo, triggered via the Monnify websim). → Webhook fires → server verifies signature + re-fetches transaction → Aide: "You've just been paid ₦12,000 for the transcription job."

**F4 — Withdraw**
User: "Send it to my bank." → Aide validates the account (name enquiry) and reads the name back for spoken confirmation → on "yes," disburses via single transfer → confirms landing.

## 7. The Aide agent — responsibilities & guardrails

**Aide's tools (the only actions it can take):**
`listJobs`, `applyToJob`, `startAssessment`, `submitAssessment`, `getBalance`, `getApplicationStatus`, `validateBankAccount`, `initiateWithdrawal`, `confirmWithdrawal`.

**Guardrails (these are also scoring points — "AI slop is frowned upon"):**
- Aide **never** reports a payment, balance, or transfer from its own reasoning or from a raw webhook. Money facts come only from a verified server call. The LLM narrates; it never decides financial truth.
- Every money-moving action requires an explicit spoken confirmation, and Aide reads back the amount + destination name before executing.
- Aide degrades gracefully: if STT is unclear on a money command, it re-confirms rather than guessing.

## 8. Payment / finance architecture (Monnify — the sponsor-critical layer)

| Flow | Monnify primitive | Endpoint area |
|---|---|---|
| Per-user earnings account | **Reserved Account** (dedicated virtual NUBAN), created with Contract Code `4523534626` | Reserved Accounts |
| Employer pays worker | Inbound to reserved account → **webhook** | Webhooks + Event Logs |
| Verify a payment before announcing | Signed webhook (`monnify-signature`, SHA-512 HMAC) → server-side `GET` transaction | Transactions |
| Confirm the user's bank before payout | **Validate bank account / name enquiry** | Verification |
| Withdrawal | **Single Transfer** (disbursement) | Transfers |
| Balance | Reserved-account transactions / **Balances** | Balances |
| (Optional) platform fee | **Transaction splitting / sub-accounts** | Settlements |

**Sandbox mechanics:** inbound "employer payments" are simulated in the demo via the Monnify web simulator (`https://websim.sdk.monnify.com/?#/bankingapp`) sending a transfer to the user's reserved account, which fires the real webhook. Auth is API-key+secret → bearer token (~1h TTL, cache it).

## 9. Technical architecture

- **Frontend / voice:** responsive web; STT + TTS (Web Speech API for demo speed, or a hosted STT/TTS + a telephony option as stretch). A minimal parallel "observer" screen shows the transcript + state for sighted judges.
- **Agent:** LLM with strict tool-calling; tools are typed server functions, not free-form. Latest capable Claude model for reliable tool use.
- **Backend:** one small service (Next.js API routes or a light server) exposing the tool endpoints + the Monnify webhook receiver.
- **DB:** boring and known (Postgres/Convex/SQLite) — users, jobs, applications, assessments, transactions ledger.
- **Monnify integration:** server-side only; keys never touch the client.
- **Public tunnel/deploy** from day one so webhooks are reachable (ngrok/localtunnel or an early deploy).
- **Repo:** public + documented (empirically correlated with winning; also required to submit).

## 10. Accessibility principles (non-negotiable — this is the whole point)

- No task requires sight or a keyboard to complete, end to end.
- Aide confirms before every irreversible/money action, and reads back critical values.
- Audio-first error handling: every failure has a spoken, human explanation — never a silent dead-end.
- Test the demo *with eyes closed / screen off*. If you can't finish it that way, it isn't done.

## 11. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Disbursement OTP** collides with "no screens" — can't ask a blind user to read an SMS OTP | **Critical** | Prove a payout with **no human OTP** on day 1: keep transfers under any 2FA threshold and/or authorize programmatically as the merchant; the *voice* "yes" is your confirmation layer. If unsolved, the withdrawal flow breaks. |
| Webhooks unreachable on localhost | High | Public tunnel/deploy immediately; use Event Logs to replay. |
| Aide "hallucinates" a payment | High | Money facts only from verified server calls; verify webhook signature + re-fetch transaction before Aide speaks. |
| STT mishears a money command | High | Mandatory read-back + spoken confirmation before executing. |
| Voice latency kills the demo | Medium | Pre-warm models, stream TTS, keep turns short, rehearse. |
| Over-scoping (employer portal, splitting, tracking) | Medium | Ship F1–F4 first; everything else is nice-to-have. |
| "AI slop" perception | Medium | Deterministic money layer + genuine accessibility utility, not a chat wrapper. Say so in the pitch. |

## 12. Demo script (3 minutes, rubric-aligned)

- **0:00–0:20 — Problem, felt.** Presenter closes eyes / screen off. "Everything you're about to see, I'll do without looking." One line on the locked-out blind worker.
- **0:20–1:30 — The loop, live.** By voice only: find a transcription job → apply → take the oral assessment → get marked verified & hired.
- **1:30–2:20 — The money, real.** Employer pays (websim) → Aide announces the verified payment → "send it to my bank" → Aide reads back the account name → disburses via Monnify → confirms it landed. Name the Monnify primitives out loud (reserved account, verification, transfer).
- **2:20–3:00 — Why it matters + what's next.** Who this frees; one next milestone. Close on the problem, not the tech.

Backups: recorded video + screenshots of every step in case live voice/API dies.

## 13. Timeline (from 16 July; deadline ~24–25 July)

- **Day 1 — De-risk.** Join Slack, form/confirm team, get sandbox keys, register webhook, run the **live-proof**: reserved account → websim inbound → verified webhook → disbursement with **no OTP**. Do not build UI until this runs.
- **Day 2–3 — Money spine.** Reserved-account-per-user, verified payment announcement, name-enquiry withdrawal, ledger. All server-side, callable as Aide tools.
- **Day 3–4 — Voice loop + Aide tools.** STT/TTS, agent with the §7 toolset, job list + apply.
- **Day 5 — Oral assessment + skill verification.**
- **Day 6 — Polish (judges reward polished delivery), observer screen, error handling, eyes-closed test.**
- **Day 7 — Rehearse demo, record backup video, write README, post `#APIConfXMonnify` + `#DeveloperChallenge`, submit early.**
- Buffer built in because build-days ÷ 3 = real days after life happens.

## 14. Team split (2 people)

- **Person A — Money + backend:** Monnify integration, webhooks, verification, disbursement, ledger, tunnel/deploy. Owns the day-1 live-proof.
- **Person B — Voice + agent + demo:** STT/TTS, Aide agent + tools, job/assessment flows, observer UI, pitch. Owns rehearsal and delivery (put the more charismatic presenter on the mic).

## 15. Submission checklist (missing a deliverable = auto-loss)

- [ ] Team of 2 registered in `apiconf-hackathon` Slack
- [ ] Built on Monnify **sandbox** API only
- [ ] Public, documented repo
- [ ] Demo video + live demo ready (with backups)
- [ ] Social post: `#APIConfXMonnify` and `#DeveloperChallenge`
- [ ] Submitted via the Slack channel link **before** 12pm WAT on the deadline
