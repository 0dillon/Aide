"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAide } from "../aide";

type Job = {
  id: string;
  title: string;
  task: string;
  skill: string;
  pay: number;
  employer: string;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  assessmentQuestion?: string;
  mcqQuestions?: { question: string; options: string[] }[];
  timeLimit?: number;
};
type Application = { id: string; jobId: string; status: string; verified: boolean };

const naira = (n: number) => "₦" + n.toLocaleString("en-NG");

// useSearchParams needs a Suspense boundary in the app router.
export default function JobsPage() {
  return (
    <Suspense fallback={<main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8"><p className="text-lg text-[var(--ink-soft)]">Loading jobs…</p></main>}>
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
  const [assessment, setAssessment] = useState<{
    job: Job;
    assessmentType: "oral" | "mcq";
    prompt?: string;
    questions?: { question: string; options: string[] }[];
    timeLimit?: number;
    startedAt?: number;
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [mcqAnswers, setMcqAnswers] = useState<number[]>([]);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [result, setResult] = useState<{ verified: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const [extJobs, setExtJobs] = useState<{ id: string; title: string; company: string; url: string; skill: string; source: string }[]>([]);
  const [extApps, setExtApps] = useState<{ externalJobId: string; title: string; company: string; url: string; at: number }[]>([]);
  const [scanning, setScanning] = useState(false);

  const { listening, capturing, interim, supported, speak, beginCapture, endCapture } = useAide();

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

  const loadExternal = useCallback(async () => {
    const res = await fetch("/api/jobs/external");
    const data = await res.json().catch(() => null);
    setExtJobs(data?.jobs ?? []);
    setExtApps(data?.applications ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
    loadExternal().catch(() => {});
  }, [load, loadExternal]);

  const scanExternal = async () => {
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

  const trackExternal = async (id: string, title: string) => {
    const res = await fetch("/api/jobs/external", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "track", id }),
    });
    if (res.ok) {
      await loadExternal();
      speak(`Tracking your application to ${title}.`);
    }
  };

  const appFor = (jobId: string) => apps.find((a) => a.jobId === jobId);

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
      await load();
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

  // Timer countdown and expiration handling
  useEffect(() => {
    if (!assessment || !assessment.timeLimit) {
      setTimeLeft(null);
      return;
    }
    const elapsed = Math.floor((Date.now() - (assessment.startedAt || Date.now())) / 1000);
    const initialLeft = Math.max(0, assessment.timeLimit - elapsed);
    setTimeLeft(initialLeft);

    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(interval);
          handleTimeout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [assessment]);

  const handleTimeout = () => {
    speak("Time is up. Your assessment time has expired.");
    setResult({ verified: false, message: "Time limit exceeded. Your assessment has timed out." });
    closeAssessment();
    load();
  };

  // Spoken countdown alerts as the limit approaches. Skipped when the alert
  // equals the full limit (no point announcing "one minute left" at start).
  const lastAlertRef = useRef<number | null>(null);
  useEffect(() => {
    lastAlertRef.current = null; // fresh assessment, fresh alerts
  }, [assessment]);
  useEffect(() => {
    if (timeLeft === null || !assessment) return;
    if (timeLeft === assessment.timeLimit) return;
    if ((timeLeft === 60 || timeLeft === 30 || timeLeft === 10) && lastAlertRef.current !== timeLeft) {
      lastAlertRef.current = timeLeft;
      speak(timeLeft === 60 ? "One minute left." : timeLeft === 30 ? "Thirty seconds left." : "Ten seconds left.");
    }
  }, [timeLeft, assessment, speak]);

  const startAssessment = async (job: Job) => {
    setBusyJob(job.id);
    setError(null);
    setResult(null);
    setAnswer("");
    setMcqAnswers([]);
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
        const timeStr = mins > 0 
          ? `${mins} minute${mins === 1 ? "" : "s"}${secs > 0 ? ` and ${secs} second${secs === 1 ? "" : "s"}` : ""}`
          : `${secs} second${secs === 1 ? "" : "s"}`;
        intro += `You have a time limit of ${timeStr}. `;
      }

      if (data.assessmentType === "mcq") {
        const qCount = data.questions?.length || 0;
        intro += `This is a multiple choice assessment with ${qCount} question${qCount === 1 ? "" : "s"}. `;
        setMcqAnswers(new Array(qCount).fill(-1));
        
        speak(
          intro + 
          "I will read the questions and options aloud. Question 1: " + 
          data.questions[0].question + 
          ". The options are: " + 
          data.questions[0].options.map((o: string, idx: number) => `option ${idx + 1}, ${o}`).join(". ") + 
          ". Please make your choice."
        );
      } else {
        intro += `The prompt is: ${data.prompt}. `;
        beginCapture((t) => setAnswer((prev) => (prev ? prev + " " : "") + t));
        speak(intro + "Just speak your answer, then press submit.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyJob(null);
    }
  };

  const closeAssessment = () => {
    endCapture();
    setAssessment(null);
  };

  const readMcqQuestionAloud = (qIdx: number) => {
    if (!assessment || !assessment.questions || !assessment.questions[qIdx]) return;
    const q = assessment.questions[qIdx];
    speak(`Question ${qIdx + 1}: ${q.question}. The options are: ${q.options.map((o, idx) => `option ${idx + 1}, ${o}`).join(". ")}`);
  };

  const submitAnswer = async () => {
    if (!assessment) return;
    
    if (assessment.assessmentType === "mcq") {
      const unanswered = mcqAnswers.findIndex((ans) => ans === -1);
      if (unanswered !== -1) {
        setError(`Please answer question ${unanswered + 1} before submitting.`);
        return;
      }
    } else {
      if (!answer.trim()) {
        setError("Please speak or type an answer before submitting.");
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload: any = { jobId: assessment.job.id };
      if (assessment.assessmentType === "mcq") {
        payload.answers = mcqAnswers;
      } else {
        payload.answer = answer.trim();
      }

      const res = await fetch("/api/jobs/assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not submit the answer.");
      setResult({ verified: data.verified, message: data.message });
      speak(data.message);
      if (data.verified) closeAssessment();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (role === "employer") {
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">Your Posted Gigs</h1>
            <p className="mt-2 text-lg text-[var(--ink-soft)]">
              Manage job postings for <strong className="text-[var(--ink)]">{employerName || "Employer"}</strong>. Track applicant assessments, hire workers, and initiate payouts.
            </p>
          </div>
          <button
            onClick={() => setShowPost(true)}
            className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white"
          >
            + Post New Gig
          </button>
        </div>
        <p className="mt-2 text-[var(--ink-soft)]">
          Prefer to talk? Just tell Aide <em>“post a new gig”</em> and it will collect everything — pay, assessment question and all — by voice.
        </p>

        {showPost && (
          <PostGigModal
            onClose={() => setShowPost(false)}
            onPosted={async (title) => {
              setShowPost(false);
              await load();
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
                        {" "}· Assessment: <strong>{job.assessmentType === "mcq" ? "Multiple Choice" : "Oral Spoken"}</strong>
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
                                {app.workerBio && (
                                  <p className="mt-1 max-w-md text-sm italic text-[var(--ink-soft)]">“{app.workerBio}”</p>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-3">
                                {app.status === "applied" && (
                                  <span className="text-[var(--ink-soft)] font-medium">Awaiting assessment</span>
                                )}

                                {app.status === "assessed" && (
                                  <>
                                    <span className="rounded-full border-2 border-[var(--good)] px-3 py-0.5 text-sm font-bold text-[var(--good)]">
                                      ✓ Skill Verified
                                    </span>
                                    <button
                                      onClick={() => changeStatus(job.id, "hire")}
                                      disabled={busyJob === job.id}
                                      className="min-h-10 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                                    >
                                      Hire Worker
                                    </button>
                                    <button
                                      onClick={() => changeStatus(job.id, "reject")}
                                      disabled={busyJob === job.id}
                                      className="min-h-10 rounded-lg border-2 border-[var(--alert)] px-4 py-2 text-sm font-bold text-[var(--alert)] disabled:opacity-50"
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
                                      className="inline-flex min-h-10 items-center justify-center rounded-lg border-2 border-[var(--ink)] px-4 py-2 text-sm font-bold text-[var(--ink)]"
                                    >
                                      Send Payout (₦)
                                    </a>
                                    <button
                                      onClick={() => changeStatus(job.id, "pay")}
                                      disabled={busyJob === job.id}
                                      className="min-h-10 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
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
        <section aria-label="Assessment" className="mt-8 rounded-xl border-4 border-[var(--accent)] bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-[var(--line)] pb-4">
            <h2 className="text-2xl font-bold">
              {assessment.assessmentType === "mcq" ? "Multiple Choice" : "Spoken Oral"} Assessment — {assessment.job.title}
            </h2>
            {timeLeft !== null && (
              // Prominent countdown once time gets close; the ticking number is
              // aria-live "off" — the spoken 60s/30s/10s alerts carry it to
              // screen-reader and voice users without per-second spam.
              <div
                role="timer"
                className={
                  timeLeft <= 30
                    ? "rounded-full px-5 py-2 text-2xl font-bold text-white"
                    : "rounded-full bg-[var(--warn-bg)] px-4 py-1 text-lg font-bold text-[var(--warn-ink)]"
                }
                style={timeLeft <= 30 ? { background: "var(--alert)" } : undefined}
              >
                Time left: {Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, "0")}
              </div>
            )}
          </div>

          {assessment.assessmentType === "mcq" ? (
            <div className="mt-6 space-y-6">
              {assessment.questions?.map((q, qIdx) => (
                <fieldset key={qIdx} className="rounded-lg border-2 border-[var(--line)] p-5 bg-[var(--paper)]">
                  <legend className="text-xl font-bold px-2 bg-white rounded border border-[var(--line)]">
                    Question {qIdx + 1}
                  </legend>
                  <p className="text-lg font-bold mt-2">{q.question}</p>
                  
                  <div className="mt-4 space-y-3">
                    {q.options.map((opt, oIdx) => {
                      const id = `q-${qIdx}-opt-${oIdx}`;
                      const isSelected = mcqAnswers[qIdx] === oIdx;
                      return (
                        <div key={oIdx} className="flex items-center gap-3">
                          <input
                            id={id}
                            type="radio"
                            name={`question-${qIdx}`}
                            checked={isSelected}
                            onChange={() => {
                              setMcqAnswers((prev) => {
                                const next = [...prev];
                                next[qIdx] = oIdx;
                                return next;
                              });
                            }}
                            className="h-6 w-6 accent-[var(--accent)]"
                          />
                          <label htmlFor={id} className="text-lg font-medium select-none cursor-pointer">
                            Option {oIdx + 1}: {opt}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => readMcqQuestionAloud(qIdx)}
                      className="min-h-10 rounded-lg border-2 border-[var(--ink-soft)] px-4 py-1 text-sm font-bold text-[var(--ink-soft)] hover:border-[var(--ink)]"
                    >
                      Read Question Aloud
                    </button>
                  </div>
                </fieldset>
              ))}
            </div>
          ) : (
            <div className="mt-6">
              <p className="text-lg">{assessment.prompt}</p>

              <p className="mt-4 font-bold text-[var(--accent)]">
                {capturing && listening
                  ? "Aide is listening — just speak your answer."
                  : "Aide is writing down what you say."}
              </p>
              {!supported && (
                <p className="mt-2 text-[var(--alert)]">No speech recognition in this browser — type your answer below.</p>
              )}
              {interim && <p className="mt-3 text-lg italic text-[var(--ink-soft)]">“{interim}”</p>}

              <div className="mt-4">
                <button
                  onClick={() => speak(assessment.prompt || "")}
                  className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-5 py-3 text-lg font-bold"
                >
                  Hear the question again
                </button>
              </div>

              <label htmlFor="assessment-answer" className="mt-5 block font-bold">
                Your answer (spoken words appear here — you can edit them)
              </label>
              <textarea
                id="assessment-answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={4}
                className="mt-2 w-full rounded-lg border-2 border-[var(--line)] bg-white p-4 text-lg"
              />
            </div>
          )}

          <div className="mt-6 flex gap-3 border-t-2 border-[var(--line)] pt-4">
            <button
              onClick={submitAnswer}
              disabled={submitting}
              className="min-h-12 rounded-lg bg-[var(--ink)] px-6 py-3 text-lg font-bold text-[var(--paper)] disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Submit assessment"}
            </button>
            <button onClick={closeAssessment} className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-6 py-3 text-lg font-bold">
              Cancel
            </button>
          </div>
        </section>
      )}

      <section id="filters" aria-label="Job filters" className="mt-8 rounded-xl border-2 border-[var(--line)] bg-white p-5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Filter jobs</h2>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">Fill these in, or just tell Aide — “show transcription jobs paying twelve to twenty thousand”.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="f-kw" className="block text-sm font-bold">Keyword or skill</label>
            <input id="f-kw" value={fKeyword} onChange={(e) => setFKeyword(e.target.value)} placeholder="e.g. transcription"
              className="mt-1 min-h-12 w-52 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg" />
          </div>
          <div>
            <label htmlFor="f-min" className="block text-sm font-bold">Min pay (₦)</label>
            <input id="f-min" value={fMin} onChange={(e) => setFMin(e.target.value)} inputMode="numeric" placeholder="12000"
              className="mt-1 min-h-12 w-32 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg" />
          </div>
          <div>
            <label htmlFor="f-max" className="block text-sm font-bold">Max pay (₦)</label>
            <input id="f-max" value={fMax} onChange={(e) => setFMax(e.target.value)} inputMode="numeric" placeholder="20000"
              className="mt-1 min-h-12 w-32 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg" />
          </div>
          <div>
            <label htmlFor="f-req" className="block text-sm font-bold">Assessment</label>
            <select id="f-req" value={fReq} onChange={(e) => setFReq(e.target.value)}
              className="mt-1 min-h-12 rounded-lg border-2 border-[var(--line)] bg-white px-3 text-lg">
              <option value="any">Any</option>
              <option value="yes">Required</option>
              <option value="no">Not required</option>
            </select>
          </div>
          {filtersActive && (
            <button onClick={() => { setFKeyword(""); setFMin(""); setFMax(""); setFReq("any"); }}
              className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-4 font-bold">
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
                      Recruiter requires a{" "}
                      <strong>{job.assessmentType === "mcq" ? "multiple choice" : "spoken oral"}</strong> assessment
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
                      {app.verified ? "✓ Skill verified" : `Applied — ${app.status}`}
                    </span>
                  )}
                  {app && !app.verified && job.requiresAssessment && (
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

      {/* External jobs — real listings Aide found on the open web */}
      <section id="external" aria-label="External jobs" className="mt-10 rounded-xl border-2 border-[var(--line)] bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">External jobs</h2>
          <button
            onClick={scanExternal}
            disabled={scanning}
            className="min-h-12 rounded-lg bg-[var(--accent)] px-5 py-3 font-bold text-white disabled:opacity-50"
          >
            {scanning ? "Scanning the web…" : "Scan the web for jobs matching my skills"}
          </button>
        </div>
        <p className="mt-1 text-[var(--ink-soft)]">
          Real remote listings from the open web, matched to your skills. Aide opens the listing and tracks your
          application — or just say “find me jobs on the web”.
        </p>

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
                      <span className="rounded-full border-2 border-[var(--good)] px-3 py-0.5 font-bold text-[var(--good)]">
                        ✓ Tracked
                      </span>
                    ) : (
                      <button
                        onClick={() => trackExternal(j.id, j.title)}
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
                  {a.title} at {a.company} —{" "}
                  {new Date(a.at).toLocaleDateString("en-NG", { day: "numeric", month: "short" })} ·{" "}
                  <span className="font-bold text-[var(--good)]">✓ tracked</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

// The screen path for posting a gig. The voice path is Aide's post_gig tool —
// both call the same /api/jobs/post → postJob code. The assessment question
// can also be dictated right here, borrowing Aide's mic.
const TIME_OPTIONS = [
  { value: "none", label: "No limit" },
  { value: "60", label: "1 minute" },
  { value: "120", label: "2 minutes" },
  { value: "300", label: "5 minutes" },
  { value: "600", label: "10 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
];

function PostGigModal({ onClose, onPosted }: { onClose: () => void; onPosted: (title: string) => void }) {
  const { supported, listening, capturing, interim, beginCapture, endCapture } = useAide();
  const [title, setTitle] = useState("");
  const [skill, setSkill] = useState("");
  const [pay, setPay] = useState("");
  const [requires, setRequires] = useState(true);
  const [assessmentType, setAssessmentType] = useState<"oral" | "mcq">("oral");
  const [timeLimitOpt, setTimeLimitOpt] = useState("none");
  const [question, setQuestion] = useState("");
  const [mcqQuestions, setMcqQuestions] = useState<Array<{ question: string; options: string[]; correctIndex: number }>>([
    { question: "", options: ["", "", "", ""], correctIndex: 0 }
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whatever happens to this modal, the mic goes back to Aide.
  const endCaptureRef = useRef(endCapture);
  endCaptureRef.current = endCapture;
  useEffect(() => () => endCaptureRef.current(), []);

  // Escape closes; Tab is trapped inside the dialog (screen-reader and
  // keyboard users must not fall through into the page behind); focus returns
  // to whatever opened the modal when it closes.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")].filter(
        (n) => !n.hasAttribute("disabled"),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const toggleDictation = () => {
    if (capturing) endCapture();
    else beginCapture((t) => setQuestion((prev) => (prev ? prev + " " : "") + t));
  };

  const updateQuestion = (qIdx: number, text: string) => {
    setMcqQuestions((prev) => {
      const next = [...prev];
      next[qIdx] = { ...next[qIdx], question: text };
      return next;
    });
  };

  const updateOption = (qIdx: number, oIdx: number, text: string) => {
    setMcqQuestions((prev) => {
      const next = [...prev];
      const opts = [...next[qIdx].options];
      opts[oIdx] = text;
      next[qIdx] = { ...next[qIdx], options: opts };
      return next;
    });
  };

  const setCorrect = (qIdx: number, oIdx: number) => {
    setMcqQuestions((prev) => {
      const next = [...prev];
      next[qIdx] = { ...next[qIdx], correctIndex: oIdx };
      return next;
    });
  };

  const addQuestion = () => {
    if (mcqQuestions.length >= 10) return;
    setMcqQuestions((prev) => [
      ...prev,
      { question: "", options: ["", "", "", ""], correctIndex: 0 }
    ]);
  };

  const removeQuestion = (qIdx: number) => {
    if (mcqQuestions.length <= 1) return;
    setMcqQuestions((prev) => prev.filter((_, idx) => idx !== qIdx));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // Client side validation for MCQ
    if (requires && assessmentType === "mcq") {
      for (let i = 0; i < mcqQuestions.length; i++) {
        const q = mcqQuestions[i];
        if (!q.question.trim()) {
          setError(`Question ${i + 1} has no question text.`);
          setBusy(false);
          return;
        }
        const filled = q.options.filter((o) => o.trim() !== "");
        if (filled.length < 2) {
          setError(`Question ${i + 1} must have at least 2 non-empty options.`);
          setBusy(false);
          return;
        }
        if (q.correctIndex >= filled.length) {
          setError(`Question ${i + 1} has an invalid correct option selected.`);
          setBusy(false);
          return;
        }
      }
    }

    try {
      const timeLimit = timeLimitOpt === "none" ? undefined : Number(timeLimitOpt);
      const sanitizedMcq = requires && assessmentType === "mcq"
        ? mcqQuestions.map((q) => {
            const filled = q.options.filter((o) => o.trim() !== "");
            return {
              question: q.question.trim(),
              options: filled.map((o) => o.trim()),
              correctIndex: q.correctIndex >= filled.length ? 0 : q.correctIndex,
            };
          })
        : undefined;

      const res = await fetch("/api/jobs/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          skill,
          pay: Number(pay),
          requiresAssessment: requires,
          assessmentType: requires ? assessmentType : undefined,
          assessmentQuestion: requires && assessmentType === "oral" ? question : undefined,
          mcqQuestions: sanitizedMcq,
          timeLimit,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not post the gig.");
      endCapture();
      onPosted(data.job.title);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Post a new gig"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border-4 border-[var(--accent)] bg-[var(--paper)] p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-2xl font-bold">Post a new gig</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="min-h-10 rounded-lg border-2 border-[var(--ink)] px-3 py-1 font-bold"
          >
            ✕ Close
          </button>
        </div>
        <p className="mt-1 text-[var(--ink-soft)]">
          Or close this and simply tell Aide <em>“post a new gig”</em>.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border-2 border-[var(--alert)] px-4 py-2 font-bold text-[var(--alert)]">
            Error: {error}
          </p>
        )}

        <form onSubmit={submit} className="mt-5 space-y-5">
          <div>
            <label htmlFor="pg-title" className="block font-bold">
              Gig title
            </label>
            <input
              id="pg-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
              placeholder="e.g. Transcribe a 20 minute podcast"
              className="mt-1 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="grow">
              <label htmlFor="pg-skill" className="block font-bold">
                Gig type / skill
              </label>
              <input
                id="pg-skill"
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
                required
                placeholder="e.g. transcription"
                className="mt-1 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
              />
            </div>
            <div>
              <label htmlFor="pg-pay" className="block font-bold">
                Pay (₦)
              </label>
              <input
                id="pg-pay"
                value={pay}
                onChange={(e) => setPay(e.target.value)}
                inputMode="numeric"
                required
                placeholder="12000"
                className="mt-1 w-40 rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              id="pg-requires"
              type="checkbox"
              role="switch"
              checked={requires}
              onChange={(e) => setRequires(e.target.checked)}
              className="h-6 w-6 accent-[var(--accent)]"
            />
            <label htmlFor="pg-requires" className="text-lg font-bold">
              Requires assessment?
            </label>
          </div>

          {requires && (
            <div className="space-y-5 border-l-4 border-[var(--accent)] pl-4">
              {/* Assessment Type */}
              <div>
                <span className="block font-bold text-lg">Assessment Type</span>
                <div className="mt-2 flex gap-4">
                  <label className="flex items-center gap-2 text-lg cursor-pointer">
                    <input
                      type="radio"
                      name="assessmentType"
                      checked={assessmentType === "oral"}
                      onChange={() => setAssessmentType("oral")}
                      className="h-5 w-5 accent-[var(--accent)]"
                    />
                    Oral Spoken Prompt
                  </label>
                  <label className="flex items-center gap-2 text-lg cursor-pointer">
                    <input
                      type="radio"
                      name="assessmentType"
                      checked={assessmentType === "mcq"}
                      onChange={() => setAssessmentType("mcq")}
                      className="h-5 w-5 accent-[var(--accent)]"
                    />
                    Multiple Choice (MCQ)
                  </label>
                </div>
              </div>

              {/* Time Limit */}
              <div>
                <label htmlFor="pg-time-limit" className="block font-bold">
                  Time Limit
                </label>
                <select
                  id="pg-time-limit"
                  value={timeLimitOpt}
                  onChange={(e) => setTimeLimitOpt(e.target.value)}
                  className="mt-1 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
                >
                  {TIME_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Oral Assessment Field */}
              {assessmentType === "oral" ? (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="pg-question" className="block font-bold">
                      Oral Assessment Question <span className="font-normal text-[var(--ink-soft)]">(asked aloud)</span>
                    </label>
                    {supported && (
                      <button
                        type="button"
                        onClick={toggleDictation}
                        className="min-h-10 rounded-lg px-4 py-2 font-bold text-white"
                        style={{ background: capturing ? "var(--alert)" : "var(--accent)" }}
                      >
                        {capturing ? (listening ? "Listening… tap to stop" : "Stop dictating") : "Dictate by voice"}
                      </button>
                    )}
                  </div>
                  {capturing && interim && <p className="mt-2 italic text-[var(--ink-soft)]">“{interim}”</p>}
                  <textarea
                    id="pg-question"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    rows={3}
                    placeholder="e.g. In two sentences, how would you keep speaker labels accurate in a noisy recording?"
                    className="mt-2 w-full rounded-lg border-2 border-[var(--line)] bg-white p-4 text-lg"
                  />
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">Leave blank to let Aide ask a generic question about the task.</p>
                </div>
              ) : (
                /* MCQ Assessment Builder */
                <div className="space-y-6">
                  <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] pb-2">
                    <span className="text-lg font-bold">Multiple Choice Questions ({mcqQuestions.length}/10)</span>
                    <button
                      type="button"
                      onClick={addQuestion}
                      disabled={mcqQuestions.length >= 10}
                      className="min-h-10 rounded-lg bg-[var(--ink)] px-4 py-1 text-sm font-bold text-[var(--paper)] disabled:opacity-50"
                    >
                      + Add Question
                    </button>
                  </div>

                  {mcqQuestions.map((q, qIdx) => (
                    <div key={qIdx} className="rounded-lg border-2 border-[var(--line)] p-4 bg-white space-y-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-md">Question {qIdx + 1}</span>
                        {mcqQuestions.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeQuestion(qIdx)}
                            className="text-sm font-bold text-[var(--alert)] underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      <div>
                        <label htmlFor={`mcq-${qIdx}-q`} className="sr-only">Question Text</label>
                        <input
                          id={`mcq-${qIdx}-q`}
                          value={q.question}
                          onChange={(e) => updateQuestion(qIdx, e.target.value)}
                          placeholder="e.g. What is the standard NIP bank code for Wema Bank?"
                          required
                          className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-md"
                        />
                      </div>

                      <div className="space-y-2">
                        <span className="block text-sm font-bold">Options (Mark correct answer)</span>
                        {q.options.map((opt, oIdx) => (
                          <div key={oIdx} className="flex items-center gap-3">
                            <input
                              type="radio"
                              name={`mcq-correct-${qIdx}`}
                              checked={q.correctIndex === oIdx}
                              onChange={() => setCorrect(qIdx, oIdx)}
                              className="h-5 w-5 accent-[var(--accent)]"
                            />
                            <input
                              value={opt}
                              onChange={(e) => updateOption(qIdx, oIdx, e.target.value)}
                              placeholder={`Option ${oIdx + 1} ${oIdx > 1 ? "(optional)" : ""}`}
                              required={oIdx < 2}
                              className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-md"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={busy || !title.trim() || !skill.trim() || !pay.trim()}
              className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white disabled:opacity-50"
            >
              {busy ? "Posting…" : "Post gig"}
            </button>
            <button type="button" onClick={onClose} className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-6 py-3 text-lg font-bold">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
