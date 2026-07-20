"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAide } from "../aide";
import { AssessmentPanel } from "./assessment-panel";
import { EmployerGigs } from "./employer-gigs";
import { ExternalJobsSection } from "./external-jobs";
import { naira, type Application, type AssessmentData, type AssessmentResult, type Job } from "./types";

// The jobs screen. Workers see filterable listings, apply, and take
// assessments (AssessmentPanel); employers see their posted gigs and
// applicants (EmployerGigs). External web listings live in
// ExternalJobsSection; the gig-posting dialog in PostGigModal.

// useSearchParams needs a Suspense boundary in the app router.
export default function JobsPage() {
  return (
    <Suspense
      fallback={
        <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
          <p className="text-lg text-[var(--ink-soft)]">Loading jobs…</p>
        </main>
      }
    >
      <JobsPageInner />
    </Suspense>
  );
}

function JobsPageInner() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [apps, setApps] = useState<Application[]>([]);
  const [role, setRole] = useState<"worker" | "employer" | null>(null);
  const [employerName, setEmployerName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<AssessmentData | null>(null);
  const [result, setResult] = useState<AssessmentResult | null>(null);

  const { speak, endCapture } = useAide();

  // Job filters — URL-driven so Aide can fill them ("filter VA jobs paying
  // 12 to 20 thousand") and the worker can adjust the same controls on screen.
  const searchParams = useSearchParams();
  const [fKeyword, setFKeyword] = useState("");
  const [fMin, setFMin] = useState("");
  const [fMax, setFMax] = useState("");
  const [fReq, setFReq] = useState("any");
  useEffect(() => {
    setFKeyword(searchParams.get("keyword") ?? "");
    setFMin(searchParams.get("minPay") ?? "");
    setFMax(searchParams.get("maxPay") ?? "");
    const r = searchParams.get("requiresAssessment");
    setFReq(r === "true" ? "yes" : r === "false" ? "no" : "any");
  }, [searchParams]);

  const visibleJobs = jobs.filter((j) => {
    const kw = fKeyword.trim().toLowerCase();
    if (kw && !j.title.toLowerCase().includes(kw) && !j.skill.toLowerCase().includes(kw)) return false;
    if (fMin && j.pay < Number(fMin)) return false;
    if (fMax && j.pay > Number(fMax)) return false;
    if (fReq === "yes" && !j.requiresAssessment) return false;
    if (fReq === "no" && j.requiresAssessment) return false;
    return true;
  });
  const filtersActive = !!(fKeyword.trim() || fMin || fMax || fReq !== "any");

  // Leaving the page mid-assessment must hand the mic back to Aide.
  const endCaptureRef = useRef(endCapture);
  endCaptureRef.current = endCapture;
  useEffect(() => () => endCaptureRef.current(), []);

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs");
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setApps(data.applications ?? []);
    setRole(data.role ?? "worker");
    setEmployerName(data.employerName ?? "");
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const appFor = (jobId: string) => apps.find((a) => a.jobId === jobId);

  const applyTo = async (job: Job) => {
    setBusyJob(job.id);
    setError(null);
    try {
      const res = await fetch("/api/jobs/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not apply.");
      await load();
      speak(
        job.requiresAssessment
          ? `Applied to ${job.title}. This job needs a short spoken assessment — press start assessment when you are ready.`
          : `Applied to ${job.title}. No assessment is required — you are all set.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyJob(null);
    }
  };

  const startAssessment = async (job: Job) => {
    setBusyJob(job.id);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/jobs/assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.assessmentType) throw new Error(data?.error || "Could not start the assessment.");

      setAssessment({
        job,
        assessmentType: data.assessmentType,
        prompt: data.prompt,
        questions: data.questions,
        timeLimit: data.timeLimit,
        startedAt: data.startedAt,
      });

      let intro = "";
      if (data.timeLimit) {
        const mins = Math.floor(data.timeLimit / 60);
        const secs = data.timeLimit % 60;
        const timeStr =
          mins > 0
            ? `${mins} minute${mins === 1 ? "" : "s"}${secs > 0 ? ` and ${secs} second${secs === 1 ? "" : "s"}` : ""}`
            : `${secs} second${secs === 1 ? "" : "s"}`;
        intro += `You have a time limit of ${timeStr}. `;
      }
      intro +=
        "Before we begin: you can cancel at any time by saying, cancel assessment — but be warned, cancelling permanently locks this job, and you will not be able to apply to it again. ";

      if (data.assessmentType === "mcq") {
        const qCount = data.questions?.length || 0;
        intro += `This is a multiple choice assessment with ${qCount} question${qCount === 1 ? "" : "s"}. `;
        speak(
          intro +
            "I will read the questions and options aloud. Question 1: " +
            data.questions[0].question +
            ". The options are: " +
            data.questions[0].options.map((o: string, idx: number) => `option ${idx + 1}, ${o}`).join(". ") +
            ". Please make your choice.",
        );
      } else {
        intro += `The prompt is: ${data.prompt}. `;
        speak(intro + "Just speak your answer, then press submit.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyJob(null);
    }
  };

  // Aide's voice flow lands here with ?assessment=<jobId> after the agent's
  // start_assessment tool ran — open that job's assessment UI automatically.
  const autoStartedRef = useRef(false);
  const assessmentParam = searchParams.get("assessment");
  useEffect(() => {
    if (!assessmentParam || autoStartedRef.current || jobs.length === 0 || assessment) return;
    const job = jobs.find((j) => j.id === assessmentParam);
    const app = apps.find((a) => a.jobId === assessmentParam);
    if (job && job.requiresAssessment && app && !app.verified && app.status === "applied") {
      autoStartedRef.current = true;
      startAssessment(job);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentParam, jobs, apps]);

  if (role === "employer") {
    return <EmployerGigs jobs={jobs} apps={apps} employerName={employerName} reload={load} />;
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
      <h1 className="text-4xl font-bold tracking-tight">Jobs</h1>
      <p className="mt-2 text-lg text-[var(--ink-soft)]">
        Available gigs. Apply, and if the recruiter requires it, take a short spoken assessment.
      </p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}

      {result && (
        <p
          role="status"
          className="mt-6 rounded-lg px-4 py-3 font-bold"
          style={
            result.verified
              ? { border: "2px solid var(--good)", color: "var(--good)" }
              : { background: "var(--warn-bg)", color: "var(--warn-ink)" }
          }
        >
          {result.verified ? "✓ " : ""}
          {result.message}
        </p>
      )}

      {assessment && (
        <AssessmentPanel assessment={assessment} onResult={setResult} onClose={() => setAssessment(null)} reload={load} />
      )}

      <section id="filters" aria-label="Job filters" className="mt-8 rounded-xl border-2 border-[var(--line)] bg-white p-5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Filter jobs</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Fill these in, or just tell Aide — “show transcription jobs paying twelve to twenty thousand”.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="f-kw" className="block text-sm font-bold">
              Keyword or skill
            </label>
            <input
              id="f-kw"
              value={fKeyword}
              onChange={(e) => setFKeyword(e.target.value)}
              placeholder="e.g. transcription"
              className="mt-1 min-h-12 w-52 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg"
            />
          </div>
          <div>
            <label htmlFor="f-min" className="block text-sm font-bold">
              Min pay (₦)
            </label>
            <input
              id="f-min"
              value={fMin}
              onChange={(e) => setFMin(e.target.value)}
              inputMode="numeric"
              placeholder="12000"
              className="mt-1 min-h-12 w-32 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg"
            />
          </div>
          <div>
            <label htmlFor="f-max" className="block text-sm font-bold">
              Max pay (₦)
            </label>
            <input
              id="f-max"
              value={fMax}
              onChange={(e) => setFMax(e.target.value)}
              inputMode="numeric"
              placeholder="20000"
              className="mt-1 min-h-12 w-32 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg"
            />
          </div>
          <div>
            <label htmlFor="f-req" className="block text-sm font-bold">
              Assessment
            </label>
            <select
              id="f-req"
              value={fReq}
              onChange={(e) => setFReq(e.target.value)}
              className="mt-1 min-h-12 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg"
            >
              <option value="any">Any</option>
              <option value="yes">Required</option>
              <option value="no">Not required</option>
            </select>
          </div>
          {filtersActive && (
            <button
              onClick={() => {
                setFKeyword("");
                setFMin("");
                setFMax("");
                setFReq("any");
              }}
              className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-4 font-bold"
            >
              Clear filters
            </button>
          )}
        </div>
        {filtersActive && (
          <p role="status" className="mt-3 font-bold text-[var(--accent)]">
            Showing {visibleJobs.length} of {jobs.length} jobs
          </p>
        )}
      </section>

      <ul id="listings" className="mt-8 space-y-5">
        {visibleJobs.map((job) => {
          const app = appFor(job.id);
          return (
            <li key={job.id}>
              <article aria-label={job.title} className="rounded-xl border-2 border-[var(--line)] bg-white p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-2xl font-bold">{job.title}</h2>
                  <p className="text-2xl font-bold tabular-nums">{naira(job.pay)}</p>
                </div>
                <p className="mt-1 text-[var(--ink-soft)]">
                  Posted by: <strong className="text-[var(--ink)] font-bold">{job.employer}</strong> · Skill: {job.skill}
                </p>
                <p className="mt-3 text-lg">{job.task}</p>
                <p className="mt-2 font-bold text-[var(--ink-soft)]">
                  {job.requiresAssessment ? (
                    <>
                      Recruiter requires a <strong>{job.assessmentType === "mcq" ? "multiple choice" : "spoken oral"}</strong> assessment
                      {job.timeLimit ? ` (${Math.floor(job.timeLimit / 60)}m time limit)` : ""}
                    </>
                  ) : (
                    "No assessment required"
                  )}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {!app && (
                    <button
                      onClick={() => applyTo(job)}
                      disabled={busyJob === job.id}
                      className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white disabled:opacity-50"
                    >
                      {busyJob === job.id ? "Applying…" : "Apply"}
                    </button>
                  )}
                  {app && (
                    <span
                      className="rounded-full border-2 px-4 py-1 font-bold"
                      style={
                        app.verified
                          ? { borderColor: "var(--good)", color: "var(--good)" }
                          : { borderColor: "var(--ink-soft)", color: "var(--ink-soft)" }
                      }
                    >
                      {app.verified ? "✓ Skill verified" : app.status === "cancelled" ? "Locked — assessment cancelled" : `Applied — ${app.status}`}
                    </span>
                  )}
                  {app && !app.verified && app.status !== "cancelled" && job.requiresAssessment && (
                    <button
                      onClick={() => startAssessment(job)}
                      disabled={busyJob === job.id}
                      className="min-h-12 rounded-lg border-2 border-[var(--accent)] px-6 py-3 text-lg font-bold text-[var(--accent)] disabled:opacity-50"
                    >
                      Start spoken assessment
                    </button>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {jobs.length === 0 && !error && <p className="mt-8 text-lg text-[var(--ink-soft)]">Loading jobs…</p>}
      {jobs.length > 0 && visibleJobs.length === 0 && (
        <p className="mt-8 text-lg text-[var(--ink-soft)]">No jobs match these filters — clear them or ask Aide to broaden the search.</p>
      )}

      <ExternalJobsSection />
    </main>
  );
}
