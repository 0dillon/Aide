import { getAccount, subscribeEvents } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-sent events stream, scoped to the signed-in user's own wallet: the
// browser listens here and Aide announces confirmed payments out loud the
// moment they land — only to the person who actually got paid.
export async function GET(req: Request) {
  const acc = getAccount(userIdFrom(req));
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
      unsub = subscribeEvents(acc.id, send);
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
