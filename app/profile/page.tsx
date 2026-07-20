"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useAide } from "../aide";

type Job = { id: string; title: string; skill: string; pay: number; employer: string };
type WorkerProfile = {
  role: "worker";
  account: { id: string; name: string; email?: string; role: string; createdAt: number };
  applications: { id: string; jobId: string; status: string; verified: boolean; job?: Job }[];
  completedJobs: number;
  verifiedSkills: string[];
  skills: string[];
  bio: string;
  balance: number | null;
  accountNumber?: string;
  bankName?: string;
};
type EmployerProfile = {
  role: "employer";
  account: { id: string; name: string; email?: string; role: string; createdAt: number };
  jobsPosted: Job[];
  jobsCompleted: string[];
  totalCommitted: number;
};
type Profile = WorkerProfile | EmployerProfile;

const naira = (n: number) => "₦" + n.toLocaleString("en-NG");

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const { speak } = useAide();

  const load = () => {
    fetch("/api/profile")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setProfile(d)))
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
        <p role="alert" className="rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      </main>
    );
  }
  if (!profile) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
        <p className="text-lg text-[var(--ink-soft)]">Loading profile…</p>
      </main>
    );
  }

  const acc = profile.account;
  const since = new Date(acc.createdAt).toLocaleDateString("en-NG", { year: "numeric", month: "long" });

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">{acc.name}</h1>
          <p className="mt-1 text-lg text-[var(--ink-soft)]">
            <span className="mr-2 rounded-full border-2 border-[var(--accent)] px-3 py-0.5 font-bold text-[var(--accent)]">
              {profile.role === "worker" ? "Worker" : "Employer"}
            </span>
            Member since {since}
            {acc.email ? ` · ${acc.email}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {profile.role === "worker" && (
            <button
              onClick={() => setShowEdit(true)}
              className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-5 py-3 font-bold"
            >
              Edit Profile
            </button>
          )}
          <button
            onClick={() =>
              speak(
                profile.role === "worker"
                  ? `You are ${acc.name}, a worker on Aide. You have completed ${profile.completedJobs} jobs and verified ${profile.verifiedSkills.length} skills.`
                  : `You are ${acc.name}, an employer on Aide. You have posted ${profile.jobsPosted.length} jobs.`,
              )
            }
            className="min-h-12 rounded-lg bg-[var(--accent)] px-5 py-3 font-bold text-white"
          >
            Read profile aloud
          </button>
        </div>
      </div>

      {acc.id === "demo-worker" && (
        <div className="mt-4 space-y-2">
          <p className="text-[var(--ink-soft)]">
            This is the shared demo account.{" "}
            <Link href="/signup" className="font-bold text-[var(--accent)] underline underline-offset-2">
              Create your own
            </Link>{" "}
            — or just tell Aide “sign me up”.
          </p>
          <button
            onClick={() => {
              document.cookie = "aide-user=demo-employer; path=/; max-age=31536000; samesite=lax";
              window.location.reload();
            }}
            className="min-h-10 rounded-lg border-2 border-[var(--ink)] px-4 py-2 font-bold text-[var(--ink)]"
          >
            Switch to Demo Employer (ClearVoice Media)
          </button>
        </div>
      )}

      {acc.id === "demo-employer" && (
        <div className="mt-4">
          <button
            onClick={() => {
              document.cookie = "aide-user=demo-worker; path=/; max-age=31536000; samesite=lax";
              window.location.reload();
            }}
            className="min-h-10 rounded-lg border-2 border-[var(--ink)] px-4 py-2 font-bold text-[var(--ink)]"
          >
            Switch to Demo Worker (Aide Demo Worker)
          </button>
        </div>
      )}

      {profile.role === "worker" ? (
        <>
          <section aria-label="Work summary" className="mt-8 grid gap-4 sm:grid-cols-3">
            <Stat label="Completed jobs" value={String(profile.completedJobs)} />
            <Stat label="Verified skills" value={String(profile.verifiedSkills.length)} />
            <Stat label="Confirmed earnings" value={profile.balance === null ? "—" : naira(profile.balance)} />
          </section>

          {/* Spoken Bio / Resume Summary */}
          <section id="bio" aria-label="Spoken Bio / Resume" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Spoken Bio / Resume</h2>
            <p className="mt-3 text-lg leading-relaxed whitespace-pre-wrap">
              {profile.bio || "No professional summary has been added yet. Edit your profile to add your resume or experience."}
            </p>
          </section>

          {/* Self-Declared Skills */}
          <section id="skills" aria-label="Declared Skills" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Skills</h2>
            {profile.skills && profile.skills.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {profile.skills.map((s) => (
                  <li key={s} className="rounded-full border-2 border-[var(--line)] bg-[var(--paper)] px-4 py-1 font-bold text-[var(--ink)]">
                    {s}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-lg text-[var(--ink-soft)]">No self-declared skills listed. Edit your profile to list your skills.</p>
            )}
          </section>

          {profile.verifiedSkills.length > 0 && (
            <section aria-label="Verified skills" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
              <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Verified skills</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {profile.verifiedSkills.map((s) => (
                  <li key={s} className="rounded-full border-2 border-[var(--good)] px-4 py-1 font-bold text-[var(--good)]">
                    ✓ {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section id="applications" aria-label="Applications" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Applications</h2>
            {profile.applications.length === 0 ? (
              <p className="mt-3 text-lg text-[var(--ink-soft)]">
                No applications yet — ask Aide to find you work, or browse{" "}
                <Link href="/jobs" className="font-bold text-[var(--accent)] underline underline-offset-2">
                  jobs
                </Link>
                .
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--line)]">
                {profile.applications.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="text-lg font-bold">{a.job?.title ?? a.jobId}</span>
                    <span
                      className="rounded-full border-2 px-3 py-0.5 font-bold"
                      style={
                        a.verified
                          ? { borderColor: "var(--good)", color: "var(--good)" }
                          : { borderColor: "var(--ink-soft)", color: "var(--ink-soft)" }
                      }
                    >
                      {a.verified ? "✓ completed" : a.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Earnings account" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Earnings account</h2>
            <p className="mt-2 text-lg">
              {profile.accountNumber ? (
                <>
                  <span className="font-mono">{profile.accountNumber}</span> · {profile.bankName}
                </>
              ) : (
                "Created the first time money is involved — ask Aide for your balance."
              )}
            </p>
          </section>
        </>
      ) : profile.role === "employer" ? (
        <>
          <section aria-label="Employer summary" className="mt-8 grid gap-4 sm:grid-cols-3">
            <Stat label="Jobs posted" value={String(profile.jobsPosted.length)} />
            <Stat label="Jobs completed for you" value={String(profile.jobsCompleted.length)} />
            <Stat label="Total committed pay" value={naira(profile.totalCommitted)} />
          </section>

          <section aria-label="Posted jobs" className="mt-6 rounded-xl border-2 border-[var(--line)] bg-white p-6">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Your posted jobs</h2>
            {profile.jobsPosted.length === 0 ? (
              <p className="mt-3 text-lg text-[var(--ink-soft)]">No jobs posted under this name yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--line)]">
                {profile.jobsPosted.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="text-lg font-bold">{j.title}</span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{naira(j.pay)}</span>
                      {profile.jobsCompleted.includes(j.id) && (
                        <span className="rounded-full border-2 border-[var(--good)] px-3 py-0.5 font-bold text-[var(--good)]">
                          ✓ completed
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-[var(--ink-soft)]">
              Ready to pay a worker? Use the{" "}
              <a href="/employer" className="font-bold text-[var(--accent)] underline underline-offset-2">
                payout desk
              </a>
              .
            </p>
          </section>
        </>
      ) : null}

      {showEdit && profile && profile.role === "worker" && (
        <EditProfileModal
          currentName={profile.account.name}
          currentEmail={profile.account.email || ""}
          currentBio={profile.bio || ""}
          currentSkills={profile.skills || []}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            load();
            speak("Your profile has been updated.");
          }}
        />
      )}
    </main>
  );
}

function EditProfileModal({
  currentName,
  currentEmail,
  currentBio,
  currentSkills,
  onClose,
  onSaved,
}: {
  currentName: string;
  currentEmail: string;
  currentBio: string;
  currentSkills: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { supported, listening, capturing, interim, beginCapture, endCapture, speak } = useAide();
  const [name, setName] = useState(currentName);
  const [email, setEmail] = useState(currentEmail);
  const [bio, setBio] = useState(currentBio);
  const [skills, setSkills] = useState(currentSkills.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whatever happens to this modal, the mic goes back to Aide.
  const endCaptureRef = useRef(endCapture);
  endCaptureRef.current = endCapture;
  useEffect(() => () => endCaptureRef.current(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleDictation = () => {
    if (capturing) endCapture();
    else beginCapture((t) => setBio((prev) => (prev ? prev + " " : "") + t));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const skillsArray = skills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          bio,
          skills: skillsArray,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not update profile.");
      endCapture();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit Profile"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border-4 border-[var(--accent)] bg-[var(--paper)] p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-2xl font-bold">Edit Profile</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="min-h-10 rounded-lg border-2 border-[var(--ink)] px-3 py-1 font-bold"
          >
            ✕ Close
          </button>
        </div>
        <p className="mt-1 text-[var(--ink-soft)]">
          Or close this and simply tell Aide <em>“update my profile details”</em>.
        </p>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border-2 border-[var(--alert)] px-4 py-2 font-bold text-[var(--alert)]">
            Error: {error}
          </p>
        )}

        <form onSubmit={submit} className="mt-5 space-y-5">
          <div>
            <label htmlFor="ep-name" className="block font-bold">
              Full Name
            </label>
            <input
              id="ep-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
            />
          </div>

          <div>
            <label htmlFor="ep-email" className="block font-bold">
              Email Address
            </label>
            <input
              id="ep-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
            />
          </div>

          <div>
            <label htmlFor="ep-skills" className="block font-bold">
              Skills (comma-separated)
            </label>
            <input
              id="ep-skills"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              placeholder="e.g. translation, data entry, audio QA"
              className="mt-1 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
            />
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="ep-bio" className="block font-bold">
                Spoken Bio / Resume Summary
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
              id="ep-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={4}
              placeholder="Describe your work experience and credentials..."
              className="mt-2 w-full rounded-lg border-2 border-[var(--line)] bg-white p-4 text-lg"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="min-h-12 rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save Changes"}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border-2 border-[var(--line)] bg-white p-5">
      <p className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
