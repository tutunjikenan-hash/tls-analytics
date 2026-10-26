import type { NextRequest } from "next/server";
import { can, type Permission } from "@/server/auth/auth";
import { handler, json, requireUser } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERMS: Permission[] = ["view", "view_revenue", "export", "manage_alerts", "manage_settings", "manage_keys", "reconcile", "manage_users", "view_audit"];

export const GET = handler(async (req: NextRequest) => {
  const u = await requireUser(req);
  return json({ name: u.name, email: u.email, role: u.role, permissions: PERMS.filter((p) => can(u.role, p)) });
});
