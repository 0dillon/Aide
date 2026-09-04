"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAide } from "../aide";

type Txn = { amount: number; status: string; from: string; reference: string; at: number | string | null };
type Withdrawal = { amount: number; accountName: string; status: string; at: number };
type Beneficiary = { accountName: string; accountNumber: string; bankCode: string; bankName?: string };

// Mirrors app/api/payments/card/route.ts. The four non-ok states are kept
// separate rather than folded into "no card": telling a worker whose card is
// mid-issuance that they have none invites them to request a second one, and
// the issuance fee is charged per request.
type CardView = {
  id: string;
  name: string;
  color?: string;
  currency: string;
  type: string;
  status: string;
  reserved: boolean;
  spoken: string;
};
type CardState =
  | { state: "ok"; cards: CardView[] }
  | { state: "not-configured" }
  | { state: "no-wallet" }
  | { state: "unavailable"; message?: string };

type Summary = {
  // null when the bank could not be reached. Unknown is not zero, and must
  // never be rendered as one.
  balance: number | null;
  balanceUnavailable?: string;
  name?: string;
  role?: "worker" | "employer";
  accountNumber?: string;
  bankName?: string;
  // What the BANK calls this account, which is not `name`. See the summary
  // route: `name` is the Aide profile, this is what a payer's name enquiry
  // returns. Showing the profile name here told an employer the account
  // belonged to "ClearVoice Media" while their bank said "Jabo Samson Joe",
  // which reads as a wrong account number and is a good reason to abandon a
  // legitimate payment.
  accountName?: string;
  payoutAccount?: string;
  payoutAccountName?: string;
  hasSecurityPhrase?: boolean;
  pendingWithdrawal?: { amount: number } | null;
};

type Bank = { code: string; name: string };

const naira = (n: number) => "₦" + n.toLocaleString("en-NG");

// Inline name-enquiry state for the destination fields — validation feedback
// lives right under the inputs (like OPay and other MFB apps), never only in
// a banner at the top of the page.
type Validation =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; accountName: string }
  | { status: "fail"; message: string };

