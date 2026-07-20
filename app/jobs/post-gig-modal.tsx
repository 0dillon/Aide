"use client";

import { useEffect, useRef, useState } from "react";
import { useAide } from "../aide";

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

export function PostGigModal({ onClose, onPosted }: { onClose: () => void; onPosted: (title: string) => void }) {
  const { supported, listening, capturing, interim, beginCapture, endCapture } = useAide();
  const [title, setTitle] = useState("");
  const [skill, setSkill] = useState("");
  const [pay, setPay] = useState("");
  const [requires, setRequires] = useState(true);
  const [assessmentType, setAssessmentType] = useState<"oral" | "mcq">("oral");
  const [timeLimitOpt, setTimeLimitOpt] = useState("none");
  const [question, setQuestion] = useState("");
  const [mcqQuestions, setMcqQuestions] = useState<Array<{ question: string; options: string[]; correctIndex: number }>>([
    { question: "", options: ["", "", "", ""], correctIndex: 0 },
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
    setMcqQuestions((prev) => [...prev, { question: "", options: ["", "", "", ""], correctIndex: 0 }]);
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
      const sanitizedMcq =
        requires && assessmentType === "mcq"
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
          <button onClick={onClose} aria-label="Close" className="min-h-10 rounded-lg border-2 border-[var(--ink)] px-3 py-1 font-bold">
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
                          <button type="button" onClick={() => removeQuestion(qIdx)} className="text-sm font-bold text-[var(--alert)] underline">
                            Remove
                          </button>
                        )}
                      </div>

                      <div>
                        <label htmlFor={`mcq-${qIdx}-q`} className="sr-only">
                          Question Text
                        </label>
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
