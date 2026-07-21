"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

// The post-hire onboarding channel, on screen. It mirrors the voice channel
// (Aide's read_messages / send_message tools) exactly, so a sighted employer
// and a blind worker are looking at and hearing the same conversation.
//
// Reactive: useQuery on the Convex thread means a message the other party sends
// (by voice or by screen) appears here live. The list is a role="log" with
// aria-live="polite", so a screen reader announces each new message as it
// arrives without the user leaving the field.

type Message = {
  _id: string;
  jobId: string;
  from: "worker" | "employer";
  authorName: string;
  text: string;
  at: number;
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" });

export function MessageThread({ jobId, role }: { jobId: string; role: "worker" | "employer" }) {
  const messages = useQuery(api.messages.listForJob, { jobId }) as Message[] | undefined;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const listId = `thread-${jobId}`;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  const otherParty = role === "employer" ? "the worker you hired" : "the employer";
  const hint =
    role === "employer"
      ? "Send onboarding directives, credentials, or next steps. You can also say “Aide, message the worker…”."
      : "Reply or ask a question about the job. You can also say “Aide, read my messages” or “Aide, tell the employer…”.";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, text: body }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not send the message.");
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-label={`Onboarding messages with ${otherParty}`} className="mt-4 rounded-lg border-2 border-[var(--line)] bg-[var(--paper)] p-4">
      <h4 className="text-sm font-bold uppercase tracking-widest text-[var(--ink-soft)]">Onboarding messages</h4>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">{hint}</p>

      <div
        id={listId}
        role="log"
        aria-live="polite"
        aria-label="Message history"
        className="mt-3 max-h-64 space-y-3 overflow-y-auto"
      >
        {messages === undefined && <p className="text-[var(--ink-soft)]">Loading messages…</p>}
        {messages && messages.length === 0 && (
          <p className="text-[var(--ink-soft)]">No messages yet. Start the conversation below.</p>
        )}
        {messages?.map((m) => {
          const mine = m.from === role;
          return (
            <div key={m._id} className={mine ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-lg border-2 px-3 py-2 ${
                  mine ? "border-[var(--accent)] bg-white" : "border-[var(--line)] bg-white"
                }`}
              >
                <p className="text-xs font-bold text-[var(--ink-soft)]">
                  {mine ? "You" : m.authorName} · <span className="font-normal">{time(m.at)}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-lg leading-relaxed">{m.text}</p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {error && (
        <p role="alert" className="mt-3 font-bold text-[var(--alert)]">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`${listId}-input`} className="sr-only">
          Write a message to {otherParty}
        </label>
        <textarea
          id={`${listId}-input`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e);
            }
          }}
          rows={2}
          placeholder="Type a message…"
          className="min-h-12 flex-1 cursor-text rounded-lg border-2 border-[var(--line)] bg-white px-3 py-2 text-lg text-[var(--ink)]"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="min-h-12 cursor-pointer rounded-lg bg-[var(--accent)] px-6 py-3 text-lg font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
