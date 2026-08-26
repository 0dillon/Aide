// Aide speaks its errors. Anything that reaches `speak()` is heard, not read,
// by someone who cannot see a retry button — so raw runtime text is worse than
// useless. "The operation was aborted due to timeout" is what AbortSignal.timeout
// puts on a DOMException; "Failed to fetch" is what a dropped connection puts on
// a TypeError. Neither tells a listener anything they can act on.
//
// This is the last line of defence on the client, after the server has already
// mapped what it could. It is deliberately conservative: a message that is
// already a real sentence is passed through untouched, and only machine text is
// replaced.

const MACHINE_TEXT = [
  /operation was aborted/i,
  /\baborted\b/i,
  /failed to fetch/i,
  /networkerror/i,
  /load failed/i,
  /\bECONNREFUSED\b|\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b/i,
  /UND_ERR_/i,
  /\bDOMException\b|\bTypeError\b|\bSyntaxError\b/i,
  /unexpected token|is not valid json/i,
  /\b5\d\d\b|internal server error|bad gateway|service unavailable/i,
  /^server error/i,
  /status \d{3}/i,
];

const TIMEOUT_TEXT = /abort|timed? ?out|UND_ERR_CONNECT_TIMEOUT|deadline|ETIMEDOUT/i;
const OFFLINE_TEXT = /failed to fetch|networkerror|load failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|offline/i;

// Turn whatever was thrown into a sentence worth hearing. Returns null when the
// message is already fit to speak, so the caller can use it as-is.
export function spokenClientError(message: string): string {
  const raw = (message ?? "").trim();
  if (!raw) return "Something went wrong. Try again in a moment.";
  if (!MACHINE_TEXT.some((re) => re.test(raw))) return raw;

  if (OFFLINE_TEXT.test(raw)) {
    return "I lost my connection just then, so I could not finish. Check the internet and try again.";
  }
  if (TIMEOUT_TEXT.test(raw)) {
    return "That took too long to come back, so I stopped waiting. Try again in a moment.";
  }
  return "Something went wrong at my end, not with your account. Try again in a moment.";
}
