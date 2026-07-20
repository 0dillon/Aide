"use client";

import { useCallback, useEffect, useState } from "react";
import { useAide } from "../aide";

// External jobs — real listings Aide found on the open web, self-contained:
// this section owns its own data and scanning state.

type ExtJob = { id: string; title: string; company: string; url: string; skill: string; source: string };
type ExtApp = { externalJobId: string; title: string; company: string; url: string; at: number };

export function ExternalJobsSection() {
  const { speak } = useAide();
  const [extJobs, setExtJobs] = useState<ExtJob[]>([]);
  const [extApps, setExtApps] = useState<ExtApp[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs/external");
    const data = await res.json().catch(() => null);
    setExtJobs(data?.jobs ?? []);
    setExtApps(data?.applications ?? []);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not scan for external jobs.");
      setExtJobs(data.jobs ?? []);
      speak(
        data.jobs?.length
          ? `I found ${data.jobs.length} listings on the web matching your skills. They are under external jobs.`
          : "I could not find external listings matching your skills right now.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const track = async (id: string, title: string) => {
    const res = await fetch("/api/jobs/external", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "track", id }),
    });
    if (res.ok) {
      await load();
      speak(`Tracking your application to ${title}.`);
    }
  };

  return (
    <section id="external" aria-label="External jobs" className="mt-10 rounded-xl border-2 border-[var(--line)] bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">External jobs</h2>
        <button
          onClick={scan}
          disabled={scanning}
          className="min-h-12 rounded-lg bg-[var(--accent)] px-5 py-3 font-bold text-white disabled:opacity-50"
        >
          {scanning ? "Scanning the web…" : "Scan the web for jobs matching my skills"}
        </button>
      </div>
      <p className="mt-1 text-[var(--ink-soft)]">
        Real remote listings from the open web, matched to your skills. Aide opens the listing and tracks your application — or
        just say “find me jobs on the web”.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border-2 border-[var(--alert)] px-4 py-2 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}

      {extJobs.length === 0 ? (
        <p className="mt-4 text-lg text-[var(--ink-soft)]">No external listings yet — run a scan.</p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--line)]">
          {extJobs.map((j) => {
            const tracked = extApps.some((a) => a.externalJobId === j.id);
            return (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-lg font-bold">{j.title}</p>
                  <p className="text-sm text-[var(--ink-soft)]">
                    {j.company} · matched skill: {j.skill} · via {j.source}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={j.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-10 inline-flex items-center rounded-lg border-2 border-[var(--ink)] px-4 py-1 font-bold"
                  >
                    Open listing
                  </a>
                  {tracked ? (
                    <span className="rounded-full border-2 border-[var(--good)] px-3 py-0.5 font-bold text-[var(--good)]">✓ Tracked</span>
                  ) : (
                    <button
                      onClick={() => track(j.id, j.title)}
                      className="min-h-10 rounded-lg border-2 border-[var(--accent)] px-4 py-1 font-bold text-[var(--accent)]"
                    >
                      I applied — track it
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {extApps.length > 0 && (
        <div className="mt-6 border-t-2 border-[var(--line)] pt-4">
          <h3 className="text-lg font-bold">My external submissions</h3>
          <ul className="mt-2 space-y-1">
            {extApps.map((a) => (
              <li key={a.externalJobId} className="text-[var(--ink-soft)]">
                {a.title} at {a.company} — {new Date(a.at).toLocaleDateString("en-NG", { day: "numeric", month: "short" })} ·{" "}
                <span className="font-bold text-[var(--good)]">✓ tracked</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
