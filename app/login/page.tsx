"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAide } from "../aide";

// Real login for credentialed accounts. Passwords are typed, never spoken —
// saying a password aloud is exactly the kind of leak this platform's users
// can't afford, so the keyboard is the right channel here.
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { speak } = useAide();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not log in.");
      speak(`Welcome back, ${data.name}. You are logged in.`);
      router.push("/profile");
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      speak(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10 sm:px-8">
      <h1 className="text-4xl font-bold tracking-tight">Log in</h1>
      <p className="mt-2 text-lg text-[var(--ink-soft)]">Enter the email and password you signed up with.</p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border-2 border-[var(--alert)] px-4 py-3 font-bold text-[var(--alert)]">
          Error: {error}
        </p>
      )}

      <form onSubmit={submit} className="mt-8 space-y-6">
        <div>
          <label htmlFor="li-email" className="block text-xl font-bold">
            Email
          </label>
          <input
            id="li-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="email"
            className="mt-2 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
          />
        </div>
        <div>
          <label htmlFor="li-password" className="block text-xl font-bold">
            Password
          </label>
          <input
            id="li-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="mt-2 w-full rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-lg"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          className="min-h-12 rounded-lg bg-[var(--accent)] px-8 py-3 text-xl font-bold text-white disabled:opacity-50"
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p className="mt-6 text-[var(--ink-soft)]">
        New here?{" "}
        <a href="/signup" className="font-bold text-[var(--accent)] underline underline-offset-2">
          Create an account
        </a>
      </p>
    </main>
  );
}
