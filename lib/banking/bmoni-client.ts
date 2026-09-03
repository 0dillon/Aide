// The HTTP transport for BMONI Embedded. Everything about its shape comes from
// two facts about the API and one about who is listening.
//
// BMONI has NO idempotency keys. Create-user is guarded by a uniqueness check
// on email and phone, so a retry of one that already landed returns 409 naming
// the field — that is success from a previous attempt, not a failure. Wallet
// creation has no such guard: a blind retry makes a SECOND wallet. And a
// transfer has neither a guard nor a way to ask "did that land?", so a retry
// can pay a worker twice and an early abort can strand their wages.
//
// Hence the split. A read may time out and be retried, because giving up on a
// read costs one more request. A money-moving call gets no timeout and no
// retry, because giving up on it costs someone their wages. This is the same
// rule the Monnify adapter follows, for the same reason.

export type BmoniCall = {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
};

const READ_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;

function baseUrl(): string {
  return (process.env.BMONI_BASE_URL?.trim() || "https://embedded-dev.bmoni.com").replace(/\/$/, "");
}

// Lazy, like the key secret: importing this module must not break a build that
// runs with no secrets, but there is no default key to fall back to.
function apiKey(): string {
  const key = process.env.BMONI_API_KEY?.trim();
  if (!key) {
    throw new Error("Missing BMONI_API_KEY. It authenticates every Embedded API call; there is no default.");
  }
  return key;
}

export class BmoniError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "BmoniError";
  }

  // 409 on create-user means the earlier attempt succeeded. Callers recover the
  // existing record rather than treating it as a failure.
  get isConflict(): boolean {
    return this.status === 409;
  }

  // BMONI reports malformed-signature faults as 500 ("Point is not on curve",
  // "Invalid yParityOrV"). Those are OUR bug and will never succeed on retry,
  // so they must not be mistaken for a transient server error.
  get isClientFault(): boolean {
    return (
      this.status < 500 ||
      /point is not on curve|invalid yparityorv|current status does not allow/i.test(this.message)
    );
  }
}

// The error body comes in two shapes: `message` as a string, or as an array of
// field messages. The array is exhaustive, so joining it gives the caller every
// fault at once instead of one per round trip.
function describe(status: number, body: any): string {
  const m = body?.message;
  const detail = Array.isArray(m) ? m.join("; ") : typeof m === "string" ? m : body?.error;
  return detail ? `BMONI ${status}: ${detail}` : `BMONI ${status}`;
}

async function once(call: BmoniCall, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${baseUrl()}${call.path}`, {
    method: call.method ?? "GET",
    headers: {
      "x-api-key": apiKey(),
      ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
    signal,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from a money call is exactly when guessing is worst.
    throw new BmoniError(res.status, `BMONI ${res.status}: unreadable response body`, text);
  }
  if (!res.ok) throw new BmoniError(res.status, describe(res.status, parsed), parsed);
  // Successful payloads are wrapped in `data`.
  return (parsed as any)?.data ?? parsed;
}

// A read. May time out, and is retried on transport failure only — never on a
// response the server actually gave us, since that answer will not change.
export async function bmoniRead<T = any>(call: BmoniCall): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try {
      return (await once(call, AbortSignal.timeout(READ_TIMEOUT_MS))) as T;
    } catch (e) {
      last = e;
      // A real HTTP answer is final. Only transport faults are worth repeating.
      if (e instanceof BmoniError) throw e;
      if (attempt < READ_ATTEMPTS) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw last;
}

// A money-moving call. NO timeout and NO retry, deliberately.
//
// Monnify's disbursement endpoint takes no idempotency key and neither does
// this one. If it is slow, waiting is correct: an abort does not cancel what
// the server is doing, it only destroys our record of it. A caller that gets an
// error here must surface it, not repeat it — Aide says it could not confirm,
// which is honest, rather than sending twice.
export async function bmoniMove<T = any>(call: BmoniCall): Promise<T> {
  return (await once(call)) as T;
}
