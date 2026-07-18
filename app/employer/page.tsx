"use client";

import { useCallback, useEffect, useState } from "react";

type Worker = { name: string; accountNumber: string; bankName: string };

export default function Employer() {
  const [worker, setWorker] = useState<Worker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [job, setJob] = useState<{ title: string; employer: string; pay: number }>({
    title: "Audio transcription — 30 min interview",
    employer: "ClearVoice Media",
    pay: 12000,
  });
  const WEBSIM_URL = "https://websim.sdk.monnify.com/?#/bankingapp";
  const naira = (n: number) => "₦" + n.toLocaleString("en-NG");

  useEffect(() => {
    fetch("/api/worker")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setWorker(d)))
      .catch((e) => setError(String(e)));

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const jobId = params.get("jobId");
      if (jobId) {
        fetch("/api/jobs")
          .then((r) => r.json())
          .then((d) => {
            if (d.jobs) {
              const found = d.jobs.find((j: any) => j.id === jobId);
              if (found) {
                setJob({ title: found.title, employer: found.employer, pay: found.pay });
              }
            }
          })
          .catch(() => {});
      }
    }
  }, []);

  const copy = useCallback((label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  return (
    <main className="min-h-screen bg-[#f4f1ea] text-neutral-900 flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <header className="flex items-baseline justify-between border-b-2 border-neutral-900 pb-3">
          <span className="text-xs font-semibold uppercase tracking-[0.25em]">Payout desk</span>
          <span className="text-xs text-neutral-500">{job.employer}</span>
        </header>

        <h1 className="mt-8 text-3xl font-black leading-tight tracking-tight">
          Pay the worker who finished
          <br />
          <span className="italic font-serif font-normal">“{job.title}”</span>
        </h1>

        <div className="mt-8 flex items-end gap-3">
          <span className="text-neutral-500 text-sm mb-1">Amount due</span>
          <span className="text-5xl font-black tabular-nums">{naira(job.pay)}</span>
        </div>

        {error && <p className="mt-8 text-red-700">Couldn’t load the worker’s account: {error}</p>}

        {worker && (
          <section className="mt-10 border border-neutral-300 bg-white">
            <p className="px-5 pt-4 text-xs uppercase tracking-widest text-neutral-500">Send to this account</p>
            <dl className="divide-y divide-neutral-200">
              <Row label="Account name" value={worker.name} onCopy={copy} copied={copied} />
              <Row label="Account number" value={worker.accountNumber} mono onCopy={copy} copied={copied} />
              <Row label="Bank" value={worker.bankName} onCopy={copy} copied={copied} />
            </dl>
          </section>
        )}

        <a
          href={WEBSIM_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex w-full items-center justify-center gap-2 bg-neutral-900 px-6 py-4 text-lg font-bold text-[#f4f1ea] transition-colors hover:bg-neutral-700"
        >
          Open Monnify to send payment →
        </a>

        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          Real sandbox money. Pay from the bank that matches the account above, then the worker
          hears Aide announce the confirmed amount — no screen, no OTP.
        </p>
      </div>
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
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div>
        <dt className="text-xs text-neutral-500">{label}</dt>
        <dd className={`text-lg ${mono ? "font-mono tracking-wide" : "font-medium"}`}>{value}</dd>
      </div>
      <button
        onClick={() => onCopy(label, value)}
        className="shrink-0 rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium hover:border-neutral-900"
      >
        {copied === label ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
