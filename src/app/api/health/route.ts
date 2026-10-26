import { pool } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness for the hosting platform. Reveals no data. */
export async function GET() {
  try {
    await pool().query("SELECT 1");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
