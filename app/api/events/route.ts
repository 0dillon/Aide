import { subscribeEvents } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-sent events stream: the browser listens here and Aide announces
// confirmed payments out loud the moment they land.
export async function GET() {
  const encoder = new TextEncoder();
  let unsub = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      send({ type: "hello" });
      unsub = subscribeEvents(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {}
      }, 25000);
    },
    cancel() {
      unsub();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
