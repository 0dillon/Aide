# Live-proof results — Monnify sandbox (16 July 2026)

Mock-free verification of the money loop before building the app. Everything below
is a real call against `https://sandbox.monnify.com` on merchant "byte tech".

## ✅ Proven working (no activation needed)
| Step | Result |
|---|---|
| Auth (`/api/v1/auth/login`) | bearer token issued, cached ~1h |
| Create reserved account (`/api/v2/bank-transfer/reserved-accounts`) | real NUBANs minted (Wema/Sterling/Access), e.g. `1000824409` |
| Account name resolves in websim | `MONNIFY / byte tech-Aid` |
| Inbound payment via websim | ₦12,000 → "Transaction Successful" |
| Confirm via API (`/reserved-accounts/transactions`) | **PAID**, ref `MNFY|04|20260716104241|000067` |

**Conclusion:** the demo loop — worker gets an account → employer pays → Monnify
confirms → Aide announces the verified amount → balance — works end to end, today.

## ⛔ Blocked: outbound disbursement (withdrawal)
- Single transfer (`/api/v2/disbursements/single`) returns **`PENDING_AUTHORIZATION`**
  → transfer 2FA/OTP is on; `validate-otp` rejects fixed test codes (real OTP sent to merchant).
- Wallet balance / disbursement wallet: **"Wallet disbursement information not found"**.
- Root cause: **"Enable Disbursements to third party accounts"** (Settings → Preferences)
  is OFF and toggling it redirects to **full business activation + KYC** (business info,
  beneficial owners, agreement, Monnify manual review). Not a same-day unblock.

**Decision:** scope the hackathon demo to the **inbound** loop (fully working). Show
withdrawal as "transfer initiated → pending authorization" (a real API call) and narrate
Aide's accessible auth model (voice consent + spoken name read-back replacing a visual OTP).
If business activation is approved before the deadline, upgrade to real payouts.

## Gotchas captured
- Wallet balance endpoint wants `?walletId=` (not `accountNumber`) on this deployment.
- Single transfer requires `destinationAccountName` in the payload.
- Reserved (virtual) accounts don't resolve via the disbursement name-enquiry endpoint.
- Websim requires the paying **Bank to match** the reserved account's bank, and the
  Account Name must resolve before "Make Payment" submits.
- Sandbox base URL: `https://sandbox.monnify.com`. Contract code `4523534626`, wallet `3698482569`.