export default function PaymentsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  // inbound is null when the bank could not be reached — which is NOT the same
  // as no payments, and must never be shown as such.
  const [history, setHistory] = useState<{
    inbound: Txn[] | null;
    inboundUnavailable?: string;
    outbound: Withdrawal[];
  } | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  // null means "still checking", which the panel says out loud rather than
  // rendering as an empty card.
  const [card, setCard] = useState<CardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Security phrase setup (workers only, until one is set)
  const [phraseInput, setPhraseInput] = useState("");
  const [savingPhrase, setSavingPhrase] = useState(false);

  // Destination: a saved beneficiary, or new account details with inline validation
  const [destChoice, setDestChoice] = useState<string>("new"); // "new" | `${accountNumber}|${bankCode}`
  const [acct, setAcct] = useState("");
  // Fetched, never hardcoded. The list used to be thirteen NIP codes baked
  // into this file — Monnify's vocabulary. BMONI calls the same banks
  // something else (Wema 035 vs 000017), and sending the wrong one fails name
  // enquiry with a message about the account number, so the person tries a
  // different account instead of a different bank. null = still loading.
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [banksError, setBanksError] = useState<string | null>(null);
  const [bank, setBank] = useState("");
  const [validation, setValidation] = useState<Validation>({ status: "idle" });
  const validateSeq = useRef(0);

  // Withdrawal flow
  const [amount, setAmount] = useState("");
  const [armed, setArmed] = useState<{ amount: number; accountName: string; mode: "word" | "passphrase"; phrase?: string } | null>(null);
  const [confirmWord, setConfirmWord] = useState("");
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const [saveOffer, setSaveOffer] = useState<Beneficiary | null>(null);
  const [savingBeneficiary, setSavingBeneficiary] = useState(false);

  const { listening, capturing, supported, speak, beginCapture, endCapture } = useAide();

  // Leaving the page with a withdrawal armed must hand the mic back to Aide.
  const endCaptureRef = useRef(endCapture);
  endCaptureRef.current = endCapture;
  // load() has an empty dependency array, so reach speak through a ref rather
  // than capturing the first render's copy.
  const speakRef = useRef(speak);
  speakRef.current = speak;
  useEffect(() => () => endCaptureRef.current(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Summary is primary; history and beneficiaries are secondary and never fail the page.
      const [res, h, b, c, bk] = await Promise.all([
        fetch("/api/payments/summary"),
        fetch("/api/payments/transactions").then((r) => r.json()).catch(() => null),
        fetch("/api/payments/beneficiaries").then((r) => r.json()).catch(() => null),
        // Secondary, like history: a card read that fails must not take the
        // balance down with it.
        fetch("/api/payments/card")
          .then((r) => r.json())
          .catch(() => ({ state: "unavailable" as const })),
        fetch("/api/payments/banks")
          .then((r) => r.json())
          .catch(() => ({ banks: null, error: "I could not load the list of banks just now." })),
      ]);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not load your payment details.");
      setSummary(data);
      // Say it, don't just show it. A red line on screen is not a notification
      // to someone who cannot see the screen, and a dash where a balance
      // should be is silent.
      if (data?.balanceUnavailable) speakRef.current(data.balanceUnavailable);
      if (h && !h.error) setHistory(h);
      if (b?.beneficiaries) setBeneficiaries(b.beneficiaries);
      setCard(c?.state ? c : { state: "unavailable" });
      if (Array.isArray(bk?.banks)) {
        setBanks(bk.banks);
        setBanksError(null);
        // Deliberately NOT auto-selected. With Monnify's thirteen banks a
        // default of GTBank was harmless; BMONI returns 302, and defaulting
        // landed on "AGOSASA MICROFINANCE BANK" — a bank nobody chose, sitting
        // pre-selected under an account number someone typed. On a screen you
        // would notice. This page is for people who cannot look.
      } else {
        setBanks([]);
        setBanksError(bk?.error ?? "I could not load the list of banks just now.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Inline validation: fires automatically once the account number is 10
  // digits, and re-fires when the bank changes. Sequenced so a slow older
  // response can't overwrite a newer one.
  useEffect(() => {
    if (destChoice !== "new") return;
    // No bank chosen yet: nothing to verify against, and verifying against a
    // default nobody picked is how money reaches the wrong account.
    if (!bank || !/^\d{10}$/.test(acct)) {
      setValidation({ status: "idle" });
      return;
    }
    const seq = ++validateSeq.current;
    setValidation({ status: "checking" });
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/payments/validate-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountNumber: acct, bankCode: bank }),
        });
        const data = await res.json().catch(() => null);
        if (validateSeq.current !== seq) return;
        if (res.ok && data?.accountName) setValidation({ status: "ok", accountName: data.accountName });
        else setValidation({ status: "fail", message: data?.error || "Bank details not found — check the account number and bank." });
      } catch {
        if (validateSeq.current === seq) setValidation({ status: "fail", message: "Could not reach the bank verification service." });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [acct, bank, destChoice]);

  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const savePhrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPhrase(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/security-phrase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase: phraseInput }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not save the security phrase.");
      setPhraseInput("");
      setNotice("Security phrase saved. It confirms every withdrawal — never share it.");
      speak("Your security phrase is saved. You will say it to confirm every withdrawal. Never share it with anyone.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingPhrase(false);
    }
  };

  const confirmWith = useCallback(
    async (word: string) => {
      const spoken = word.trim();
      if (!spoken || movingRef.current) return;
      movingRef.current = true;
      setMoving(true);
      setError(null);
      try {
        const res = await fetch("/api/payments/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", spokenPhrase: spoken }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "The withdrawal was not confirmed.");
        endCapture();
        setArmed(null);
        setAmount("");
        setConfirmWord("");
        setNotice(data.message);
        if (data.offerSaveBeneficiary) {
          setSaveOffer(data.offerSaveBeneficiary);
          speak(
            `${data.message} Would you like to save ${data.offerSaveBeneficiary.accountName} as a beneficiary for next time? There is a save button on screen, or just tell me yes.`,
          );
        } else {
          speak(data.message);
        }
        await load();
      } catch (e) {
        // Wrong phrase or transfer error: say it aloud and keep listening so
        // the worker can simply try again.
        setError((e as Error).message);
        speak((e as Error).message);
      } finally {
        movingRef.current = false;
        setMoving(false);
      }
    },
    [endCapture, load, speak],
  );

  const prepare = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSaveOffer(null);
    try {
      const dest =
        destChoice === "new"
          ? { accountNumber: acct, bankCode: bank }
          : { accountNumber: destChoice.split("|")[0], bankCode: destChoice.split("|")[1] };
      const res = await fetch("/api/payments/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", amount: Number(amount), ...dest }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not prepare the withdrawal.");
      setArmed({ amount: data.amount, accountName: data.accountName, mode: data.mode, phrase: data.phrase });
      setConfirmWord("");
      // Aide now waits for the confirmation — spoken aloud, hands-free.
      beginCapture((word) => {
        setConfirmWord(word);
        confirmWith(word);
      });
      speak(
        data.mode === "passphrase"
          ? `You are sending ${data.amount} naira to ${data.accountName}. To confirm, say your security phrase.`
          : `You are sending ${data.amount} naira to ${data.accountName}. To confirm, say the word: ${data.phrase}.`,
      );
    } catch (e) {
      setError((e as Error).message);
      speak((e as Error).message);
    }
  };

  const cancelWithdrawal = () => {
    endCapture();
    setArmed(null);
    setConfirmWord("");
  };

  const saveAsBeneficiary = async () => {
    if (!saveOffer) return;
    setSavingBeneficiary(true);
    try {
      const res = await fetch("/api/payments/beneficiaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveOffer),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not save the beneficiary.");
      setNotice(`${saveOffer.accountName} saved as a beneficiary.`);
      speak(`${saveOffer.accountName} is saved as a beneficiary. Next time you can just say their name.`);
      setSaveOffer(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingBeneficiary(false);
    }
  };

  const needsPhrase = summary?.role === "worker" && !summary?.hasSecurityPhrase;
  const destinationReady = destChoice !== "new" || validation.status === "ok";

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
      <h1 className="text-4xl font-bold tracking-tight">Payments</h1>
      <p className="mt-2 text-lg text-[var(--ink-soft)]">
        Your balance, your account for receiving pay, and voice-confirmed withdrawals. All numbers come from a live API, never invented.
      </p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-6 rounded-lg border-2 border-[var(--good)] px-4 py-3 font-bold text-[var(--good)]">
          ✓ {notice}
        </p>
      )}
      {saveOffer && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border-2 border-[var(--accent)] px-4 py-3">
          <p className="font-bold">
            Save {saveOffer.accountName} ({saveOffer.accountNumber}) as a beneficiary?
          </p>
          <button
            onClick={saveAsBeneficiary}
            disabled={savingBeneficiary}
            className="min-h-10 rounded-lg bg-[var(--accent)] px-4 py-2 font-bold text-white disabled:opacity-50"
          >
            {savingBeneficiary ? "Saving…" : "Save beneficiary"}
          </button>
          <button onClick={() => setSaveOffer(null)} className="min-h-10 rounded-lg border-2 border-[var(--ink)] px-4 py-2 font-bold">
            Not now
          </button>
        </div>
      )}

      {/* Balance */}
      <section id="balance" aria-label="Balance" className="mt-8 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Confirmed balance</h2>
        <p className="mt-2 text-5xl font-bold tabular-nums">
          {loading ? "…" : summary && summary.balance !== null ? naira(summary.balance) : "—"}
        </p>
        {summary?.balanceUnavailable && (
          // role="alert" so a screen reader announces it without being asked;
          // Aide says it aloud too, on load, in the effect below.
          <p role="alert" className="mt-2 font-bold text-[var(--alert)]">
            {summary.balanceUnavailable}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={load}
            disabled={loading}
            className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-5 py-3 font-bold disabled:opacity-50"
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
          <button
            onClick={() =>
              summary &&
              speak(
                summary.balance === null
                  ? summary.balanceUnavailable || "I could not get your balance from the bank just now."
                  : `Your confirmed balance is ${summary.balance} naira.`,
              )
            }
            disabled={!summary}
            className="min-h-12 rounded-lg bg-[var(--accent)] px-5 py-3 font-bold text-white disabled:opacity-50"
          >
            Read balance aloud
          </button>
        </div>
      </section>

      {/* Receiving */}
      <section id="receive" aria-label="Receive money" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Receive money</h2>
        <p className="mt-2 text-lg">Anyone can pay you by bank transfer to your real earnings account:</p>
        <dl className="mt-4 divide-y divide-[var(--line)] border-y border-[var(--line)]">
          <Row label="Account name" value={summary?.accountName ?? "—"} onCopy={copy} copied={copied} />
          <Row label="Account number" value={summary?.accountNumber ?? "—"} mono onCopy={copy} copied={copied} />
          <Row label="Bank" value={summary?.bankName ?? "—"} onCopy={copy} copied={copied} />
        </dl>
        <p className="mt-4 text-[var(--ink-soft)]">
          For the demo, an employer pays you from the{" "}
          <a href="/employer" className="font-bold text-[var(--accent)] underline underline-offset-2">
            employer payout desk
          </a>
          . When money lands, ask Aide for your balance and it announces the confirmed amount.
        </p>
      </section>

      {/* Sending / withdrawal */}
      <section id="send" aria-label="Send money" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Send money (withdraw)</h2>

        {needsPhrase && (
          <form onSubmit={savePhrase} className="mt-4 rounded-lg p-5" style={{ background: "var(--warn-bg)", color: "var(--warn-ink)" }}>
            <p className="text-lg font-bold">First, set your spoken security phrase.</p>
            <p className="mt-1">
              It replaces the SMS code you can’t read: you’ll say this phrase to confirm every withdrawal. Pick a short phrase of at
              least two words that only you would know — and never share it.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label htmlFor="sec-phrase" className="sr-only">
                Security phrase
              </label>
              <input
                id="sec-phrase"
                value={phraseInput}
                onChange={(e) => setPhraseInput(e.target.value)}
                placeholder="e.g. sunny garden gate"
                required
                className="min-h-12 w-72 rounded-lg border-2 border-[var(--warn-ink)] bg-white px-4 py-3 text-lg text-[var(--ink)]"
              />
              <button
                type="submit"
                disabled={savingPhrase || !phraseInput.trim()}
                className="min-h-12 rounded-lg bg-[var(--ink)] px-5 py-3 font-bold text-[var(--paper)] disabled:opacity-50"
              >
                {savingPhrase ? "Saving…" : "Save phrase"}
              </button>
            </div>
            <p className="mt-2 text-sm">Or just tell Aide: “set my security phrase”.</p>
          </form>
        )}

        {!armed ? (
          <form onSubmit={prepare} className="mt-4 space-y-4">
            <div>
              <label htmlFor="wd-dest" className="block font-bold">
                Send to
              </label>
              <select
                id="wd-dest"
                value={destChoice}
                onChange={(e) => setDestChoice(e.target.value)}
                className="mt-1 w-full max-w-sm rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
              >
                <option value="new">New account…</option>
                {beneficiaries.map((b) => (
                  <option key={`${b.accountNumber}|${b.bankCode}`} value={`${b.accountNumber}|${b.bankCode}`}>
                    {b.accountName} — {b.accountNumber}
                  </option>
                ))}
              </select>
            </div>

            {destChoice === "new" && (
              <div className="flex flex-wrap gap-4">
                <div>
                  <label htmlFor="payout-acct" className="block font-bold">
                    Account number
                  </label>
                  <input
                    id="payout-acct"
                    value={acct}
                    onChange={(e) => setAcct(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    inputMode="numeric"
                    pattern="\d{10}"
                    required
                    className="mt-1 w-56 rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
                  />
                </div>
                <div>
                  <label htmlFor="payout-bank" className="block font-bold">
                    Bank
                  </label>
                  <select
                    id="payout-bank"
                    value={bank}
                    onChange={(e) => setBank(e.target.value)}
                    disabled={!banks || banks.length === 0}
                    className="mt-1 w-56 rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
                  >
                    {banks === null && <option value="">Loading banks…</option>}
                    {banks?.length === 0 && <option value="">No banks available</option>}
                    {/* Stays selectable so the field can be returned to "unset"
                        rather than trapping whatever was picked first. */}
                    {banks !== null && banks.length > 0 && <option value="">Choose a bank…</option>}
                    {banks?.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  {banksError && (
                    <p role="alert" className="mt-1 font-bold text-[var(--alert)]">
                      {banksError}
                    </p>
                  )}
                </div>
                {/* Inline validation status — right under the fields, spoken-friendly */}
                <p aria-live="polite" className="w-full font-bold">
                  {validation.status === "checking" && <span className="text-[var(--ink-soft)]">Checking account…</span>}
                  {validation.status === "ok" && <span className="text-[var(--good)]">✓ Account found: {validation.accountName}</span>}
                  {validation.status === "fail" && <span className="text-[var(--alert)]">✗ {validation.message}</span>}
                  {validation.status === "idle" && acct.length > 0 && acct.length < 10 && (
                    <span className="text-[var(--ink-soft)]">Enter the full 10-digit account number.</span>
                  )}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="wd-amount" className="block font-bold">
                  Amount in Naira
                </label>
                <input
                  id="wd-amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="numeric"
                  required
                  className="mt-1 w-48 rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
                />
              </div>
              <button
                type="submit"
                disabled={!destinationReady || needsPhrase}
                className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white disabled:opacity-50"
              >
                Prepare withdrawal
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4 rounded-lg p-5" style={{ background: "var(--warn-bg)", color: "var(--warn-ink)" }}>
            <p className="text-lg font-bold">
              Confirm: send {naira(armed.amount)} to {armed.accountName}?
            </p>
            {armed.mode === "passphrase" ? (
              <p className="mt-2 text-lg">
                This is your spoken security check — it replaces the SMS code you can’t read. Say <strong>your security phrase</strong> to
                confirm.
              </p>
            ) : (
              <p className="mt-2 text-lg">
                Say the word: <strong className="text-2xl">{armed.phrase}</strong>
              </p>
            )}
            <p aria-live="polite" className="mt-2 font-bold">
              {moving
                ? "Confirming…"
                : capturing && listening && supported
                  ? "Aide is listening — just say it."
                  : "Type it below to confirm."}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label htmlFor="confirm-word" className="sr-only">
                Confirmation
              </label>
              <input
                id="confirm-word"
                type={armed.mode === "passphrase" ? "password" : "text"}
                value={confirmWord}
                onChange={(e) => setConfirmWord(e.target.value)}
                placeholder={armed.mode === "passphrase" ? "…or type your security phrase" : "…or type the word"}
                className="min-h-12 w-64 rounded-lg border-2 border-[var(--warn-ink)] bg-white px-4 py-3 text-lg text-[var(--ink)]"
              />
              <button
                onClick={() => confirmWith(confirmWord)}
                disabled={moving || !confirmWord.trim()}
                className="min-h-12 rounded-lg bg-[var(--ink)] px-6 py-3 text-lg font-bold text-[var(--paper)] disabled:opacity-50"
              >
                {moving ? "Sending…" : "Confirm & send"}
              </button>
              <button onClick={cancelWithdrawal} className="min-h-12 rounded-lg border-2 border-[var(--warn-ink)] px-5 py-3 text-lg font-bold">
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Transaction history */}
      <section id="history" aria-label="Transaction history" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Transaction history</h2>

        <h3 className="mt-4 text-lg font-bold">Money in</h3>
        {history?.inbound === null ? (
          // "No payments received yet" here would read as "nobody paid you",
          // which is a claim we cannot make when we could not look.
          <p role="alert" className="mt-1 font-bold text-[var(--alert)]">
            {history.inboundUnavailable || "I could not reach the bank to list payments received."}
          </p>
        ) : !history || history.inbound.length === 0 ? (
          <p className="mt-1 text-[var(--ink-soft)]">No payments received yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--line)]">
            {history.inbound.map((t) => (
              <li key={t.reference} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>
                  <span className="text-lg font-bold tabular-nums">{naira(t.amount)}</span>
                  <span className="ml-2 text-[var(--ink-soft)]">from {t.from}</span>
                </span>
                <span
                  className="rounded-full border-2 px-3 py-0.5 text-sm font-bold"
                  style={
                    t.status === "PAID"
                      ? { borderColor: "var(--good)", color: "var(--good)" }
                      : { borderColor: "var(--ink-soft)", color: "var(--ink-soft)" }
                  }
                >
                  {t.status === "PAID" ? "✓ confirmed" : t.status.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-6 text-lg font-bold">Money out</h3>
        {!history || history.outbound.length === 0 ? (
          <p className="mt-1 text-[var(--ink-soft)]">No withdrawals yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--line)]">
            {history.outbound.map((w, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>
                  <span className="text-lg font-bold tabular-nums">{naira(w.amount)}</span>
                  <span className="ml-2 text-[var(--ink-soft)]">to {w.accountName}</span>
                  <span className="ml-2 text-sm text-[var(--ink-soft)]">
                    {new Date(w.at).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                </span>
                <span
                  className="rounded-full border-2 px-3 py-0.5 text-sm font-bold"
                  style={
                    w.status === "SUCCESS"
                      ? { borderColor: "var(--good)", color: "var(--good)" }
                      : { borderColor: "var(--warn-ink)", color: "var(--warn-ink)" }
                  }
                >
                  {w.status === "SUCCESS" ? "✓ completed" : "processing"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* BMONI card */}
      <BmoniCardSection card={card} balance={summary?.balance ?? null} />
    </main>
  );
}

// The card panel at the foot of the page.
//
// Every state here is stated in words as well as drawn, because the person
// this page is for cannot see the card face. The card is rendered even when
// there is no card — an empty outline that says so — rather than the section
// vanishing, so "you have no card" and "the panel did not load" are not the
// same silence.
//
// There is deliberately no card number on the face. BMONI returns the PAN only
// from a separate sensitive-data call it documents as never-log, never-cache,
// and it publishes no masked-PAN field on the list route at all — so any digits
// drawn here would be invented ones.
function BmoniCardSection({ card, balance }: { card: CardState | null; balance: number | null }) {
  const cards = card?.state === "ok" ? card.cards : [];
  const first = cards[0];

  const spoken =
    card === null
      ? "Checking your card…"
      : card.state === "not-configured"
        ? "Card accounts are not switched on for this app yet."
        : card.state === "no-wallet"
          ? "You do not have a card account yet."
          : card.state === "unavailable"
            ? card.message || "I could not check your card just now."
            : first
              ? first.spoken
              : "You do not have a card yet.";

  return (
    <section id="card" aria-label="Card" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
      <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Card</h2>

      <div className="mt-4 flex flex-wrap items-start gap-6">
        <div
          className="flex aspect-[1.586/1] w-full max-w-[22rem] flex-col justify-between rounded-2xl border-2 p-5 text-white shadow-sm"
          style={{
            // The colour is the one the card was created with. Without a card
            // it stays a neutral outline rather than borrowing a live card's
            // look for something that does not exist.
            background: first ? (first.color ?? "#1B4332") : "var(--line)",
            borderColor: first ? "transparent" : "var(--ink-soft)",
            color: first ? "#fff" : "var(--ink-soft)",
          }}
        >
          <div className="flex items-start justify-between">
            <span className="text-sm font-bold uppercase tracking-widest opacity-90">BMONI</span>
            {first && (
              <span className="rounded-full border border-current px-2 py-0.5 text-xs font-bold uppercase">
                {first.type}
              </span>
            )}
          </div>

          {/* Where a PAN would go on a real card. It stays hidden by design. */}
          <p className="font-mono text-xl tracking-[0.2em] opacity-80">•••• •••• •••• ••••</p>

          <div className="flex items-end justify-between gap-3">
            <span className="text-base font-bold">{first ? first.name : "No card yet"}</span>
            <span className="text-sm font-bold tabular-nums opacity-90">
              {first ? first.currency : ""}
              {first && balance !== null ? ` ${naira(balance)}` : ""}
            </span>
          </div>
        </div>

        <div className="min-w-[14rem] flex-1">
          <p role="status" className="text-lg font-bold">
            {spoken}
          </p>
          {first && (
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex gap-2">
                <dt className="text-[var(--ink-soft)]">Status</dt>
                <dd className="font-bold">{first.reserved ? "being issued" : first.status.toLowerCase()}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-[var(--ink-soft)]">Currency</dt>
                <dd className="font-bold">{first.currency}</dd>
              </div>
            </dl>
          )}
          <p className="mt-3 text-sm text-[var(--ink-soft)]">
            The card number is never shown here. Ask Aide to read your card details aloud when you need them.
          </p>
        </div>
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onCopy: (label: string, value: string) => void;
  copied: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <dt className="text-sm font-bold text-[var(--ink-soft)]">{label}</dt>
        <dd className={`text-lg ${mono ? "font-mono tracking-wide" : "font-bold"}`}>{value}</dd>
      </div>
      <button
        onClick={() => onCopy(label, value)}
        disabled={value === "—"}
        aria-label={`Copy ${label}`}
        className="min-h-10 shrink-0 rounded-full border-2 border-[var(--ink-soft)] px-4 py-1 font-bold disabled:opacity-40"
      >
        {copied === label ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}
