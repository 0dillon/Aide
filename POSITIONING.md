# Positioning — why Aide wins

Research-backed. This is who already exists, the gap they leave open, and the specific
moves that make Aide different enough to win.

## Who's already doing pieces of this

| Player | Region | What it does | What it's missing |
|---|---|---|---|
| **BSpeak** | India | Voice crowdsourcing for blind workers: re-speak audio → ASR transcribes → paid via Paytm at ₹10 | Research prototype, **one task type** (transcription), no skill matching, no agent (rigid flow), no real bank account, one-sided pay |
| **Hello! UPI / 123UPI (Ubona)** | India | Voice-activated payments over a phone call (NPCI) | **Payment only** — no work, no earning side |
| **Nigerian banks** (OPay, UBA, Ecobank) | Nigeria | Retrofitting screen readers + ATM voice prompts | Access to *existing* banking only; no work, still OTP/CAPTCHA-gated |
| **Vinsighte** | Nigeria | Text-to-audio reading glasses (hardware) | Not fintech, not work |
| **Be My Eyes** | Global | Connects blind users to sighted volunteers | Assistance, not income or payment |

## The gap nobody fills

> A **single conversational voice agent** that runs the *whole* economic loop —
> **find work → prove skill by voice → get paid on real bank rails → confirm & withdraw** —
> for blind users in Africa.

- BSpeak = work, but no real bank, one task, no agent, research-only.
- Hello UPI = pay, but no work.
- **Aide = work + pay + agent + real reserved NUBAN, unified in one voice.**

## The documented pain we attack (Nigeria)

A survey of 10 leading Nigerian banks found their apps unusable with screen readers. Blind
users report the exact failures Aide is designed around:

- **"Open your eyes" biometrics / image CAPTCHAs** — impossible for a blind user.
- **OTP / USSD token systems** that time out and aren't speech-enabled.
- **No audio confirmation** on transactions — constant uncertainty money moved.
- **Unlabeled buttons** — screen reader says "button, button, button".

Aide's answer: **voice-native auth (spoken name read-back + voice consent) replaces the
visual OTP**, and **every money event is confirmed aloud**. This is the emotional core of
the pitch, not a footnote.

## The five moves that make us different

1. **Agent, not a menu.** Competitors are rigid "press 1" flows. Aide is a real LLM agent:
   *"find me transcription jobs and apply me to the best one"* in one breath. This is the
   2026 differentiator — lean into it in the demo.
2. **Honest-money architecture as a trust story.** The model never decides a financial
   fact; every number comes from a real Monnify call. Judges reward provable safety — make
   it visible (show the live side-panel mirroring real API state).
3. **Real bank rails, not a wallet IOU.** BSpeak pays a Paytm balance. Aide mints each
   worker a **real reserved NUBAN** — money they own, withdrawable to any bank. Stronger
   financial-inclusion story.
4. **Two-sided and real.** Employer pays in (proven working, see PROOF.md) → worker hears
   the *confirmed* amount → withdraws. BSpeak is one-sided.
5. **Honest about what voice can and cannot secure.** Withdrawal requires Aide to read back
   the amount and the destination account name, and the user to speak a one-time word —
   BSpeak's "verify before submit" idea, applied to money. Say what it is: a **consent
   gate, not a second factor.** Someone in the room hears the word, so it proves intent,
   never identity. Identity is defended by the parts that do not depend on speech: money
   can only leave to a destination registered earlier and name-checked with the bank, a new
   destination is held before it can receive anything, and withdrawals are capped. Speaker
   verification is the correct next control and is not built yet. Naming that gap is a
   stronger position than claiming "voice 2FA" and being taken apart on it.

## Fast wins to widen the gap (hackathon-scoped)

- **Speak every money event** (balance, incoming pay, withdrawal result) — the exact thing
  Nigerian apps fail at. Mostly there; make it airtight.
- **Multilingual prompt** — Hello UPI and BSpeak are racing to add regional languages.
  Even one extra (Nigerian Pidgin / Yoruba) in the demo is a strong inclusion signal.
  `useVoice` already sets `en-NG`.
- **"Re-speak to confirm" withdrawal** — a spoken one-time word as an accessible consent
  gate (intent, not identity — see above).

## Sources

- BSpeak — Vashistha et al., accessible voice crowdsourcing for blind workers (Medium/HCCXB)
- Hello! UPI — NPCI voice payments (paytm.com, npci)
- Nigeria fintech accessibility crisis — anvayafeats.org
- Vinsighte — en.majalla.com
