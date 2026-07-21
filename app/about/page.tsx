import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Aide — why it works this way",
  description: "Aide is a voice-native work and pay platform for blind Nigerians. The decisions behind it, and what runs underneath.",
};

// The judge-facing page. Everything else in Aide is built for someone who
// cannot see it; this page is for the person evaluating that work. It is set
// as an editorial spec sheet — a left rail of labels against a reading column —
// so it stays scannable without resorting to a grid of identical cards.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-t-2 border-[var(--line)] py-7 sm:grid-cols-[11rem_1fr] sm:gap-10">
      <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">{label}</h3>
      <div className="max-w-[62ch] space-y-3 text-lg">{children}</div>
    </div>
  );
}

export default function AboutPage() {
  return (
    <main id="main">
      {/* Opening statement — deliberately typographic, not a centered hero */}
      <section aria-labelledby="lede" className="mx-auto max-w-5xl px-6 pb-14 pt-16 sm:px-10 sm:pt-24">
        <p className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">
          APIConf × Monnify Developer Challenge
        </p>
        <h1 id="lede" className="mt-6 max-w-[20ch] text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
          Getting paid should not require sight.
        </h1>
        <p className="mt-8 max-w-[58ch] text-xl leading-relaxed text-[var(--ink-soft)] sm:text-2xl">
          Online work in Nigeria runs on screens: forms, dashboards, uploaded CVs, one-time codes.
          Every one of those is a wall if you are blind. Aide removes the screen entirely —
          you find work, prove your skill, and receive real money by talking.
        </p>
      </section>

      {/* The decisions. This is the argument, so it gets the most room. */}
      <section aria-labelledby="decisions" className="mx-auto max-w-5xl px-6 pb-16 sm:px-10">
        <h2 id="decisions" className="mb-8 text-3xl font-bold tracking-tight sm:text-4xl">
          Decisions, and why
        </h2>

        <Row label="No passwords">
          <p>
            Aide never asks for an email and password. You say your name and whether you want work or
            want to hire, and the account exists. Passwords are the single most common place a blind
            user gets stranded — unlabelled fields, hidden validation errors, and a reset flow that
            ends in an inbox they now have to navigate too.
          </p>
          <p className="text-[var(--ink-soft)]">
            A password login does exist for anyone who wants one. Nobody is forced through it.
          </p>
        </Row>

        <Row label="Money needs a second gate">
          <p>
            Passwordless does not mean careless. Withdrawing money takes two steps: Aide reads the
            amount and the destination account name back to you, then asks you to say one specific
            word aloud. Only that spoken word authorises the transfer, and only for five minutes.
          </p>
          <p className="text-[var(--ink-soft)]">
            It is a one-time code you never have to read — the accessible equivalent of an OTP.
          </p>
        </Row>

        <Row label="Interrupting">
          <p>
            You can cut Aide off at any moment by saying <strong>stop</strong>. The microphone stays
            open the entire time Aide is speaking for exactly this reason. Waiting politely for a
            machine to finish a paragraph is a tax sighted users never pay — they just look away.
          </p>
        </Row>

        <Row label="Failure has to be audible">
          <p>
            If your microphone is muted, Aide notices and <em>says so out loud</em>, then offers the
            typing fallback. On a browser with no speech recognition at all, it still speaks the way
            forward. A silent error message is invisible to the person who needs it most.
          </p>
        </Row>

        <Row label="Someone else in the room">
          <p>
            This is the hardest question a voice-first money product has to answer, so here
            is the honest version. A spoken confirmation does <strong>not</strong> stop
            somebody standing beside you — they hear the word Aide reads out. Treating
            &ldquo;said the right word&rdquo; as proof of identity would be false comfort.
          </p>
          <p>
            What actually protects the money is that it can only ever leave to a bank
            account registered <em>earlier</em>, whose real owner&rsquo;s name was checked
            with the bank and read back to you. Pointing the account somewhere new starts a
            hold before anything can be sent there. So a moment of access is not enough:
            redirecting your money takes time you would notice, not a sentence someone can
            say while you are out of the room. Single withdrawals are capped, and every one
            is announced aloud and written to a ledger you can ask Aide to read back.
          </p>
          <p className="text-[var(--ink-soft)]">
            The missing piece is verifying <em>who</em> is speaking, not just that the right
            words were said. Speaker verification is the correct next control, and it is not
            built yet — we would rather name that than imply the voice itself is a password.
          </p>
        </Row>

        <Row label="Receiving money needs no code">
          <p>
            Nothing gates money coming <em>in</em> — that is not a risk, and it is why the
            account number is the one thing Aide will repeat as often as you like. The
            controls sit on the way out, where they belong.
          </p>
          <p className="text-[var(--ink-soft)]">
            Inbound payments are never taken on trust either: a webhook alone is not proof.
            Every payment is re-fetched from the payment provider and checked server-side
            before Aide will say a naira has landed.
          </p>
        </Row>

        <Row label="Assessments are not proctored">
          <p>
            Skill checks are short and spoken, and they are deliberately not locked down. Camera
            proctoring and screen lockdown would exclude the exact people this is built for.
          </p>
          <p className="text-[var(--ink-soft)]">
            Integrity lives where it belongs: an employer only pays for work they accept, and
            ratings compound across jobs. A faked assessment does not survive real work.
          </p>
        </Row>

        <Row label="Reading, for those who can">
          <p>
            The interface is set in Atkinson Hyperlegible — a typeface drawn specifically to keep
            letterforms distinguishable in low vision — at an 18&nbsp;pixel base. Every colour pair
            clears WCAG AAA contrast, the palette holds up under all common types of colour blindness,
            state is never signalled by colour alone, and motion is dropped for anyone who asks their
            system for less of it.
          </p>
        </Row>
      </section>

      {/* Technical band — dark surface, reusing the transcript panel's language */}
      <section aria-labelledby="stack" className="dark-surface bg-[var(--panel)] text-[var(--panel-ink)]">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:px-10">
          <h2 id="stack" className="text-3xl font-bold tracking-tight sm:text-4xl">
            What is actually running
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
                <li>Transfers authorised by the spoken confirmation word</li>
                <li>Webhooks rejected unless the SHA-512 HMAC signature matches</li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--panel-soft)]">Everything else</h3>
              <ul className="mt-3 space-y-2 text-lg">
                <li>Convex for shared state, so a payment landing on one server instance still reaches the browser listening on another</li>
                <li>A Nigerian neural voice, synthesised server-side and pipelined sentence by sentence so speech does not stutter</li>
                <li>Browser speech recognition, with a spoken fallback wherever it is missing</li>
                <li>Next.js on Vercel; the voice runs as a Python function alongside it</li>
              </ul>
            </div>
          </div>

          <p className="mt-10 max-w-[62ch] text-lg text-[var(--panel-soft)]">
            Balances are never guessed. Available money is confirmed inbound transfers to that
            worker&rsquo;s own account, minus their own withdrawals — and Aide only ever says a payment
            happened when the payment provider confirms it did.
          </p>
        </div>
      </section>

      {/* Close */}
      <section aria-labelledby="try" className="mx-auto max-w-5xl px-6 py-16 sm:px-10">
        <h2 id="try" className="max-w-[24ch] text-3xl font-bold tracking-tight sm:text-4xl">
          The fastest way to understand it is to talk to it.
        </h2>
        <p className="mt-4 max-w-[58ch] text-lg text-[var(--ink-soft)]">
          Aide starts listening the moment the page opens — there is no button to find first. Allow
          the microphone and say <em>&ldquo;find me work&rdquo;</em>. If you would rather not speak out loud,
          there is a text box under the circle that does the same thing.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex min-h-14 items-center rounded-lg bg-[var(--accent)] px-7 text-lg font-bold text-[var(--accent-ink)] underline-offset-4 hover:underline"
        >
          Talk to Aide
        </Link>
      </section>
    </main>
  );
}
