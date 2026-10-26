import { pool } from "../db";
import { env } from "../env";
import { getSettings } from "../settings";
import { playerKey, takeToken, verifyKey } from "./keys";
import { loadPepper } from "../pepper";
import { processEvents, type KeyedEvent } from "./process";
import { envelopeSchema, eventSchema, MAX_EVENT_AGE_MS, MAX_EVENT_FUTURE_MS, MAX_SENT_SKEW_MS } from "./schema";

export interface IngestRequest {
  authorization: string | null;
  requestId: string | null;
  bodyText: string;
  now?: number;
}

export interface IngestResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let lastKeyTouch = new Map<string, number>();

/**
 * POST /api/ingest/v1/events
 *
 * Status codes the Luau client relies on:
 *   200 accepted (possibly with per-event rejections) or an already-seen request id (duplicate: true)
 *   400 malformed request — retrying will not help, the batch is dropped
 *   401/403 bad or unauthorised key — the client stops sending and logs a warning
 *   413 too large, 429 rate limited (Retry-After), 5xx retry with backoff
 */
export async function handleIngest(req: IngestRequest): Promise<IngestResponse> {
  const cfg = env();
  const now = req.now ?? Date.now();

  if (Buffer.byteLength(req.bodyText, "utf8") > cfg.INGEST_MAX_BODY_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  const m = /^Bearer\s+(\S+)$/.exec(req.authorization ?? "");
  if (!m) return { status: 401, body: { error: "missing_bearer_key" } };
  const key = await verifyKey(pool(), m[1]);
  if (!key) return { status: 401, body: { error: "invalid_key" } };

  if (!req.requestId || !UUID_RE.test(req.requestId)) {
    return { status: 400, body: { error: "missing_request_id", hint: "send X-TLS-Request-Id: <uuid>" } };
  }
  const requestId = req.requestId.toLowerCase();

  let json: unknown;
  try {
    json = JSON.parse(req.bodyText);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const envParsed = envelopeSchema.safeParse(json);
  if (!envParsed.success) {
    return { status: 400, body: { error: "invalid_envelope", issues: envParsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) } };
  }
  const envelope = envParsed.data;
  if (!key.environments.includes(envelope.env)) {
    return { status: 403, body: { error: "environment_not_allowed_for_key", env: envelope.env } };
  }
  if (Math.abs(now - envelope.sentAt) > MAX_SENT_SKEW_MS) {
    return { status: 400, body: { error: "stale_or_future_request", hint: "sentAt must be within 15 minutes of server time" } };
  }

  if (!takeToken(`key:${key.id}`, cfg.INGEST_RATE_PER_KEY_PER_MIN, now) || !takeToken(`srv:${key.id}:${envelope.serverId}`, cfg.INGEST_RATE_PER_SERVER_PER_MIN, now)) {
    return { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "10" } };
  }

  const pepper = await loadPepper(pool());
  // per-event validation; invalid events are reported back and skipped
  const valid: KeyedEvent[] = [];
  const errors: string[] = [];
  let rejected = 0;
  const seenInBatch = new Set<string>();
  envelope.events.forEach((raw, i) => {
    const r = eventSchema.safeParse(raw);
    if (!r.success) {
      rejected++;
      if (errors.length < 10) errors.push(`events[${i}]: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
      return;
    }
    const ev = r.data;
    if (ev.ts < now - MAX_EVENT_AGE_MS || ev.ts > now + MAX_EVENT_FUTURE_MS) {
      rejected++;
      if (errors.length < 10) errors.push(`events[${i}]: timestamp out of range`);
      return;
    }
    if (seenInBatch.has(ev.id)) return; // repeated inside the same batch: counted once
    seenInBatch.add(ev.id);
    const keyed = ev as KeyedEvent;
    keyed.at = new Date(ev.ts);
    if ("uid" in ev && typeof ev.uid === "number") keyed.pk = playerKey(pepper, ev.uid);
    if (ev.type === "server_heartbeat") {
      (keyed as KeyedEvent & { pks: string[] }).pks = ev.d.players.map((p) => playerKey(pepper, p.uid));
    }
    valid.push(keyed);
  });

  const settings = await getSettings();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO ingest_requests (request_id, key_id, accepted, duplicates, rejected) VALUES ($1,$2,0,0,$3)
       ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
      [requestId, key.id, rejected],
    );
    if (ins.rowCount === 0) {
      await client.query("ROLLBACK");
      return { status: 200, body: { ok: true, duplicate: true, accepted: 0, duplicates: envelope.events.length, rejected: 0 } };
    }

    let fresh: KeyedEvent[] = [];
    if (valid.length > 0) {
      const res = await client.query<{ event_id: string }>(
        `INSERT INTO raw_events (event_id, env, type, server_id, session_id, player_key, occurred_at, payload)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::timestamptz[], $8::jsonb[])
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          valid.map((e) => e.id),
          valid.map(() => envelope.env),
          valid.map((e) => e.type),
          valid.map(() => envelope.serverId),
          valid.map((e) => ("sid" in e && e.sid ? e.sid : null)),
          valid.map((e) => e.pk ?? null),
          valid.map((e) => e.at.toISOString()),
          valid.map((e) => JSON.stringify(stripIdentity(e))),
        ],
      );
      const newIds = new Set(res.rows.map((r) => r.event_id));
      fresh = valid.filter((e) => newIds.has(e.id));
      await processEvents(client, envelope.env, envelope, fresh, settings.creator_share);
    }
    const duplicates = valid.length - fresh.length + (envelope.events.length - rejected - valid.length);
    await client.query(`UPDATE ingest_requests SET accepted = $2, duplicates = $3 WHERE request_id = $1`, [requestId, fresh.length, duplicates]);
    if (!settings.tracking_started_at && envelope.env === "production" && fresh.length > 0) {
      const first = new Date(Math.min(...fresh.map((e) => e.at.getTime())));
      await client.query(
        `UPDATE settings SET value = to_jsonb($1::timestamptz), updated_at = now() WHERE key = 'tracking_started_at' AND value = 'null'::jsonb`,
        [first],
      );
    }
    await client.query("COMMIT");

    const last = lastKeyTouch.get(key.id) ?? 0;
    if (now - last > 60_000) {
      lastKeyTouch.set(key.id, now);
      pool().query("UPDATE ingest_keys SET last_used_at = now() WHERE id = $1", [key.id]).catch(() => undefined);
    }
    return { status: 200, body: { ok: true, accepted: fresh.length, duplicates, rejected, errors } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[ingest] failed", (err as Error).message);
    return { status: 503, body: { error: "temporarily_unavailable" }, headers: { "Retry-After": "5" } };
  } finally {
    client.release();
  }
}

/** raw_events keeps the payload for audit/replay, minus the Roblox UserId (replaced by player_key). */
function stripIdentity(e: KeyedEvent): Record<string, unknown> {
  const { at: _at, pk: _pk, ...rest } = e as KeyedEvent & { pks?: string[] };
  const copy: Record<string, unknown> = { ...rest };
  delete copy.uid;
  delete copy.pks;
  if (e.type === "server_heartbeat") {
    copy.d = { ...e.d, players: e.d.players.map((p, i) => ({ sid: p.sid, stage: p.stage, pk: (e as { pks?: string[] }).pks?.[i] })) };
  }
  return copy;
}

export function resetIngestState() {
  lastKeyTouch = new Map();
}
