"use client";

import { useState } from "react";
import { useAide } from "../aide";
import { MessageThread } from "./message-thread";
import { PostGigModal } from "./post-gig-modal";
import { naira, type Application, type Job } from "./types";

// The employer's view of the jobs screen: their posted gigs, applicants with
// assessment outcomes, and the hire / decline / mark-paid actions.

export function EmployerGigs({
  jobs,
  apps,
  employerName,
  reload,
}: {
  jobs: Job[];
  apps: Application[];
  employerName: string;
  reload: () => Promise<void> | void;
}) {
  const { speak } = useAide();
  const [showPost, setShowPost] = useState(false);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changeStatus = async (jobId: string, action: "hire" | "reject" | "pay") => {
    setBusyJob(jobId);
    setError(null);
    try {
      const res = await fetch("/api/jobs/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Could not ${action} worker.`);
      await reload();
      speak(
        action === "hire"
          ? "Worker has been hired. Aide is letting them know now."
          : action === "reject"
            ? "Applicant declined. Aide is letting them know kindly."
            : "Worker has been marked as paid.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyJob(null);
    }
  };

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Your Posted Gigs</h1>
          <p className="mt-2 text-lg text-[var(--ink-soft)]">
            Manage job postings for <strong className="text-[var(--ink)]">{employerName || "Employer"}</strong>. Track applicant
            assessments, hire workers, and initiate payouts.
          </p>
        </div>
        <button onClick={() => setShowPost(true)} className="min-h-12 cursor-pointer rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white">
          + Post New Gig
        </button>
      </div>
      <p className="mt-2 text-[var(--ink-soft)]">
        Prefer to talk? Just tell Aide <em>“post a new gig”</em> and it will collect everything — pay, assessment question and all — by
        voice.
      </p>

      {showPost && (
        <PostGigModal
          onClose={() => setShowPost(false)}
          onPosted={async (title) => {
            setShowPost(false);
            await reload();
            speak(`Your gig, ${title}, is now live.`);
          }}
        />
      )}

      {error && (
        <p role="alert" className="mt-6 rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}

      <ul id="listings" className="mt-8 space-y-5">
        {jobs.map((job) => {
          const jobApps = apps.filter((a) => a.jobId === job.id);
          return (
            <li key={job.id}>
              <article aria-label={job.title} className="rounded-xl border-2 border-[var(--line)] bg-white p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-2xl font-bold">{job.title}</h2>
                  <p className="text-2xl font-bold tabular-nums">{naira(job.pay)}</p>
                </div>
                <p className="mt-1 text-[var(--ink-soft)]">
                  Skill Required: {job.skill}
                  {job.requiresAssessment && (
                    <>
                      {" "}
                      · Assessment: <strong>{job.assessmentType === "mcq" ? "Multiple Choice" : "Oral Spoken"}</strong>
                      {job.timeLimit ? ` (${Math.floor(job.timeLimit / 60)}m)` : ""}
                    </>
                  )}
                </p>
                <p className="mt-3 text-lg">{job.task}</p>

                <div className="mt-6 border-t-2 border-[var(--line)] pt-4">
                  <h3 className="text-lg font-bold">Applications ({jobApps.length})</h3>
                  {jobApps.length === 0 ? (
                    <p className="mt-2 text-[var(--ink-soft)]">No applications yet.</p>
                  ) : (
                    <ul className="mt-3 space-y-4">
                      {jobApps.map((app: any) => (
                        <li key={app.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-lg font-bold">{app.workerName || "Worker"}</p>
                              <p className="text-sm text-[var(--ink-soft)]">
                                Status: <span className="font-bold">{app.status}</span>
                                {app.assessmentResult && (
                                  <span className="ml-2 rounded-full border border-[var(--accent)] px-2 py-0.5 font-bold text-[var(--accent)]">
                                    {app.assessmentResult}
                                  </span>
                                )}
                              </p>
                              {app.workerSkills?.length > 0 && (
                                <p className="mt-1 text-sm text-[var(--ink-soft)]">Skills: {app.workerSkills.join(", ")}</p>
                              )}
                              {app.workerBio && <p className="mt-1 max-w-md text-sm italic text-[var(--ink-soft)]">“{app.workerBio}”</p>}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              {app.status === "applied" && <span className="text-[var(--ink-soft)] font-medium">Awaiting assessment</span>}

                              {app.status === "assessed" && (
                                <>
                                  <span className="rounded-full border-2 border-[var(--good)] px-3 py-0.5 text-sm font-bold text-[var(--good)]">
                                    ✓ Skill Verified
                                  </span>
                                  <button
                                    onClick={() => changeStatus(job.id, "hire")}
                                    disabled={busyJob === job.id}
                                    className="min-h-10 cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Hire Worker
                                  </button>
                                  <button
                                    onClick={() => changeStatus(job.id, "reject")}
                                    disabled={busyJob === job.id}
                                    className="min-h-10 cursor-pointer rounded-lg border-2 border-[var(--alert)] px-4 py-2 text-sm font-bold text-[var(--alert)] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Decline
                                  </button>
                                </>
                              )}

                              {app.status === "rejected" && (
                                <span className="rounded-full border-2 border-[var(--ink-soft)] px-3 py-0.5 text-sm font-bold text-[var(--ink-soft)]">
                                  Declined
                                </span>
                              )}

                              {app.status === "hired" && (
                                <>
                                  <span className="rounded-full border-2 border-[var(--accent)] px-3 py-0.5 text-sm font-bold text-[var(--accent)]">
                                    Hired
                                  </span>
                                  <a
                                    href={`/employer?jobId=${job.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg border-2 border-[var(--ink)] px-4 py-2 text-sm font-bold text-[var(--ink)]"
                                  >
                                    Send Payout (₦)
                                  </a>
                                  <button
                                    onClick={() => changeStatus(job.id, "pay")}
                                    disabled={busyJob === job.id}
                                    className="min-h-10 cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Mark as Paid
                                  </button>
                                </>
                              )}

                              {app.status === "paid" && (
                                <span className="rounded-full border-2 border-[var(--good)] px-3 py-0.5 text-sm font-bold text-[var(--good)]">
                                  ✓ Paid & Closed
                                </span>
                              )}
                            </div>
                          </div>

                          {/* The onboarding channel unlocks the moment the
                              worker is hired — this is where the employer hands
                              over directives, credentials, and next steps. */}
                          {(app.status === "hired" || app.status === "paid") && (
                            <MessageThread jobId={job.id} role="employer" />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {jobs.length === 0 && !error && <p className="mt-8 text-lg text-[var(--ink-soft)]">No posted jobs found.</p>}
    </main>
  );
}
