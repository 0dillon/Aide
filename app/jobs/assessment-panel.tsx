"use client";

import { useEffect, useRef, useState } from "react";
import { useAide } from "../aide";
import type { AssessmentData, AssessmentResult } from "./types";

// The live assessment: countdown + spoken alerts, oral dictation via Aide's
// mic (with the "cancel assessment" voice command), MCQ radio groups, and the
// permanent cancel lockout. The page owns starting an assessment; this panel
// owns everything that happens until it is submitted, cancelled, or timed out.

export function AssessmentPanel({
  assessment,
  onResult,
  onClose,
  reload,
}: {
  assessment: AssessmentData;
  onResult: (r: AssessmentResult) => void;
  onClose: () => void;
  reload: () => Promise<void> | void;
}) {
  const { listening, capturing, interim, supported, speak, beginCapture, endCapture } = useAide();
  const [answer, setAnswer] = useState("");
  const [mcqAnswers, setMcqAnswers] = useState<number[]>(() => new Array(assessment.questions?.length ?? 0).fill(-1));
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancelling is one-way: the server locks the job for this worker forever.
  const pendingCancelRef = useRef(false);
  const cancelForGood = async () => {
    await fetch("/api/jobs/assessment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: assessment.job.id, action: "cancel" }),
    }).catch(() => {});
    onResult({ verified: false, message: `Assessment cancelled. ${assessment.job.title} is now permanently closed to you.` });
    onClose();
    speak(`Your assessment is cancelled. As I warned, ${assessment.job.title} is now permanently closed to you — but I can find you other jobs any time.`);
    await reload();
  };

  const onCancelClick = () => {
    const sure = window.confirm("Cancel this assessment? This is permanent — you will NEVER be able to apply to this job again.");
    if (sure) cancelForGood();
  };

  // Oral assessments borrow Aide's mic for dictation. "cancel assessment" is
  // a command, not part of the answer: first time warns, again confirms.
  const cancelRef = useRef(cancelForGood);
  cancelRef.current = cancelForGood;
  useEffect(() => {
    if (assessment.assessmentType !== "oral") return;
    beginCapture((t) => {
      if (/\bcancel (the |this |my )?assessment\b/i.test(t)) {
        if (pendingCancelRef.current) cancelRef.current();
        else {
          pendingCancelRef.current = true;
          speak(
            "Are you sure? Cancelling permanently locks this job — you will never be able to apply to it again. Say cancel assessment once more to confirm, or just continue answering.",
          );
        }
        return;
      }
      setAnswer((prev) => (prev ? prev + " " : "") + t);
    });
    // Leaving the panel (or the page) must hand the mic back to Aide.
    return () => endCapture();
  }, [assessment, beginCapture, endCapture, speak]);

  // Timer countdown and expiration handling.
  useEffect(() => {
    if (!assessment.timeLimit) {
      setTimeLeft(null);
      return;
    }
    const elapsed = Math.floor((Date.now() - (assessment.startedAt || Date.now())) / 1000);
    setTimeLeft(Math.max(0, assessment.timeLimit - elapsed));

    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(interval);
          speak("Time is up. Your assessment time has expired.");
          onResult({ verified: false, message: "Time limit exceeded. Your assessment has timed out." });
          onClose();
          reload();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessment]);

  // Spoken countdown alerts as the limit approaches. Skipped when the alert
  // equals the full limit (no point announcing "one minute left" at start).
  const lastAlertRef = useRef<number | null>(null);
  useEffect(() => {
    if (timeLeft === null) return;
    if (timeLeft === assessment.timeLimit) return;
    if ((timeLeft === 60 || timeLeft === 30 || timeLeft === 10) && lastAlertRef.current !== timeLeft) {
      lastAlertRef.current = timeLeft;
      speak(timeLeft === 60 ? "One minute left." : timeLeft === 30 ? "Thirty seconds left." : "Ten seconds left.");
    }
  }, [timeLeft, assessment, speak]);

  const readMcqQuestionAloud = (qIdx: number) => {
    const q = assessment.questions?.[qIdx];
    if (!q) return;
    speak(`Question ${qIdx + 1}: ${q.question}. The options are: ${q.options.map((o, idx) => `option ${idx + 1}, ${o}`).join(". ")}`);
  };

  const submitAnswer = async () => {
    if (assessment.assessmentType === "mcq") {
      const unanswered = mcqAnswers.findIndex((ans) => ans === -1);
      if (unanswered !== -1) {
        setError(`Please answer question ${unanswered + 1} before submitting.`);
        return;
      }
    } else if (!answer.trim()) {
      setError("Please speak or type an answer before submitting.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { jobId: assessment.job.id };
      if (assessment.assessmentType === "mcq") payload.answers = mcqAnswers;
      else payload.answer = answer.trim();

      const res = await fetch("/api/jobs/assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not submit the answer.");
      onResult({ verified: data.verified, message: data.message });
      speak(data.message);
      if (data.verified) onClose();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-label="Assessment" className="mt-8 rounded-xl border-4 border-[var(--accent)] bg-white p-6">
      {error && (
        <p role="alert" className="mb-4 rounded-lg border-2 border-[var(--alert)] px-4 py-2 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}
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
              <legend className="text-xl font-bold px-2 bg-white rounded border border-[var(--line)]">Question {qIdx + 1}</legend>
              <p className="text-lg font-bold mt-2">{q.question}</p>

              <div className="mt-4 space-y-3">
                {q.options.map((opt, oIdx) => {
                  const id = `q-${qIdx}-opt-${oIdx}`;
                  return (
                    <div key={oIdx} className="flex items-center gap-3">
                      <input
                        id={id}
                        type="radio"
                        name={`question-${qIdx}`}
                        checked={mcqAnswers[qIdx] === oIdx}
                        onChange={() => {
                          setMcqAnswers((prev) => {
                            const nextAns = [...prev];
                            nextAns[qIdx] = oIdx;
                            return nextAns;
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
            {capturing && listening ? "Aide is listening — just speak your answer." : "Aide is writing down what you say."}
          </p>
          {!supported && <p className="mt-2 text-[var(--alert)]">No speech recognition in this browser — type your answer below.</p>}
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
        <button onClick={onCancelClick} className="min-h-12 rounded-lg border-2 border-[var(--alert)] px-6 py-3 text-lg font-bold text-[var(--alert)]">
          Cancel assessment (locks this job)
        </button>
      </div>
    </section>
  );
}
