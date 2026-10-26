import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit, can } from "@/server/auth/auth";
import { REVENUE_ALERTS } from "@/server/redact";
import { pool } from "@/server/db";
import { clientIp, handler, json, requireUser } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req, "view");
  const env = z.enum(["production", "studio", "simulation"]).default("production").parse(req.nextUrl.searchParams.get("env") ?? undefined);
  const [rules, events] = await Promise.all([
    pool().query(`SELECT kind, enabled, params, cooldown_min, severity FROM alert_rules ORDER BY kind`),
    pool().query(
      `SELECT a.id, a.kind, a.severity, a.title, a.details, a.fired_at, a.notified_at, a.notify_error, a.acknowledged_at, u.name AS acknowledged_by
       FROM alert_events a LEFT JOIN users u ON u.id = a.acknowledged_by WHERE a.env = $1 ORDER BY a.fired_at DESC LIMIT 200`,
      [env],
    ),
  ]);
  const revenue = can(user.role, "view_revenue");
  return json({
    rules: revenue ? rules.rows : rules.rows.filter((r) => !REVENUE_ALERTS.has(r.kind)),
    events: revenue ? events.rows : events.rows.filter((e) => !REVENUE_ALERTS.has(e.kind)),
    discordConfigured: !!process.env.DISCORD_WEBHOOK_URL,
  });
});

const ruleUpdate = z.object({
  kind: z.string().max(40),
  enabled: z.boolean().optional(),
  cooldown_min: z.number().int().min(1).max(10080).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  params: z.record(z.string().max(40), z.number().finite().min(0).max(1e9)).optional(),
});

/** update one alert rule (admin) */
export const PATCH = handler(async (req: NextRequest) => {
  const u = await requireUser(req, "manage_alerts");
  const b = ruleUpdate.parse(await req.json());
  const { rows } = await pool().query(
    `UPDATE alert_rules SET enabled = COALESCE($2, enabled), cooldown_min = COALESCE($3, cooldown_min), severity = COALESCE($4, severity),
       params = CASE WHEN $5::jsonb IS NULL THEN params ELSE params || $5::jsonb END
     WHERE kind = $1 RETURNING kind, enabled, params, cooldown_min, severity`,
    [b.kind, b.enabled ?? null, b.cooldown_min ?? null, b.severity ?? null, b.params ? JSON.stringify(b.params) : null],
  );
  if (!rows[0]) return json({ error: "unknown rule" }, 404);
  await audit(u.id, "alert_rule_updated", b.kind, b, clientIp(req));
  return json(rows[0]);
});
