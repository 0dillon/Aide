"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  );
}
