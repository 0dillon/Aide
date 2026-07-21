import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Aide — work and get paid, by voice",
  description:
    "Aide is a voice-native work-and-pay platform for blind and visually impaired workers in Nigeria. Find work, prove your skill, get hired, and get paid — without a screen.",
};

// The About page is the front door for anyone who has not talked to Aide yet —
// a judge, an employer, a curious visitor. It is written as a landing page, not
// a spec sheet: the argument is made through the product's own arc (find work →
// prove it → get hired → get paid), with the honest engineering detail kept for
// ARCHITECTURE.md and the README. Same design language as the rest of Aide —
// Atkinson Hyperlegible, the accessible tokens, the dark transcript-panel band.

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl border-2 border-[var(--line)] bg-white p-6">
      <span aria-hidden="true" className="text-sm font-bold uppercase tracking-widest text-[var(--accent)]">
        Step {n}
      </span>
      <h3 className="mt-2 text-2xl font-bold tracking-tight">{title}</h3>
      <p className="mt-2 text-lg leading-relaxed text-[var(--ink-soft)]">{children}</p>
    </li>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t-2 border-[var(--line)] pt-5">
      <h3 className="text-xl font-bold tracking-tight">{title}</h3>
      <p className="mt-2 max-w-[44ch] text-lg leading-relaxed text-[var(--ink-soft)]">{children}</p>
    </div>
  );
}

