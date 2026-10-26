import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/auth/auth";
import { pool, tx } from "@/server/db";
import { clientIp, handler, json, requireUser } from "@/server/http";
import { getSettings, invalidateSettings, isValidTimeZone } from "@/server/settings";
import { env } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireUser(req, "view");
  const s = await getSettings(pool(), true);
  const { rows: jobs } = await pool().query(`SELECT name, last_run_at, last_ok_at, last_error FROM job_state ORDER BY name`);
  const e = env();
  return json({
    settings: s,
    jobs,
    config: {
      discordWebhook: !!e.DISCORD_WEBHOOK_URL,
      robloxUniverseId: e.ROBLOX_UNIVERSE_ID ?? null,
      jobsEnabled: e.JOBS_ENABLED,
      ingestUrl: `${e.APP_URL.replace(/\/$/, "")}/api/ingest/v1/events`,
    },
  });
});

const update = z
  .object({
    reporting_timezone: z.string().max(64).refine(isValidTimeZone, "unknown IANA time zone").optional(),
    raw_event_retention_days: z.number().int().min(8).max(3650).optional(), // >= 8: dedupe needs the 7-day event window
    heartbeat_retention_days: z.number().int().min(1).max(365).optional(),
    session_timeout_seconds: z.number().int().min(25).max(300).optional(),
    creator_share: z.number().min(0).max(1).optional(),
    gameplay_funnel: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,47}$/)).min(2).max(8).optional(),
    daily_report_hour: z.number().int().min(0).max(23).optional(),
    reports_enabled: z.boolean().optional(),
  })
  .strict();

export const PATCH = handler(async (req: NextRequest) => {
  const u = await requireUser(req, "manage_settings");
  const b = update.parse(await req.json());
  const before = await getSettings(pool(), true);
  await tx(async (c) => {
    for (const [k, v] of Object.entries(b)) {
      await c.query(`UPDATE settings SET value = $2::jsonb, updated_at = now(), updated_by = $3 WHERE key = $1`, [k, JSON.stringify(v), u.id]);
    }
    if (b.creator_share !== undefined && b.creator_share !== before.creator_share) {
      // estimates follow the current share; verified amounts are untouched
      await c.query(`UPDATE purchases SET estimated_creator_robux = floor(robux_gross * $1)`, [b.creator_share]);
      await c.query(`INSERT INTO job_state (name, info) VALUES ('rebuild_requested', '{}') ON CONFLICT (name) DO NOTHING`);
    }
    if (b.reporting_timezone && b.reporting_timezone !== before.reporting_timezone) {
      // every day-based aggregate is rebuilt in the new zone by the job runner
      await c.query(`INSERT INTO job_state (name, info) VALUES ('rebuild_requested', '{}') ON CONFLICT (name) DO NOTHING`);
    }
  });
  invalidateSettings();
  await audit(u.id, "settings_updated", null, { changes: b }, clientIp(req));
  return json({ ok: true, settings: await getSettings(pool(), true) });
});
