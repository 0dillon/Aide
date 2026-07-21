"use client";

import { useState } from "react";

// Screen signup. The fully voice-native path also exists: just tell Aide
// "sign me up" and it collects name + role and calls create_account itself.
export default function SignupPage() {
  const [role, setRole] = useState<"worker" | "employer" | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!role) {
      setError("Choose whether you are joining as a worker or an employer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role, email, password: password || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not create the account.");
      // Full navigation, not router.push: the whole app must restart as the
      // new identity — fresh transcript, fresh greeting (which offers the
      // new-account onboarding), fresh nav auth state. The greeting speaks
      // the welcome, so nothing needs to be said here.
      window.location.assign("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10 sm:px-8">
      <h1 className="text-4xl font-bold tracking-tight">Create your account</h1>
      <p className="mt-2 text-lg text-[var(--ink-soft)]">
        Prefer to talk? Just tell Aide “sign me up” and it will do this for you by voice.
      </p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}

      <form onSubmit={submit} className="mt-8 space-y-8">
        <fieldset>
          <legend className="text-xl font-bold">I am joining as…</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {(
              [
                { value: "worker", title: "Worker", blurb: "Find gigs, prove skills by voice, get paid." },
                { value: "employer", title: "Employer", blurb: "Post work and pay workers." },
              ] as const
            ).map((opt) => {
              const selected = role === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRole(opt.value)}
                  aria-pressed={selected}
                  className={`rounded-xl border-4 p-5 text-left ${
                    selected ? "border-[var(--accent)] bg-white" : "border-[var(--line)] bg-white"
                  }`}
                >
                  <span className="block text-2xl font-bold">
                    {selected ? "✓ " : ""}
                    {opt.title}
                  </span>
                  <span className="mt-1 block text-[var(--ink-soft)]">{opt.blurb}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor="su-name" className="block text-xl font-bold">
            Your name
          </label>
          <input
            id="su-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="mt-2 w-full max-w-md rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
          />
        </div>

        <div>
          <label htmlFor="su-email" className="block text-xl font-bold">
            Email <span className="font-normal text-[var(--ink-soft)]">(required for a login)</span>
          </label>
          <input
            id="su-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="mt-2 w-full max-w-md rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
          />
        </div>

        <div>
          <label htmlFor="su-password" className="block text-xl font-bold">
            Password <span className="font-normal text-[var(--ink-soft)]">(at least 8 characters — leave blank for a demo identity)</span>
          </label>
          <input
            id="su-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            className="mt-2 w-full max-w-md rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
          />
        </div>

        <p className="text-[var(--ink-soft)]">
          Already have an account?{" "}
          <a href="/login" className="font-bold text-[var(--accent)] underline underline-offset-2">
            Log in
          </a>
        </p>

        <button
          type="submit"
          disabled={busy || !name.trim() || !role}
          className="min-h-12 rounded-lg bg-[var(--accent)] px-8 py-3 text-xl font-bold text-white disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
