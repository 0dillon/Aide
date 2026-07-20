import type { Metadata } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { Nav } from "./nav";
import { AideProvider } from "./aide";
import "./globals.css";

// Self-hosted at build time by next/font — no render-blocking request to
// Google on every page load.
const atkinson = Atkinson_Hyperlegible({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-atkinson",
});

export const metadata: Metadata = {
  title: "Aide — voice-native work & pay",
  description: "Find work, prove your skills, and get paid — by voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={atkinson.variable}>
      <body>
        <AideProvider>
          <a href="#main" className="skip-link">
            Skip to main content
          </a>
          <header className="flex items-center justify-between gap-4 border-b-2 border-[var(--ink)] bg-[var(--paper)] px-4 py-2 sm:px-8">
            <span className="text-xl font-bold tracking-tight">Aide</span>
            <Nav />
          </header>
          {children}
        </AideProvider>
      </body>
    </html>
  );
}
