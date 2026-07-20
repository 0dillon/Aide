"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Aide" },
  { href: "/jobs", label: "Jobs" },
  { href: "/payments", label: "Payments" },
  { href: "/profile", label: "Profile" },
];

// Active page is marked three ways — aria-current, inverted colors, and an
// underline — so it never relies on color perception alone.
export function Nav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-3">
      <nav aria-label="Main">
        <ul className="flex gap-2">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-12 items-center rounded-lg px-4 text-lg font-bold ${
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
    <div className="flex items-center gap-2">
      <label htmlFor="account-switcher" className="sr-only">
        Switch demo account
      </label>
      <select
        id="account-switcher"
        value={current}
        onChange={(e) => switchTo(e.target.value)}
        className="min-h-12 max-w-48 rounded-lg border-2 border-[var(--line)] bg-white px-2 py-1 font-bold text-[var(--ink)]"
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.role})
          </option>
        ))}
      </select>
      <Link href="/login" className="min-h-12 inline-flex items-center rounded-lg px-3 font-bold text-[var(--accent)] underline underline-offset-2">
        Log in
      </Link>
    </div>
  );
}
