"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAide } from "../aide";

type Txn = { amount: number; status: string; from: string; reference: string; at: number | string | null };
type Withdrawal = { amount: number; accountName: string; status: string; at: number };

type Summary = {
  balance: number;
  name?: string;
  accountNumber?: string;
  bankName?: string;
  payoutAccount?: string;
  payoutAccountName?: string;
  pendingWithdrawal?: { amount: number } | null;
};

const BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "050", name: "Ecobank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank" },
  { code: "214", name: "FCMB" },
  { code: "058", name: "GTBank" },
  { code: "076", name: "Polaris Bank" },
  { code: "221", name: "Stanbic IBTC" },
  { code: "232", name: "Sterling Bank" },
  { code: "032", name: "Union Bank" },
  { code: "033", name: "UBA" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

const naira = (n: number) => "₦" + n.toLocaleString("en-NG");

export default function PaymentsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<{ inbound: Txn[]; outbound: Withdrawal[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Payout registration form
  const [acct, setAcct] = useState("");
  const [bank, setBank] = useState("058");
  const [savingPayout, setSavingPayout] = useState(false);

  // Withdrawal flow
  const [amount, setAmount] = useState("");
  const [armed, setArmed] = useState<{ amount: number; accountName: string; phrase: string } | null>(null);
  const [confirmWord, setConfirmWord] = useState("");
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);

  const { listening, capturing, supported, speak, beginCapture, endCapture } = useAide();

  // Leaving the page with a withdrawal armed must hand the mic back to Aide.
  const endCaptureRef = useRef(endCapture);
  endCaptureRef.current = endCapture;
  useEffect(() => () => endCaptureRef.current(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/summary");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not load your payment details.");
      setSummary(data);
      // History is secondary — don't fail the page over it.
      const h = await fetch("/api/payments/transactions").then((r) => r.json()).catch(() => null);
      if (h && !h.error) setHistory(h);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const savePayout = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPayout(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/payments/payout-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountNumber: acct, bankCode: bank }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not verify that account.");
      setNotice(`Payout account saved. Account name: ${data.accountName}.`);
      speak(`Payout account saved. The account name is ${data.accountName}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingPayout(false);
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
        speak(data.message);
        await load();
      } catch (e) {
        // Wrong word or transfer error: say it aloud and keep listening so
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
    try {
      const res = await fetch("/api/payments/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", amount: Number(amount) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not prepare the withdrawal.");
      setArmed({ amount: data.amount, accountName: data.accountName, phrase: data.phrase });
      setConfirmWord("");
      // Aide now waits for the confirm word — spoken aloud, hands-free.
      beginCapture((word) => {
        setConfirmWord(word);
        confirmWith(word);
      });
      speak(`You are sending ${data.amount} naira to ${data.accountName}. To confirm, say the word: ${data.phrase}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancelWithdrawal = () => {
    endCapture();
    setArmed(null);
    setConfirmWord("");
  };

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
      <h1 className="text-4xl font-bold tracking-tight">Payments</h1>
      <p className="mt-2 text-lg text-[var(--ink-soft)]">
        Your balance, your account for receiving pay, and voice-confirmed withdrawals. All numbers come from Monnify, never invented.
      </p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-6 rounded-lg border-2 border-[var(--good)] px-4 py-3 font-bold text-[var(--good)]">
          ✓ {notice}
        </p>
      )}

      {/* Balance */}
      <section aria-label="Balance" className="mt-8 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Confirmed balance</h2>
        <p className="mt-2 text-5xl font-bold tabular-nums">{loading ? "…" : summary ? naira(summary.balance) : "—"}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={load}
            disabled={loading}
            className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-5 py-3 font-bold disabled:opacity-50"
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
          <button
            onClick={() => summary && speak(`Your confirmed balance is ${summary.balance} naira.`)}
            disabled={!summary}
            className="min-h-12 rounded-lg bg-[var(--accent)] px-5 py-3 font-bold text-white disabled:opacity-50"
          >
            Read balance aloud
          </button>
        </div>
      </section>

      {/* Receiving */}
      <section aria-label="Receive money" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Receive money</h2>
        <p className="mt-2 text-lg">Anyone can pay you by bank transfer to your real earnings account:</p>
        <dl className="mt-4 divide-y divide-[var(--line)] border-y border-[var(--line)]">
          <Row label="Account name" value={summary?.name ?? "—"} onCopy={copy} copied={copied} />
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
      <section aria-label="Send money" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Send money (withdraw)</h2>

        {!summary?.payoutAccountName ? (
          <form onSubmit={savePayout} className="mt-4 space-y-4">
            <p className="text-lg">First, save where your money should go. We verify the account name before anything moves.</p>
            <div>
              <label htmlFor="payout-acct" className="block font-bold">
                Account number
              </label>
              <input
                id="payout-acct"
                value={acct}
                onChange={(e) => setAcct(e.target.value)}
                inputMode="numeric"
                pattern="\d{10}"
                required
                className="mt-1 w-full max-w-sm rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
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
                className="mt-1 w-full max-w-sm rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
              >
                {BANKS.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={savingPayout}
              className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white disabled:opacity-50"
            >
              {savingPayout ? "Verifying…" : "Verify & save account"}
            </button>
          </form>
        ) : (
          <>
            <p className="mt-3 text-lg">
              Withdrawals go to <strong>{summary.payoutAccountName}</strong> ({summary.payoutAccount}).
            </p>

            {!armed ? (
              <form onSubmit={prepare} className="mt-4 flex flex-wrap items-end gap-3">
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
                <button type="submit" className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white">
                  Prepare withdrawal
                </button>
              </form>
            ) : (
              <div className="mt-4 rounded-lg p-5" style={{ background: "var(--warn-bg)", color: "var(--warn-ink)" }}>
                <p className="text-lg font-bold">
                  Confirm: send {naira(armed.amount)} to {armed.accountName}?
                </p>
                <p className="mt-2 text-lg">
                  This is your spoken security check — it replaces the SMS code you can’t read. Say the word:{" "}
                  <strong className="text-2xl">{armed.phrase}</strong>
                </p>
                <p aria-live="polite" className="mt-2 font-bold">
                  {moving
                    ? "Confirming…"
                    : capturing && listening && supported
                      ? "Aide is listening for the word — just say it."
                      : "Type the word below to confirm."}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <label htmlFor="confirm-word" className="sr-only">
                    Confirmation word
                  </label>
                  <input
                    id="confirm-word"
                    value={confirmWord}
                    onChange={(e) => setConfirmWord(e.target.value)}
                    placeholder="…or type the word"
                    className="min-h-12 w-56 rounded-lg border-2 border-[var(--warn-ink)] bg-white px-4 py-3 text-lg text-[var(--ink)]"
                  />
                  <button
                    onClick={() => confirmWith(confirmWord)}
                    disabled={moving || !confirmWord.trim()}
                    className="min-h-12 rounded-lg bg-[var(--ink)] px-6 py-3 text-lg font-bold text-[var(--paper)] disabled:opacity-50"
                  >
                    {moving ? "Sending…" : "Confirm & send"}
                  </button>
                  <button
                    onClick={cancelWithdrawal}
                    className="min-h-12 rounded-lg border-2 border-[var(--warn-ink)] px-5 py-3 text-lg font-bold"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Transaction history */}
      <section aria-label="Transaction history" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Transaction history</h2>

        <h3 className="mt-4 text-lg font-bold">Money in</h3>
        {!history || history.inbound.length === 0 ? (
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
    </main>
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
