import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export const runtime = "nodejs";

// Free natural speech via Microsoft Edge's neural voices — including real
// Nigerian English. en-NG-EzinneNeural (female) / en-NG-AbeoNeural (male)
// are the only two NG voices in the catalog; override with EDGE_TTS_VOICE.
const VOICE = process.env.EDGE_TTS_VOICE || "en-NG-EzinneNeural";

// The Edge endpoint can hang; never let a stuck websocket stall Aide's voice —
// past this deadline the client falls back to the browser's local voice.
const CONNECT_TIMEOUT_MS = 8000;

// Synthesis is the slow part (~2s). Repeated phrases — the greeting, status
// lines, confirmations — come straight from this cache instead.
const audioCache = new Map<string, Buffer>();
const CACHE_MAX = 100;

// GET lets the client point an <audio> element straight at the URL, so
// playback starts while synthesis is still streaming — much lower latency
// than POST + blob(), which waits for the whole file.
export async function GET(req: Request) {
  const text = new URL(req.url).searchParams.get("text");
  return synthesize(text);
}

export async function POST(req: Request) {
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  return synthesize(text);
}

async function synthesize(text: string | null | undefined) {
  try {
    if (!text) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    const cacheKey = `${VOICE}:${text}`;
    const cached = audioCache.get(cacheKey);
    if (cached) {
      return new Response(new Uint8Array(cached), { headers: { "Content-Type": "audio/mpeg" } });
    }

    const audioStream = await Promise.race([
      (async () => {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = await tts.toStream(text);
        return audioStream;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Edge TTS timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
      ),
    ]);

    const chunks: Buffer[] = [];
    const stream = new ReadableStream({
      start(controller) {
        audioStream.on("data", (chunk) => {
          chunks.push(chunk);
          controller.enqueue(chunk);
        });
        audioStream.on("end", () => {
          try {
            controller.close();
          } catch {}
          if (chunks.length > 0) {
            if (audioCache.size >= CACHE_MAX) {
              const oldest = audioCache.keys().next().value;
              if (oldest) audioCache.delete(oldest);
            }
            audioCache.set(cacheKey, Buffer.concat(chunks));
          }
        });
        audioStream.on("error", (err) => {
          try {
            controller.error(err);
          } catch {}
        });
      },
      cancel() {
        audioStream.destroy();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "audio/mpeg" },
    });
  } catch (err) {
    console.error("Error in Edge TTS route:", err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
