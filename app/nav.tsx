"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Aide" },
  { href: "/jobs", label: "Jobs" },
  { href: "/payments", label: "Payments" },
  { href: "/profile", label: "Profile" },
  { href: "/about", label: "About" },
];

// Active page is marked three ways — aria-current, inverted colors, and an
// underline — so it never relies on color perception alone.
export function Nav() {
  const pathname = usePathname();
  return (
    // One row on every screen. The links scroll horizontally within their own
    // strip if they don't fit, which keeps navigation off the vertical budget —
    // on a phone the wrapped version was eating a fifth of the viewport before
    // the user reached Aide itself.
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:justify-end sm:gap-3">
      <nav aria-label="Main" className="min-w-0 flex-1 sm:flex-none">
        <ul className="flex gap-1 overflow-x-auto sm:gap-2">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-12 shrink-0 items-center rounded-lg px-2.5 text-base font-bold sm:px-4 sm:text-lg ${
                    active
                      ? "bg-[var(--ink)] text-[var(--paper)] underline underline-offset-4"
                      : "text-[var(--ink)] hover:underline hover:underline-offset-4"
                  }`}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <AccountSwitcher />
    </div>
  );
}

// Global account switcher: every account on the instance (seeded demo ones
// and any created by voice or signup), switchable from anywhere. You can also
// just tell Aide "switch to my employer account".
function AccountSwitcher() {
  const [accounts, setAccounts] = useState<{ id: string; name: string; role: string }[]>([]);
  const [current, setCurrent] = useState("");
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    fetch("/api/account/switch")
      .then((r) => r.json())
      .then((d) => {
        setAccounts(d.accounts ?? []);
        setCurrent(d.current ?? "");
        setAuthenticated(!!d.authenticated);
      })
      .catch(() => {});
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  const switchTo = async (id: string) => {
    if (!id || id === current) return;
    const res = await fetch("/api/account/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) window.location.reload();
  };

  // Logged-in real user: show who they are and a log-out; the demo switcher
  // is hidden (real identities are not switchable without a password).
  if (authenticated) {
    return (
      <button
        onClick={logout}
        className="min-h-12 rounded-lg border-2 border-[var(--ink)] px-4 font-bold text-[var(--ink)]"
      >
        Log out
      </button>
    );
  }

  if (accounts.length === 0) return null;
  return (
    // Hidden on phones: 412px can't hold five nav links plus a select and a
    // login link without clipping words. Switching accounts is a demo
    // affordance, and on the primary surface it is done by voice anyway —
    // "switch to my employer account".
    <div className="hidden shrink-0 items-center gap-1 sm:flex sm:gap-2">
      <label htmlFor="account-switcher" className="sr-only">
        Switch demo account
      </label>
      <select
        id="account-switcher"
        value={current}
        onChange={(e) => switchTo(e.target.value)}
        className="min-h-12 w-16 min-w-0 rounded-lg border-2 border-[var(--line)] bg-white px-1 py-1 text-xs font-bold text-[var(--ink)] sm:w-auto sm:max-w-48 sm:px-2 sm:text-base"
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.role})
          </option>
        ))}
      </select>
      <Link
        href="/login"
        className="inline-flex min-h-12 shrink-0 items-center rounded-lg px-1.5 text-sm font-bold text-[var(--accent)] underline underline-offset-2 sm:px-3 sm:text-base"
      >
        Log in
      </Link>
    </div>
  );
}
