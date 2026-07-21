"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Aide" },
  { href: "/jobs", label: "Jobs" },
  { href: "/payments", label: "Payments" },
  { href: "/profile", label: "Profile" },
  { href: "/about", label: "About" },
];

// Just the page links. Account switching and logging out live on the Profile
// page (and, for demo accounts, by voice — "switch to my employer account"),
// so the global bar stays uncluttered.
//
// Active page is marked three ways — aria-current, inverted colors, and an
// underline — so it never relies on color perception alone.
export function Nav() {
  const pathname = usePathname();
  return (
    // Right-aligned on desktop (sm:justify-end), a full-width scrollable strip
    // on phones. The links scroll horizontally within their own strip if they
    // don't fit, which keeps navigation off the vertical budget — on a phone
    // the wrapped version was eating a fifth of the viewport before the user
    // reached Aide itself.
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
                  className={`inline-flex min-h-12 shrink-0 cursor-pointer items-center rounded-lg px-2.5 text-base font-bold sm:px-4 sm:text-lg ${
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
    </div>
  );
}
