// Client for the streaming /api/agent endpoint (NDJSON: delta / done / error
// events) plus the sentence splitter that decides when a chunk of streamed
// text is ready to be spoken aloud.

export type Msg = { role: "user" | "assistant"; content: string };

export type AgentStreamResult = {
  loggedOut?: boolean;
  full: string;
  navigateTo?: string;
  newUserId?: string;
};

export type AgentStreamHandlers = {
  // The reply so far — called on every delta for live transcript updates.
  onDelta: (full: string) => void;
  // A completed sentence, ready to be spoken while the rest still streams.
  onSentence: (sentence: string) => void;
};

// Pull complete sentences off the front of `buffer`. Refuses to break on
// list markers like "1." or fragments with no words yet (decimals, initials).
export function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  let m: RegExpExecArray | null;
  let searchFrom = 0;
  while ((m = /[.!?…]\s+/.exec(rest.slice(searchFrom)))) {
    const end = searchFrom + m.index + 1;
    const sentence = rest.slice(0, end).trim();
    if (/(^|\s)\d+[.!?…]$/.test(sentence) || sentence.replace(/[^a-zA-Z]/g, "").length < 3) {
      searchFrom = end + m[0].length - 1;
      continue;
    }
    rest = rest.slice(searchFrom + m.index + m[0].length);
    searchFrom = 0;
    if (sentence) sentences.push(sentence);
  }
  return { sentences, rest };
}

export async function streamAgentReply(messages: Msg[], handlers: AgentStreamHandlers): Promise<AgentStreamResult> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Aide had a problem (status ${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  let full = "";
  let unspoken = "";
  const result: AgentStreamResult = { full: "" };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    if (ev.t === "delta") {
      full += ev.text;
      unspoken += ev.text;
      handlers.onDelta(full);
      const { sentences, rest } = extractSentences(unspoken);
      unspoken = rest;
      for (const s of sentences) handlers.onSentence(s);
    } else if (ev.t === "done") {
      result.navigateTo = ev.navigateTo;
      result.newUserId = ev.newUserId;
      result.loggedOut = ev.loggedOut;
    } else if (ev.t === "error") {
      throw new Error(ev.message || "Aide had a problem.");
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
    }
    if (done) break;
  }
  handleLine(lineBuf);
  if (unspoken.trim()) handlers.onSentence(unspoken.trim());

  if (!full.trim()) throw new Error("Aide had a problem — no reply arrived.");
  result.full = full;
  return result;
}
