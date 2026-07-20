"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { VoiceEngine, type VoiceState } from "./voice-engine";
import { streamAgentReply, type Msg } from "./agent-stream";

// Aide lives here, globally. One always-on voice engine, one conversation —
// mounted in the root layout so Aide keeps listening and talking while the
// user (or Aide itself) moves between pages. Pages that need dictation
// (assessment answers, confirm words) borrow the mic with beginCapture/
// endCapture instead of opening a second recognizer, which browsers don't
// allow. The mic/TTS machinery itself lives in ./voice-engine.ts; the
// streaming agent client in ./agent-stream.ts.

type AideContextValue = {
  active: boolean;
  listening: boolean;
  speaking: boolean;
  thinking: boolean;
  capturing: boolean;
  supported: boolean;
  interim: string;
  micStatus: string;
  error: string | null;
  messages: Msg[];
  send: (text: string) => void;
  speak: (text: string) => void;
  interrupt: () => void;
  beginCapture: (onText: (t: string) => void) => void;
  endCapture: () => void;
};

const AideContext = createContext<AideContextValue | null>(null);

export function useAide() {
  const ctx = useContext(AideContext);
  if (!ctx) throw new Error("useAide must be used inside <AideProvider>");
  return ctx;
}

// One greeting per page load, even if React remounts the provider (dev
// strict mode does this).
let greetedThisLoad = false;

export function AideProvider({ children }: { children: React.ReactNode }) {
  const [voice, setVoice] = useState<VoiceState>({
    active: false,
    listening: false,
    speaking: false,
    interim: "",
    micStatus: "starting…",
    error: null,
  });
  const [thinking, setThinking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);

  const engineRef = useRef<VoiceEngine | null>(null);
  const thinkingRef = useRef(false);
  const captureRef = useRef<((t: string) => void) | null>(null);
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;

  const router = useRouter();
  const pathname = usePathname();

  const speak = useCallback((text: string) => engineRef.current?.speak(text), []);
  const interrupt = useCallback(() => engineRef.current?.interrupt(), []);

  const send = useCallback(
    async (text: string) => {
      const next = [...messagesRef.current, { role: "user" as const, content: text }];
      setMessages(next);
      setThinking(true);
      thinkingRef.current = true;
      setError(null);
      try {
        const result = await streamAgentReply(next, {
          onDelta: (full) => setMessages([...next, { role: "assistant", content: full }]),
          onSentence: (s) => engineRef.current?.queueSpeak(s),
        });

        if (result.newUserId) {
          // A streaming response can't set cookies after it starts — sign the
          // browser in now, and start a fresh transcript for the new identity.
          await fetch("/api/account/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: result.newUserId }),
          }).catch(() => {});
          setMessages([{ role: "assistant", content: result.full }]);
        }
        if (result.navigateTo) {
          router.push(result.navigateTo);
          // Follow Aide's words: scroll to the section it is talking about.
          const hash = result.navigateTo.split("#")[1];
          if (hash) {
            setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 700);
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        speak("Sorry, something went wrong. " + msg);
      } finally {
        setThinking(false);
        thinkingRef.current = false;
      }
    },
    [router, speak],
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  // Aide wakes up the moment the platform loads — no tap, no gate. The
  // browser shows its own mic-permission prompt on first ever visit; after
  // that, startup is fully hands-free.
  useEffect(() => {
    if (!VoiceEngine.supported()) {
      setSupported(false);
      return;
    }

    const engine = new VoiceEngine({
      onState: (patch) => {
        setVoice((v) => ({ ...v, ...patch }));
        if (patch.error !== undefined) setError(patch.error);
      },
      onFinal: (text) => {
        if (captureRef.current) captureRef.current(text);
        else if (!thinkingRef.current) sendRef.current(text);
      },
    });
    engineRef.current = engine;
    engine.start();

    // Greet with real state: pending assessments, money to withdraw, jobs.
    if (!greetedThisLoad) {
      greetedThisLoad = true;
      fetch("/api/greeting")
        .then((res) => res.json())
        .catch(() => null)
        .then((data) => {
          const base = data?.greeting || "Hello, I'm Aide. I'm listening — just talk to me.";
          const greeting = `${base} By the way, you can interrupt me any time by saying: aide, stop talking.`;
          setMessages((m) => [...m, { role: "assistant", content: greeting }]);
          engine.speak(greeting);
        });
    }

    return () => {
      engine.stop();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, []);

  // Live events from the server: Aide announces confirmed money the moment
  // it lands, without being asked — the voice equivalent of a bank alert.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data);
        if (e.type === "payment") {
          const line = `Good news — ${e.amount} naira just landed in your account from ${e.from}. Say balance any time to hear your new total.`;
          setMessages((m) => [...m, { role: "assistant", content: line }]);
          speak(line);
        } else if (e.type === "notify" && typeof e.message === "string") {
          // Hiring decisions, and anything else the server wants said aloud.
          setMessages((m) => [...m, { role: "assistant", content: e.message }]);
          speak(e.message);
        }
      } catch {}
    };
    return () => es.close();
  }, [speak]);

  const beginCapture = useCallback((onText: (t: string) => void) => {
    captureRef.current = onText;
    setCapturing(true);
  }, []);
  const endCapture = useCallback(() => {
    captureRef.current = null;
    setCapturing(false);
  }, []);

  const workerScreen = !pathname.startsWith("/employer");

  return (
    <AideContext.Provider
      value={{
        active: voice.active,
        listening: voice.listening,
        speaking: voice.speaking,
        thinking,
        capturing,
        supported,
        interim: voice.interim,
        micStatus: voice.micStatus,
        error,
        messages,
        send,
        speak,
        interrupt,
        beginCapture,
        endCapture,
      }}
    >
      {children}
      {workerScreen && pathname !== "/" && <MiniAide />}
    </AideContext.Provider>
  );
}

// The small Aide that follows the user onto every other screen. It glows
// while talking and pulses while listening; tapping it interrupts Aide.
function MiniAide() {
  const { listening, speaking, thinking, capturing, interim, messages, interrupt } = useAide();
  const lastAide = [...messages].reverse().find((m) => m.role === "assistant")?.content;
  const status = speaking
    ? "Aide is speaking"
    : thinking
      ? "Aide is thinking"
      : capturing
        ? "Aide is writing down what you say"
        : listening
          ? "Aide is listening"
          : "Aide is paused";

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2">
      {(interim || lastAide) && (
        <div className="dark-surface max-w-xs rounded-xl bg-[var(--panel)] px-4 py-3 text-[var(--panel-ink)] shadow-xl">
          {interim ? <p className="italic">“{interim}”</p> : <p className="line-clamp-3">{lastAide}</p>}
        </div>
      )}
      <button
        onClick={interrupt}
        aria-label={`${status}. Tap to interrupt Aide and speak.`}
        className={`relative grid h-20 w-20 place-items-center rounded-full bg-[var(--accent)] font-bold text-white shadow-xl ${
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
        <span className="relative">Aide</span>
      </button>
      <p aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}
