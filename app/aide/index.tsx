"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
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
  dormant: boolean;
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

// The conversation survives a reload. Without this, refreshing wiped the
// transcript AND the context the model is given, so Aide forgot everything
// mid-task and greeted the user from scratch — punishing on a screen you
// cannot see. Session storage keeps it to this tab and clears when it closes.
const TRANSCRIPT_KEY = "aide-transcript";
const MAX_SAVED = 40;

function loadTranscript(): Msg[] {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((m) => m?.role && typeof m.content === "string") : [];
  } catch {
    return [];
  }
}

// ONE engine per page, ever. React strict mode mounts effects twice in
// development, and a second engine means two recognizers fighting for the mic
// and two voices talking over each other — with the orphaned one impossible to
// silence, because nothing holds a reference to it any more.
let sharedEngine: VoiceEngine | null = null;

export function AideProvider({ children }: { children: React.ReactNode }) {
  const [voice, setVoice] = useState<VoiceState>({
    active: false,
    listening: false,
    speaking: false,
    dormant: false,
    interim: "",
    micStatus: "starting…",
    error: null,
  });
  const [thinking, setThinking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  // This browser's account id, used to subscribe to its own reactive event feed.
  const [accountId, setAccountId] = useState<string | null>(null);

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
      // Hold the speaking turn open for the whole reply: sentences arrive from
      // the model slower than Aide speaks them, and without this the turn ends
      // at the first lull and the rest lands seconds later as a new utterance.
      engineRef.current?.beginReply();
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
          setAccountId(result.newUserId);
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
        engineRef.current?.endReply();
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
      // Recognition is unavailable, but Aide can still SPEAK — say the way
      // forward instead of leaving a blind user in silence. The message is
      // queued until the first tap/keypress (autoplay is blocked until then),
      // which enableSpeechOnly's unlock listeners handle. Typed messages still
      // get spoken replies, since send() speaks through this same engine.
      const speaker = new VoiceEngine({
        onState: (patch) => {
          setVoice((v) => ({ ...v, ...patch }));
          if (patch.error !== undefined) setError(patch.error);
        },
        onFinal: () => {},
      });
      engineRef.current = speaker;
      speaker.enableSpeechOnly();
      const guide =
        "Welcome to Aide. This browser cannot hear your voice. To talk to me, please open this page in Google Chrome. Otherwise, type your message in the box on the screen and I will still help you.";
      setMessages((m) => [...m, { role: "assistant", content: guide }]);
      speaker.speak(guide);
      return () => {
        speaker.stop();
        if (engineRef.current === speaker) engineRef.current = null;
      };
    }

    // Reuse the existing engine across remounts rather than starting a rival.
    const engine =
      sharedEngine ??
      (sharedEngine = new VoiceEngine({
        onState: (patch) => {
          setVoice((v) => ({ ...v, ...patch }));
          if (patch.error !== undefined) setError(patch.error);
        },
        onFinal: (text) => {
          if (captureRef.current) captureRef.current(text);
          else if (!thinkingRef.current) sendRef.current(text);
        },
      }));
    engineRef.current = engine;
    engine.start();

    if (!greetedThisLoad) {
      greetedThisLoad = true;
      const previous = loadTranscript();

      if (previous.length > 0) {
        // Coming back to an existing conversation: restore it so the model
        // still has the context, and say something short instead of running
        // through the full introduction again.
        setMessages(previous);
        engine.speak("Welcome back. I still have our conversation — carry on.");
      } else {
        // Greet with real state: pending assessments, money to withdraw, jobs.
        fetch("/api/greeting")
          .then((res) => res.json())
          .catch(() => null)
          .then((data) => {
            const base = data?.greeting || "Hello, I'm Aide. I'm listening — just talk to me.";
            const greeting = `${base} By the way, you can stop me any time — just tap the screen or press any key.`;
            setMessages((m) => [...m, { role: "assistant", content: greeting }]);
            engine.speak(greeting);
          });
      }
    }

    return () => {
      engine.stop();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, []);

  // Aide announces confirmed money the moment it lands, without being asked —
  // the voice equivalent of a bank alert. Delivery is reactive via Convex (see
  // PaymentAlerts below); this is just what to say when an event arrives.
  const handleAideEvent = useCallback(
    (e: { type: string; amount?: number; from?: string; message?: string }) => {
      if (e.type === "payment") {
        const line = `Good news — ${e.amount} naira just landed in your account from ${e.from}. Say balance any time to hear your new total.`;
        setMessages((m) => [...m, { role: "assistant", content: line }]);
        speak(line);
      } else if (e.type === "notify" && typeof e.message === "string") {
        // Hiring decisions, and anything else the server wants said aloud.
        const message = e.message;
        setMessages((m) => [...m, { role: "assistant", content: message }]);
        speak(message);
      }
    },
    [speak],
  );

  // Keep the saved transcript in step with what's on screen, capped so a long
  // session can't outgrow the storage quota.
  useEffect(() => {
    if (messages.length === 0) return;
    try {
      sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(messages.slice(-MAX_SAVED)));
    } catch {
      /* private mode or quota — the conversation just won't survive a reload */
    }
  }, [messages]);

  // Learn this browser's account id on mount (and, server-side, start the local
  // payment poller). The id drives the reactive event subscription.
  useEffect(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((d) => {
        if (d?.id) setAccountId(d.id);
      })
      .catch(() => {});
  }, []);

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
        dormant: voice.dormant,
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
      {accountId && <PaymentAlerts accountId={accountId} onEvent={handleAideEvent} />}
      {workerScreen && pathname !== "/" && <MiniAide />}
    </AideContext.Provider>
  );
}

// Reactive money alerts: subscribes to this account's Convex event feed and
// speaks each new confirmed payment (or server notification) exactly once. The
// `since` mount-time cutoff keeps page history from being re-announced on
// reload; `seen` guards against reactive re-delivery within a session.
function PaymentAlerts({
  accountId,
  onEvent,
}: {
  accountId: string;
  onEvent: (e: { type: string; amount?: number; from?: string; message?: string }) => void;
}) {
  const since = useRef(Date.now());
  const seen = useRef<Set<string>>(new Set());
  const events = useQuery(api.events.forAccount, { accountId, since: since.current });

  useEffect(() => {
    if (!events) return;
    for (const e of events) {
      if (seen.current.has(e._id)) continue;
      seen.current.add(e._id);
      onEvent(e);
    }
  }, [events, onEvent]);

  return null;
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
