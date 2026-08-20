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

// What separates one sentence from the next. Three forms, and the last two
// matter more than they look:
//   ". "  — the ordinary case.
//   ".A"  — no space at all. The SDK concatenates the text a model emits
//           before a tool call with the text it emits after, and the join has
//           no separator, giving "...for you.I found...". Left alone the
//           neural voice reads that period aloud as "dot", the way it would
//           in a domain name.
//   ".$"  — punctuation at the end of the buffer, nothing after it yet. This
//           is how a reply's opening line arrives: it is the last thing said
//           before the tool runs, so it has no trailing space and, without
//           this, sat unspoken until the tool came back. The opener exists
//           precisely to cover that pause, so waiting for the tool to finish
//           defeated the whole point and left the user in silence.
const SENTENCE_END = /[.!?…](\s+|(?=[A-Z"'“‘])|$)/;

// Pull complete sentences off the front of `buffer`. Refuses to break on
// list markers like "1." or fragments with no words yet (decimals, initials).
export function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  let searchFrom = 0;
  for (;;) {
    const m = SENTENCE_END.exec(rest.slice(searchFrom));
    if (!m) break;
    const punctAt = searchFrom + m.index; // index of the punctuation itself
    const sentence = rest.slice(0, punctAt + 1).trim();
    // The no-space form is the risky one: it is also what an initialism looks
    // like ("U.S.A"). Only trust it when a lowercase letter ends the word, as
    // it does in a real join like "you.I" but never in "U.S".
    const joinedNoSpace = m[1] === "" && punctAt + 1 < rest.length;
    if (joinedNoSpace && !/[a-z]/.test(rest[punctAt - 1] ?? "")) {
      searchFrom = punctAt + 1;
      continue;
    }
    if (/(^|\s)\d+[.!?…]$/.test(sentence) || sentence.replace(/[^a-zA-Z]/g, "").length < 3) {
      searchFrom = punctAt + 1; // a list marker or an initial — keep looking
      continue;
    }
    rest = rest.slice(punctAt + m[0].length);
    searchFrom = 0;
    sentences.push(sentence);
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