export default function AboutPage() {
  return (
    <main id="main">
      {/* Hero */}
      <section aria-labelledby="lede" className="mx-auto max-w-5xl px-6 pb-16 pt-16 sm:px-10 sm:pt-24">
        <p className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">
          Voice-native work &amp; pay · APIConf × Monnify
        </p>
        <h1 id="lede" className="mt-6 max-w-[16ch] text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
          Getting paid should not require sight.
        </h1>
        <p className="mt-8 max-w-[54ch] text-xl leading-relaxed text-[var(--ink-soft)] sm:text-2xl">
          Aide is a work-and-pay platform you run entirely by talking. Find real gigs, prove your skill, get
          hired, and receive real money in your own bank account — no screen, no forms, no codes to read.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            href="/"
            className="inline-flex min-h-14 cursor-pointer items-center rounded-lg bg-[var(--accent)] px-7 text-lg font-bold text-[var(--accent-ink)] underline-offset-4 hover:underline"
          >
            Talk to Aide
          </Link>
          <a
            href="#how"
            className="inline-flex min-h-14 cursor-pointer items-center rounded-lg border-2 border-[var(--ink)] px-7 text-lg font-bold text-[var(--ink)] underline-offset-4 hover:underline"
          >
            See how it works
          </a>
        </div>
      </section>

      {/* The barrier — stated once, plainly, then moved on from */}
      <section aria-labelledby="barrier" className="mx-auto max-w-5xl px-6 pb-6 sm:px-10">
        <h2 id="barrier" className="max-w-[22ch] text-3xl font-bold tracking-tight sm:text-4xl">
          The online economy was built for people who can see it.
        </h2>
        <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-[var(--ink-soft)]">
          Sign-up forms, dashboards, uploaded CVs, one-time codes texted to a screen — every one of them is a
          wall if you are blind. The usual answer, a screen reader bolted onto a sighted-first app, is slow and
          brittle, and most brittle exactly where it matters most: money. Aide starts from the other end. The
          conversation <em>is</em> the product; the screen is only an optional mirror for those who can use it.
        </p>
      </section>

      {/* How it works */}
      <section id="how" aria-labelledby="how-h" className="mx-auto max-w-5xl px-6 py-14 sm:px-10">
        <h2 id="how-h" className="text-3xl font-bold tracking-tight sm:text-4xl">
          Four steps, all spoken
        </h2>
        <ol className="mt-8 grid gap-5 sm:grid-cols-2">
          <Step n={1} title="Find work">
            Say <em>“find me transcription jobs paying over twelve thousand,”</em> and Aide filters the board
            and reads the matches back to you — then applies on your word.
          </Step>
          <Step n={2} title="Prove your skill">
            A short spoken assessment — an oral question or multiple choice — graded fairly, with the answers
            never revealed. No camera, no lockdown, nothing that would exclude the people this is built for.
          </Step>
          <Step n={3} title="Get hired &amp; onboarded">
            The employer hires by voice, and a private channel opens between you. Your first task and login
            details arrive there and Aide reads each one aloud the moment it lands — no inbox to go navigate.
          </Step>
          <Step n={4} title="Get paid">
            Money arrives in your own real bank account, and Aide announces it the instant it clears. Withdrawals
            go out only after you confirm out loud.
          </Step>
        </ol>
      </section>

      {/* Value props — what makes a voice money product trustworthy */}
      <section aria-labelledby="trust" className="mx-auto max-w-5xl px-6 pb-16 sm:px-10">
        <h2 id="trust" className="text-3xl font-bold tracking-tight sm:text-4xl">
          Built to be trusted with money
        </h2>
        <div className="mt-8 grid gap-x-12 gap-y-9 sm:grid-cols-2">
          <Feature title="Real money, never guessed">
            Every balance and every payment is a live Monnify call, re-checked on our own servers before Aide
            will say it out loud. Aide is architecturally forbidden from inventing a number.
          </Feature>
          <Feature title="A code you say, not one you read">
            Withdrawing takes two steps: Aide reads the amount and the bank-verified destination name back to
            you, then you confirm out loud. It is the accessible equivalent of an OTP.
          </Feature>
          <Feature title="Your own bank account">
            Every worker is issued a dedicated virtual account the moment they join, so pay lands directly —
            nothing to set up by sight, and the account number is the one thing Aide will repeat as often as
            you like.
          </Feature>
          <Feature title="Onboarding that survives the handoff">
            Getting hired usually hands you back to email and chat. Here the first task and the credentials come
            through the same voice channel, read aloud on arrival — the part where the job actually begins.
          </Feature>
          <Feature title="Interrupt any time">
            Talk over Aide whenever you want; the microphone stays open while it speaks. You never pay the tax
            of waiting for a machine to finish a paragraph.
          </Feature>
          <Feature title="Legible for low vision and color blindness">
            For those who do use the screen: Atkinson Hyperlegible type at an 18-pixel base, WCAG-AAA contrast,
            and a colorblind-safe palette where no status is ever signalled by color alone.
          </Feature>
        </div>
      </section>

      {/* Under the hood — the credibility band, on the dark transcript surface */}
      <section aria-labelledby="stack" className="dark-surface bg-[var(--panel)] text-[var(--panel-ink)]">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:px-10">
          <h2 id="stack" className="text-3xl font-bold tracking-tight sm:text-4xl">
            Under the hood
          </h2>
          <p className="mt-4 max-w-[58ch] text-lg text-[var(--panel-soft)]">
            Nothing here is mocked. The money is real sandbox money moving through real bank rails.
          </p>

          <div className="mt-10 grid gap-x-12 gap-y-8 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--panel-soft)]">Monnify</h3>
              <ul className="mt-3 space-y-2 text-lg">
                <li>A dedicated reserved account (NUBAN) minted per worker</li>
                <li>Inbound transfers verified server-side before Aide announces them</li>
                <li>Name enquiry on the payout account, read back aloud</li>
                <li>Transfers authorised only by the spoken confirmation</li>
                <li>Webhooks rejected unless the SHA-512 HMAC signature matches</li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--panel-soft)]">Everything else</h3>
              <ul className="mt-3 space-y-2 text-lg">
                <li>
                  Convex for shared, reactive state — a payment landing on one server instance still reaches the
                  browser listening on another, and it carries the live employer-to-worker onboarding messages
                  the same way
                </li>
                <li>A Nigerian neural voice, synthesised server-side and pipelined sentence by sentence so speech does not stutter</li>
                <li>Browser speech recognition, with a spoken fallback wherever it is missing</li>
                <li>Next.js on Vercel; the voice runs as a Python function alongside it</li>
              </ul>
            </div>
          </div>

          <p className="mt-10 max-w-[62ch] text-lg text-[var(--panel-soft)]">
            Balances are never guessed. Available money is confirmed inbound transfers to that worker&rsquo;s own
            account, minus their own withdrawals — and Aide only ever says a payment happened when the payment
            provider confirms it did.
          </p>
        </div>
      </section>

      {/* Close */}
      <section aria-labelledby="try" className="mx-auto max-w-5xl px-6 py-16 sm:px-10">
        <h2 id="try" className="max-w-[24ch] text-3xl font-bold tracking-tight sm:text-4xl">
          The fastest way to understand it is to talk to it.
        </h2>
        <p className="mt-4 max-w-[58ch] text-lg text-[var(--ink-soft)]">
          Aide starts listening the moment the page opens — there is no button to find first. Allow the
          microphone and say <em>&ldquo;find me work&rdquo;</em>. If you would rather not speak out loud, there is
          a text box under the circle that does the same thing.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex min-h-14 cursor-pointer items-center rounded-lg bg-[var(--accent)] px-7 text-lg font-bold text-[var(--accent-ink)] underline-offset-4 hover:underline"
        >
          Talk to Aide
        </Link>
      </section>
    </main>
  );
}
