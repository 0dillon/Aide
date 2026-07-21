"use client";

import { useEffect, useRef, useState } from "react";
import { useAide } from "./aide";

// Live input level straight from getUserMedia — separate from speech
// recognition, so it shows whether the microphone is delivering ANY audio.
// If this stays at zero while the user talks, Chrome is capturing the wrong
// (or a muted) input device.
function MicMeter({ dormant }: { dormant: boolean }) {
  const [level, setLevel] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // When Aide has stopped listening, this must let go of the microphone too.
    // Otherwise the meter keeps its own capture stream open, the browser's
    // recording indicator stays lit, and "Aide stopped listening" is a lie.
    if (dormant) {
      setLevel(null);
      return;
    }
    let raf = 0;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        stream = s;
        audioCtx = new AudioContext();
        const src = audioCtx.createMediaStreamSource(s);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          setLevel(Math.min(100, Math.round((peak / 128) * 200)));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setFailed(true));
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
  }, [dormant]);

  if (failed) return <p className="text-sm font-bold text-[var(--alert)]">Mic check: could not open the microphone.</p>;
  if (level === null) return null;
  return (
    <div className="w-full max-w-sm">
      <div className="h-3 w-full rounded-full border-2 border-[var(--line)] bg-white" aria-hidden="true">
        <div
          className="h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${level}%`, transition: "width 80ms linear" }}
        />
      </div>
    </div>
  );
}

// Aide's home: two halves. Left — Aide itself, always listening, glowing
// while it speaks. Right — the running transcript of this session.
export default function AidePage() {
  const { active, listening, speaking, dormant, thinking, supported, interim, micStatus, error, messages, send, interrupt } = useAide();
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, interim]);

  const status = dormant
    ? "Asleep"
    : speaking
    ? "Speaking…"
    : thinking
      ? "Thinking…"
      : listening
        ? "Listening"
        : active
          ? "Waking up…"
          : "Off";

  return (
    <main id="main" className="grid min-h-[calc(100vh-4rem)] grid-cols-1 lg:grid-cols-2">
      {/* Left half — Aide, glowing while it speaks. min-w-0 lets the grid
          track shrink to the viewport instead of blowing out on narrow phones. */}
      <section aria-label="Talk to Aide" className="flex min-w-0 flex-col items-center justify-center gap-8 p-5 sm:p-8 lg:p-14">
        <div className="max-w-md text-center">
          <h1 className="text-5xl font-bold tracking-tight">Aide</h1>
          <p className="mt-3 text-lg text-[var(--ink-soft)]">Always listening. Find work, prove your skills, get paid — just talk.</p>
        </div>

        <button
          onClick={interrupt}
          aria-label={
            dormant
              ? "Aide has stopped listening. Tap to wake it."
              : `Aide is ${status.toLowerCase().replace("…", "")}. Tap to interrupt Aide and speak.`
          }
          className={`relative grid h-48 w-48 place-items-center rounded-full bg-[var(--accent)] text-xl font-bold text-white shadow-xl transition-transform active:scale-95 ${
            speaking ? "aide-speaking" : ""
          }`}
        >
          {listening && !speaking && (
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full"
              style={{ background: "var(--accent)", animation: "pulse-ring 2.2s ease-out infinite" }}
            />
          )}
          <span className="relative">{status}</span>
        </button>

        <p aria-live="polite" className="min-h-6 text-lg font-bold text-[var(--ink-soft)]">
          {dormant ? "Aide stopped listening — tap anywhere to wake it" : speaking ? "Aide is speaking — tap anywhere to stop" : thinking ? "Aide is thinking" : listening ? "Aide is listening — just talk" : ""}
        </p>

        <div className="min-h-16 max-w-lg text-center">
          {interim && <p className="text-xl italic text-[var(--ink-soft)]">“{interim}”</p>}
          {!interim && messages.length === 0 && (
            <p className="text-[var(--ink-soft)]">Try: “Find me transcription jobs” or “What’s my balance?”</p>
          )}
        </div>

        {!supported && (
          <p className="max-w-md text-center font-bold text-[var(--alert)]">
            This browser has no speech recognition. Use Chrome, or type below.
          </p>
        )}
        {error && <p className="max-w-md text-center text-[var(--alert)]">Error: {error}</p>}
        {micStatus && <p className="max-w-md text-center text-sm text-[var(--ink-soft)]">Mic: {micStatus}</p>}

        <MicMeter dormant={dormant} />

        <TypeFallback onSend={send} disabled={thinking} />
      </section>

      {/* Right half — the session transcript */}
      <aside aria-label="Conversation transcript" className="dark-surface flex min-w-0 flex-col bg-[var(--panel)] p-5 text-[var(--panel-ink)] sm:p-8 lg:p-12">
        <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--panel-soft)]">Transcript</h2>
        <div ref={logRef} role="log" className="mt-4 flex-1 space-y-4 overflow-y-auto pr-2" style={{ maxHeight: "calc(100vh - 12rem)" }}>
          {messages.length === 0 && <p className="text-[var(--panel-soft)]">Your conversation with Aide will appear here.</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "assistant" ? "border-l-4 border-[var(--glow)] pl-3" : "pl-3"}>
              <p className="text-sm font-bold text-[var(--panel-soft)]">{m.role === "user" ? "You said" : "Aide said"}</p>
              <p className="text-lg leading-relaxed break-words">{m.content}</p>
            </div>
          ))}
          {thinking && <p className="pl-3 italic text-[var(--panel-soft)]">Aide is thinking…</p>}
        </div>
      </aside>
    </main>
  );
}

function TypeFallback({ onSend, disabled }: { onSend: (t: string) => void; disabled: boolean }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) {
          onSend(v.trim());
          setV("");
        }
      }}
      className="flex w-full max-w-lg gap-2"
    >
      <label htmlFor="type-to-aide" className="sr-only">
        Type a message to Aide
      </label>
      <input
        id="type-to-aide"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="…or type to Aide"
        className="min-h-12 flex-1 rounded-lg border-2 border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)]"
        disabled={disabled}
      />
      <button
        type="submit"
        disabled={disabled}
        className="min-h-12 rounded-lg bg-[var(--ink)] px-5 py-3 font-bold text-[var(--paper)] disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}
