"use client";

import { useCallback, useRef, useState } from "react";
import { useVoice } from "./useVoice";

type Msg = { role: "user" | "assistant"; content: string };
type State = {
  accountNumber?: string;
  bankName?: string;
  payoutAccountName?: string;
  applications: { id: string; jobId: string; status: string; verified: boolean; job?: { title: string; pay: number } }[];
  jobs: { id: string; title: string; pay: number; skill: string; employer: string }[];
};

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;

  const send = useCallback(async (text: string) => {
    const next = [...messagesRef.current, { role: "user" as const, content: text }];
    setMessages(next);
    setThinking(true);
    setError(null);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Aide had a problem.");
      setMessages([...next, { role: "assistant", content: data.reply }]);
      setState(data.state);
      speak(data.reply);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      speak("Sorry, something went wrong. " + msg);
    } finally {
      setThinking(false);
    }
  }, []);

  const { listening, interim, supported, listen, speak } = useVoice(send);

  const lastAide = [...messages].reverse().find((m) => m.role === "assistant")?.content;

  return (
    <main className="min-h-screen grid lg:grid-cols-[1.1fr_0.9fr]">
      {/* Voice side — the primary, screen-free surface */}
      <section className="flex flex-col items-center justify-center gap-10 p-8 lg:p-16">
        <div className="text-center max-w-md">
          <h1 className="text-5xl font-black tracking-tight">Aide</h1>
          <p className="mt-3 text-lg text-neutral-600">Find work, prove your skills, and get paid — just talk.</p>
        </div>

        <button
          onClick={listen}
          aria-label={listening ? "Listening" : "Tap and speak to Aide"}
          className="relative grid place-items-center w-44 h-44 rounded-full text-white text-xl font-bold shadow-xl transition-transform active:scale-95"
          style={{ background: listening ? "#c0392b" : "#1f6feb" }}
        >
          {listening && (
            <span className="absolute inset-0 rounded-full" style={{ background: "#c0392b", animation: "pulse-ring 1.4s ease-out infinite" }} />
          )}
          <span className="relative">{listening ? "Listening…" : thinking ? "Thinking…" : "Tap & speak"}</span>
        </button>

        <div className="min-h-[6rem] text-center max-w-lg">
          {interim && <p className="text-xl text-neutral-500 italic">“{interim}”</p>}
          {lastAide && !interim && <p className="text-2xl font-medium leading-snug">{lastAide}</p>}
          {!lastAide && !interim && <p className="text-neutral-400">Try: “Find me transcription jobs” or “What’s my balance?”</p>}
        </div>

        {!supported && <p className="text-red-600 max-w-md text-center">This browser has no speech recognition. Use Chrome, or type below.</p>}
        {error && <p className="text-red-600 max-w-md text-center text-sm">{error}</p>}

        <TypeFallback onSend={send} disabled={thinking} />
      </section>

      {/* Observer side — for sighted judges and low-vision users */}
      <aside className="bg-neutral-900 text-neutral-100 p-8 lg:p-12 flex flex-col gap-8">
        <h2 className="text-sm uppercase tracking-widest text-neutral-400">Live view</h2>

        <div>
          <p className="text-neutral-400 text-sm">Earnings account</p>
          <p className="text-2xl font-mono">{state?.accountNumber ? `${state.accountNumber} · ${state.bankName}` : "—"}</p>
        </div>

        <div>
          <p className="text-neutral-400 text-sm mb-2">Applications</p>
          {state?.applications?.length ? (
            <ul className="space-y-2">
              {state.applications.map((a) => (
                <li key={a.id} className="flex items-center justify-between border-b border-neutral-800 pb-2">
                  <span>{a.job?.title}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-800">
                    {a.verified ? "verified" : a.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-600">No applications yet.</p>
          )}
        </div>

        <div className="mt-auto">
          <p className="text-neutral-400 text-sm mb-2">Transcript</p>
          <div className="space-y-1 max-h-64 overflow-y-auto text-sm">
            {messages.map((m, i) => (
              <p key={i} className={m.role === "user" ? "text-blue-300" : "text-neutral-200"}>
                <span className="text-neutral-500">{m.role === "user" ? "You: " : "Aide: "}</span>
                {m.content}
              </p>
            ))}
          </div>
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
      className="flex gap-2 w-full max-w-lg"
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="…or type to Aide"
        className="flex-1 rounded-lg border border-neutral-300 px-4 py-3 bg-white"
        disabled={disabled}
      />
      <button type="submit" disabled={disabled} className="rounded-lg px-5 py-3 bg-neutral-900 text-white font-medium disabled:opacity-50">
        Send
      </button>
    </form>
  );
}
