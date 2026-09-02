import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export const runtime = "nodejs";

// Neural speech via Microsoft Edge's neural voices, reached through Python's
// edge_tts library instead of Node. The Node ws-based npm package (msedge-tts)
// gets a 403 at the WebSocket handshake — Microsoft blocks that client's
// fingerprint — but Python's aiohttp-based edge_tts is not blocked. Cloud
// alternatives (Azure Speech, Google Cloud TTS) were ruled out by signup
// friction (Azure AD access_denied, Google requires a non-prepaid card).
//
// The connection handshake to Microsoft's server is itself slow (~5-6s cold,
// ~2.5-3s warm — measured directly, not a Node overhead artifact). Spawning
// a fresh Python interpreter per utterance paid that cold cost on every
// single reply. Instead we keep ONE long-lived Python worker process (see
// scripts/tts_worker.py) alive for the server's whole lifetime, so only the
// very first utterance after boot pays the cold-start price.
// en-NG-EzinneNeural (female) / en-NG-AbeoNeural (male) are the only two
// Nigerian English neural voices in the catalog; override with EDGE_TTS_VOICE.
const VOICE = process.env.EDGE_TTS_VOICE || "en-NG-EzinneNeural";
// Debian/Ubuntu ship only `python3`; other setups only `python`. Probe once.
const PYTHON_BIN =
  process.env.PYTHON_BIN ||
  ["python3", "python"].find((bin) => {
    try {
      return spawnSync(bin, ["--version"]).status === 0;
    } catch {
      return false;
    }
  }) ||
  "python3";
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "tts_worker.py");

// Per-request deadline once the worker has a request in flight. Generous,
// because a cold worker's first request can take 6s+; a wedged worker is
// killed and respawned rather than left to hang future requests forever.
const REQUEST_TIMEOUT_MS = 30000;
// A worker that dies is recoverable — a request is only text — so pending work
// is replayed on a fresh process rather than failed. This caps the replaying,
// so a process that dies instantly every time cannot spin forever.
const MAX_ATTEMPTS = 2;

const audioCache = new Map<string, Buffer>();
const CACHE_MAX = 100;

// Circuit breaker: if Python/edge_tts is unavailable or Microsoft blocks
// this path too, fail instantly for a cooldown window instead of making
// every reply sit through a repeated multi-second failure before the client
// falls back to the browser voice.
const BREAKER_COOLDOWN_MS = 30_000;
let breakerOpenUntil = 0;

type PendingRequest = {
  text: string;
  voice: string;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  attempts: number;
};

let worker: ChildProcessWithoutNullStreams | null = null;
let queue: PendingRequest[] = [];
let frontTimer: ReturnType<typeof setTimeout> | null = null;
// Incoming stdout bytes for the request currently at the front of the queue.
let recvBuf: Buffer = Buffer.alloc(0);
let expectedLen: number | null = null;

// The deadline belongs to the request the worker is actually SYNTHESIZING, not
// to everything queued behind it. Starting the clock at enqueue meant a queued
// request burned its whole budget waiting its turn: six warm-up phrases against
// one serial worker was enough for the last few to time out having never been
// touched, which killed the worker and took the greeting down with it, leaving
// the browser to fall back to its robotic voice.
// Set when the deadline expires, so the drain below knows the front request is
// the one thing here that has PROVEN it cannot be synthesized. Replaying it
// put the poison sentence straight back at the head of a fresh serial worker,
// where it burned a second full deadline with all the healthy work stuck behind
// it — a minute of dead air instead of thirty seconds.
let frontTimedOut = false;

function armFrontTimeout() {
  if (frontTimer) clearTimeout(frontTimer);
  frontTimer = null;
  if (queue.length === 0) return;
  frontTimer = setTimeout(() => {
    frontTimer = null;
    const proc = worker;
    if (!proc) {
      // The process this queue was waiting on is already gone and took no
      // 'exit' with it. Nothing is coming, so settle the work rather than
      // leaving the promises — and the HTTP responses behind them — hanging.
      drainAfterWorkerLoss();
      return;
    }
    // Genuinely wedged: kill it so the next request gets a fresh process.
    frontTimedOut = true;
    proc.kill();
    if (worker === proc) worker = null;
  }, REQUEST_TIMEOUT_MS);
}

// Everything a lost worker leaves behind: a deadline with nothing to enforce it
// against, and a queue of work nobody is going to finish.
//
// A request is only text, so untried work is replayed on a fresh process rather
// than failed — the alternative is a user hearing Aide drop to the robotic
// fallback voice partway through a reply, seemingly at random.
function drainAfterWorkerLoss(): void {
  if (frontTimer) clearTimeout(frontTimer);
  frontTimer = null;
  const pending = queue;
  queue = [];
  // The request that burned the deadline does not get another one.
  const poisoned = frontTimedOut ? pending.shift() : undefined;
  frontTimedOut = false;
  poisoned?.reject(new Error("edge_tts timed out synthesizing this sentence"));
  for (const req of pending) {
    if (req.attempts + 1 < MAX_ATTEMPTS) {
      req.attempts += 1;
      dispatch(req);
    } else {
      req.reject(new Error("edge_tts worker exited repeatedly"));
    }
  }
}

