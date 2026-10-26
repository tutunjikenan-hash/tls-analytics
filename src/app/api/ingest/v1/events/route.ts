import type { NextRequest } from "next/server";
import { env } from "@/server/env";
import { handleIngest } from "@/server/ingest/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reads the body but stops as soon as it exceeds the limit (with or without Content-Length). */
async function readLimited(req: NextRequest, limit: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Roblox game servers → analytics. Auth: Authorization: Bearer <ingest key>; X-TLS-Request-Id: <uuid>. */
export async function POST(req: NextRequest) {
  const bodyText = await readLimited(req, env().INGEST_MAX_BODY_BYTES);
  if (bodyText === null) return Response.json({ error: "payload_too_large" }, { status: 413 });
  const res = await handleIngest({
    authorization: req.headers.get("authorization"),
    requestId: req.headers.get("x-tls-request-id"),
    bodyText,
  });
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(res.headers ?? {}) },
  });
}
