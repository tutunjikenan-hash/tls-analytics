import type { NextRequest } from "next/server";
import { pool } from "@/server/db";
import { handler, json, requireUser } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireUser(req, "view_audit");
  const { rows } = await pool().query(
    `SELECT a.id, a.at, a.action, a.target, a.details, a.ip_hash, u.name AS user_name, u.email AS user_email
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.at DESC LIMIT 300`,
  );
  return json({ entries: rows });
});
