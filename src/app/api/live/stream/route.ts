import type { NextRequest } from "next/server";
import { z } from "zod";
import { handler, requireUser } from "@/server/http";
import { subscribe } from "@/server/live-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const q = z.object({ env: z.enum(["production", "studio", "simulation"]).default("production") });

/** Server-Sent Events: a live snapshot every 5 s (CCU, servers, joins/leaves, last event). */
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req, "view");
  const { env } = q.parse(Object.fromEntries(req.nextUrl.searchParams));
  const showRevenue = user.role !== "viewer";
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let ping: NodeJS.Timeout | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (ping) clearInterval(ping);
        ping = null;
      };
      controller.enqueue(enc.encode(`retry: 5000\n\n`));
      unsubscribe = subscribe(env, (s) => send("live", showRevenue ? s : { ...s, robuxLastHour: undefined }));
      ping = setInterval(() => send("ping", Date.now()), 20_000);
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
});