function settleFront(err: Error | null, audio?: Buffer) {
  const req = queue.shift();
  if (!req) return;
  if (err) req.reject(err);
  else req.resolve(audio!);
  armFrontTimeout(); // the next request starts its clock when its turn starts
}

function onWorkerData(chunk: Buffer) {
  recvBuf = Buffer.concat([recvBuf, chunk]);
  while (true) {
    if (expectedLen === null) {
      if (recvBuf.length < 4) return;
      expectedLen = recvBuf.readUInt32BE(0);
      recvBuf = recvBuf.subarray(4);
    }
    if (recvBuf.length < expectedLen) return;
    const audio = recvBuf.subarray(0, expectedLen);
    recvBuf = recvBuf.subarray(expectedLen);
    const len = expectedLen;
    expectedLen = null;
    if (len === 0) settleFront(new Error("edge_tts worker reported a synthesis error"));
    else settleFront(null, Buffer.from(audio));
  }
}

function spawnWorker(): ChildProcessWithoutNullStreams {
  const proc = spawn(PYTHON_BIN, [WORKER_SCRIPT]);
  recvBuf = Buffer.alloc(0);
  expectedLen = null;

  proc.stdout.on("data", onWorkerData);
  proc.stderr.on("data", (c) => console.warn("edge_tts worker stderr:", c.toString().trim()));
  // Writing to a process that died between dispatch and flush raises EPIPE on
  // the stream. Unhandled, a stream 'error' event takes the whole server down.
  proc.stdin.on("error", (err) => console.warn("edge_tts worker stdin:", err.message));

  proc.on("exit", (code) => {
    console.warn(`edge_tts worker exited (code ${code}) — will respawn on next request`);
    if (worker === proc) worker = null;
    drainAfterWorkerLoss();
  });
  proc.on("error", (err) => {
    console.warn("edge_tts worker failed to start:", err);
    if (worker === proc) worker = null;
    // Node emits 'error' with NO 'exit' when the spawn itself fails — a missing
    // interpreter, say. Without this the queue kept its unsettled promises, and
    // because dispatch() only arms a deadline when the queue is empty, no timer
    // was ever armed again: every later request joined a queue that could not
    // drain, and the browser sat on a fetch that never resolved. Aide went
    // silent for the life of the process with nothing on screen to say why.
    drainAfterWorkerLoss();
  });

  return proc;
}

function getWorker(): ChildProcessWithoutNullStreams {
  if (!worker) worker = spawnWorker();
  return worker;
}

// Pre-warm at module load (server boot / first import): spawning the worker
// alone only pays Python's ~1.4s import cost. The real cold-start expense is
// the TLS/session handshake inside edge_tts's first call to Microsoft's
// server (~5-6s) — only a real synthesis call pays that down, so fire one at
// boot with a throwaway phrase, discarding the result, so the user's actual
// first turn hits the ~2.5-3s warm path instead.
// Skipped on Vercel: a serverless function can't keep a child process alive, so
// production speaks through the native Python function (api/speak.py) instead.
// Spawning here would only throw ModuleNotFoundError into the build logs.
if (process.env.NEXT_RUNTIME !== "edge" && !process.env.VERCEL) {
  requestSynthesis("Aide is starting up.", VOICE).catch(() => {
    /* boot-time warm-up failure isn't fatal — the first real request will retry */
  });
}

// Hand one request to the worker. Separate from requestSynthesis so the exit
// handler above can re-send work a dead process never finished.
function dispatch(req: PendingRequest): void {
  const proc = getWorker();
  queue.push(req);
  // Only whatever is at the front of the queue is on the clock.
  if (queue.length === 1) armFrontTimeout();
  proc.stdin.write(JSON.stringify({ text: req.text, voice: req.voice }) + "\n", "utf-8");
}

function requestSynthesis(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    dispatch({ text, voice, resolve, reject, attempts: 0 });
  });
}

// GET lets the client point an <audio> element straight at the URL, so
// playback starts as soon as the response arrives.
export async function GET(req: Request) {
  const text = new URL(req.url).searchParams.get("text");
  return synthesize(text);
}

export async function POST(req: Request) {
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  return synthesize(text);
}

async function synthesize(text: string | null | undefined) {
  if (!text) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  const cacheKey = `${VOICE}:${text}`;
  const cached = audioCache.get(cacheKey);
  if (cached) {
    return new Response(new Uint8Array(cached), { headers: { "Content-Type": "audio/mpeg" } });
  }

  if (Date.now() < breakerOpenUntil) {
    return Response.json({ error: "Edge TTS is temporarily unavailable" }, { status: 502 });
  }

  try {
    const audio = await requestSynthesis(text, VOICE);
    breakerOpenUntil = 0;

    if (audioCache.size >= CACHE_MAX) {
      const oldest = audioCache.keys().next().value;
      if (oldest) audioCache.delete(oldest);
    }
    audioCache.set(cacheKey, audio);

    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/mpeg" } });
  } catch (err) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.error("Error in Edge TTS route:", err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
