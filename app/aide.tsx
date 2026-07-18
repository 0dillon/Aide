"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// Aide lives here, globally. One always-on speech recognizer, one voice, one
// conversation — mounted in the root layout so Aide keeps listening and
// talking while the user (or Aide itself) moves between pages. Pages that
// need dictation (assessment answers, confirm words) borrow the mic with
// beginCapture/endCapture instead of opening a second recognizer, which
// browsers don't allow.

type Msg = { role: "user" | "assistant"; content: string };
type SR = any; // Web Speech API isn't in lib.dom

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

// One greeting per page load, even if React remounts the provider (dev
// strict mode does this).
let greetedThisLoad = false;

export function useAide() {
  const ctx = useContext(AideContext);
  if (!ctx) throw new Error("useAide must be used inside <AideProvider>");
  return ctx;
}

export function AideProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const [listening, setListeningState] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [supported, setSupported] = useState(true);
  const [interim, setInterim] = useState("");
  const [micStatus, setMicStatus] = useState("starting…");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);

  const recRef = useRef<SR | null>(null);
  const activeRef = useRef(false);
  const speakingRef = useRef(false);
  const thinkingRef = useRef(false);
  const captureRef = useRef<((t: string) => void) | null>(null);
  const currentUtterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const pendingSpeechRef = useRef<string | null>(null);
  const speechEndedAtRef = useRef(0);
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;

  // Restart bookkeeping: recognizers die (silence timeouts, network hiccups,
  // our own pauses) and must come back — but a recognizer that dies instantly,
  // over and over, needs backoff, not a hot loop.
  const lastStartRef = useRef(0);
  const rapidEndsRef = useRef(0);
  const restartDelayRef = useRef(300);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const router = useRouter();
  const pathname = usePathname();

  // The orb shouldn't flicker every time the recognizer blips through a
  // restart: turning "listening" on is instant, turning it off waits 800ms.
  const setListening = useCallback((on: boolean) => {
    if (listenOffTimerRef.current) clearTimeout(listenOffTimerRef.current);
    if (on) setListeningState(true);
    else listenOffTimerRef.current = setTimeout(() => setListeningState(false), 800);
  }, []);

  const startRecognitionRef = useRef<() => void>(() => {});

  // Create a FRESH recognizer each time — Chrome instances can wedge after
  // abort, and a new one is the reliable way back to a working mic.
  const startRecognition = useCallback(() => {
    if (!activeRef.current || speakingRef.current || typeof window === "undefined") return;
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;

    const old = recRef.current;
    if (old) {
      old.onresult = null;
      old.onend = null;
      old.onerror = null;
      try {
        old.abort();
      } catch {}
    }

    const rec: SR = new Ctor();
    rec.lang = "en-NG";
    rec.interimResults = true;
    rec.continuous = true;

    // Lifecycle diagnostics: these pinpoint WHERE hearing breaks — mic never
    // opens, opens but no sound (wrong input device), sound but no speech
    // recognized (service problem), or full success.
    rec.onaudiostart = () => {
      console.info("Aide mic: audio capture started");
      setMicStatus("mic open — no sound detected yet");
    };
    rec.onsoundstart = () => {
      console.info("Aide mic: sound detected");
      setMicStatus("hearing sound");
    };
    rec.onspeechstart = () => {
      console.info("Aide mic: speech detected");
      setMicStatus("hearing speech…");
    };

    rec.onresult = (e: any) => {
      setMicStatus("recognizing speech");
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      setInterim(interimText);
      const clean = finalText.trim();
      // Ignore anything heard while Aide talks (or its immediate echo tail).
      if (!clean || speakingRef.current || Date.now() - speechEndedAtRef.current < 400) return;
      rapidEndsRef.current = 0;
      setInterim("");
      if (captureRef.current) captureRef.current(clean);
      else if (!thinkingRef.current) sendRef.current(clean);
    };

    rec.onend = () => {
      if (recRef.current !== rec) return; // superseded by a newer instance
      const aliveMs = Date.now() - lastStartRef.current;
      console.info(`Aide mic: recognizer ended after ${aliveMs}ms`);
      setListening(false);
      if (!activeRef.current || speakingRef.current) return;
      // Instant deaths mean something is wrong (usually no internet — Chrome's
      // recognizer needs it). Back off instead of hot-looping.
      if (aliveMs < 1000) {
        rapidEndsRef.current += 1;
        restartDelayRef.current = Math.min(restartDelayRef.current * 2, 4000);
        if (rapidEndsRef.current === 5) {
          setError("Aide's hearing keeps cutting out. Speech recognition in Chrome needs an internet connection — retrying.");
        }
      } else {
        rapidEndsRef.current = 0;
        restartDelayRef.current = 300;
      }
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => startRecognitionRef.current(), restartDelayRef.current);
    };

    rec.onerror = (e: any) => {
      // "no-speech" / "aborted" are routine; onend does the restart.
      if (e?.error === "no-speech") {
        setMicStatus("mic open, but no speech was heard (check the input device)");
      } else if (e?.error && e.error !== "aborted") {
        console.warn("Aide speech recognition error:", e.error);
        setMicStatus(`recognition error: ${e.error}`);
      }
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        activeRef.current = false;
        setActive(false);
        setError("Microphone access was blocked. Allow the microphone so Aide can hear you.");
      }
    };

    recRef.current = rec;
    try {
      rec.start();
      lastStartRef.current = Date.now();
      setListening(true);
      setMicStatus("mic starting…");
    } catch {
      /* already starting */
    }
  }, [setListening]);
  startRecognitionRef.current = startRecognition;

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      // Pause the mic while Aide talks so it doesn't hear itself.
      speakingRef.current = true;
      setSpeaking(true);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      recRef.current?.abort();
      setListening(false);

      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-NG";
      // Mark this utterance as the current one BEFORE cancel(): the canceled
      // utterance's own end/error handlers must not resume the mic while this
      // new one is talking.
      currentUtterRef.current = u;
      window.speechSynthesis.cancel();

      // Watchdogs: on machines with no TTS voices (common on Linux), the
      // utterance never starts and never errors — without these, the mic
      // would stay paused forever waiting for a speech that never ends.
      let ttsStarted = false;
      let startWatchdog: ReturnType<typeof setTimeout> | null = null;
      let runawayWatchdog: ReturnType<typeof setTimeout> | null = null;

      const resume = () => {
        if (startWatchdog) clearTimeout(startWatchdog);
        if (runawayWatchdog) clearTimeout(runawayWatchdog);
        if (currentUtterRef.current !== u) return; // superseded
        currentUtterRef.current = null;
        speakingRef.current = false;
        setSpeaking(false);
        speechEndedAtRef.current = Date.now();
        if (activeRef.current) startRecognition();
      };

      u.onstart = () => {
        ttsStarted = true;
      };
      u.onend = resume;
      u.onerror = (ev: any) => {
        // Chrome blocks speech before the first user interaction. Stash the
        // text; a document-level listener replays it on the first touch or
        // keypress — no visible gate, nothing the user has to find.
        if (ev?.error === "not-allowed") pendingSpeechRef.current = text;
        resume();
      };

      startWatchdog = setTimeout(() => {
        if (!ttsStarted && currentUtterRef.current === u) {
          console.warn("Aide TTS never started — no speech voices available? Resuming the mic.");
          setError("Aide can't speak aloud in this browser (no speech voices found) — it can still hear you and show replies as text.");
          window.speechSynthesis.cancel();
          resume();
        }
      }, 2500);
      // Generous per-text cap in case onend never fires mid-speech.
      runawayWatchdog = setTimeout(() => {
        if (currentUtterRef.current === u) {
          window.speechSynthesis.cancel();
          resume();
        }
      }, 10000 + text.length * 90);

      window.speechSynthesis.speak(u);
    },
    [setListening, startRecognition],
  );

  const send = useCallback(
    async (text: string) => {
      const next = [...messagesRef.current, { role: "user" as const, content: text }];
      setMessages(next);
      setThinking(true);
      thinkingRef.current = true;
      setError(null);
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.reply) throw new Error(data?.error || `Aide had a problem (status ${res.status}).`);
        setMessages([...next, { role: "assistant", content: data.reply }]);
        speak(data.reply);
        if (data.navigateTo) router.push(data.navigateTo);
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
    if (typeof window === "undefined") return;
    const hasSR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!hasSR) {
      setSupported(false);
      return;
    }
    activeRef.current = true;
    setActive(true);
    startRecognition();

    // Greet with real state: pending assessments, money to withdraw, jobs.
    if (!greetedThisLoad) {
      greetedThisLoad = true;
      fetch("/api/greeting")
        .then((res) => res.json())
        .catch(() => null)
        .then((data) => {
          const greeting = data?.greeting || "Hello, I'm Aide. I'm listening — just talk to me.";
          setMessages((m) => [...m, { role: "assistant", content: greeting }]);
          speak(greeting);
        });
    }

    return () => {
      activeRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (listenOffTimerRef.current) clearTimeout(listenOffTimerRef.current);
      const rec = recRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onend = null;
        rec.onerror = null;
        try {
          rec.abort();
        } catch {}
      }
    };
  }, [speak, startRecognition]);

  // Replay speech the browser blocked before first interaction.
  useEffect(() => {
    const unlock = () => {
      const pending = pendingSpeechRef.current;
      if (pending) {
        pendingSpeechRef.current = null;
        speak(pending);
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [speak]);

  // Tap Aide while it talks to cut it off and be heard immediately.
  const interrupt = useCallback(() => {
    currentUtterRef.current = null;
    window.speechSynthesis?.cancel();
    speakingRef.current = false;
    setSpeaking(false);
    speechEndedAtRef.current = Date.now();
    if (activeRef.current) startRecognition();
  }, [startRecognition]);

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
        active,
        listening,
        speaking,
        thinking,
        capturing,
        supported,
        interim,
        micStatus,
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
