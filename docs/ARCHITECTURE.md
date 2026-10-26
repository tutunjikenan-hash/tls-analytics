# Architecture

## Components

| Part | Where | Job |
|---|---|---|
| `TLSAnalytics` (Luau ModuleScript) | ServerScriptService | Queue, batch, retry and send events from each game server |
| `TLSAnalyticsBoot` (Script) | ServerScriptService | Starts the client |
| `TLSAnalyticsGameHooks` (Script) | ServerScriptService | Observes The Last Shift's state and reports gameplay events |
| One line in `ShopService` | ServerScriptService.LastStop | Wraps ProcessReceipt so granted purchases are recorded |
| Next.js app | one Node service (Docker) | Ingest API, dashboard API, SSE, UI, background jobs |
| PostgreSQL 16 | managed (Supabase, Neon, RDS…) | All data |

One Node service, not serverless: the live stream (SSE) and the background jobs need a long-running
process. Several instances can run behind a load balancer: jobs elect a single leader through a
Postgres advisory lock, and every instance serves SSE from the database.

## Event flow

1. A game server queues events in memory (`session_start`, `server_heartbeat` every 10 s, `purchase`,
   `game`, `counter`, ...). Every 5 s, or at 100 queued events, it POSTs a batch:
   `Authorization: Bearer <key from a Roblox Secret>`, `X-TLS-Request-Id: <uuid per batch>`.
2. The ingest route checks size, key (SHA-256 lookup, constant-time compare), request id, schema
   (zod), the key's allowed environment, `sentAt` within 15 minutes (replay window), and rate limits
   (per key and per server).
3. In **one transaction**: the request id is inserted into `ingest_requests` (a retried request stops
   here and is answered `duplicate: true`); events are inserted into `raw_events` with
   `ON CONFLICT (event_id) DO NOTHING RETURNING` so only never-seen events continue; those are
   applied to the base tables with idempotent upserts.
4. A failed request is retried by the game with backoff and the **same** request id, so nothing is
   ever counted twice, and nothing is lost on a network error.

UserIds are replaced by `player_key = HMAC-SHA256(PLAYER_ID_PEPPER, "roblox:" + userId)[:24]` before
anything is stored.

## Tables

| Group | Tables |
|---|---|
| Ingestion | `ingest_keys`, `ingest_requests`, `raw_events` (audit log of every accepted event; pruned after 90 days) |
| Base facts | `servers`, `server_heartbeats`, `players`, `sessions` (one per player per server), `purchases`, `gameplay_events`, `runs`, `server_counters` |
| Aggregates (recomputed, never incremented) | `ccu_minutes`, `player_days`, `hourly_stats`, `daily_stats`, `retention_cohorts` |
| Roblox's own numbers | `roblox_reported` (games API or entered by hand, always shown separately) |
| Dashboard | `users`, `user_sessions`, `audit_log`, `settings`, `alert_rules`, `alert_events`, `report_runs`, `job_state` |

Every data table has an `env` column: `production`, `studio` (Studio play-tests) or `simulation`
(the local simulator). The UI shows one environment at a time; they never mix.

## Sessions, visits and the reconciler

- A **session** is one player on one server. A **visit** is one experience visit: the lobby → shift
  server teleport continues the visit (`teleportIn` + a session of the same player ending within 3 min).
- Out-of-order and late events converge: start times only move earlier, last-seen only later; a
  session whose start was lost is created from its first heartbeat (`inferred_start`).
- **Reaper** (every 15 s): a server silent for longer than the session timeout (45 s) is closed as
  `lost` at its last heartbeat, and its sessions as `timeout` at their last-seen time. A later
  heartbeat (network hiccup) reopens them. A run whose player has been gone 10 minutes is `abandoned`.

## Background jobs (leader only)

| Job | Every | Does |
|---|---|---|
| live | 15 s | reaper + CCU sample into `ccu_minutes` (peak and last per minute) |
| rollups | 30 s | recomputes hours/days touched by events received since the last run (handles late events exactly) |
| wide | 10 min | recomputes the last 48 h / 3 days |
| retention | 60 min + at day change | calendar-day cohort cells for days that are over |
| alerts | 60 s | 8 rules, cooldowns, Discord |
| reports | 5 min | daily / weekly report when due |
| roblox | 10 min | public games API counts (if `ROBLOX_UNIVERSE_ID`) |
| prune | 60 min | data retention |

Status of every job is in Settings → Background jobs. A reporting time zone change triggers a full
rebuild of the day-based aggregates.

## Latency

- Live numbers: heartbeat (≤10 s) + batch (≤5 s) + stream (5 s) → typically 5–15 s.
- Charts and daily numbers: plus one rollup (≤30 s) → under 60 s.
- KPI tiles are computed from the base tables on request, so they are current as of the last batch.

## API

| Route | Auth | |
|---|---|---|
| `POST /api/ingest/v1/events` | ingest key | game servers |
| `GET /api/metrics/{overview,live,revenue,engagement,retention,gameplay,growth,servers}?range=&from=&to=&env=` | session | pages |
| `GET /api/live/stream?env=` | session | SSE |
| `GET /api/export/{daily,hourly,purchases,runs,retention}.csv` | analyst+ | CSV |
| `/api/auth/{login,logout,me}`, `/api/users`, `/api/keys`, `/api/settings`, `/api/alerts`, `/api/revenue/reconcile`, `/api/roblox-reported`, `/api/audit` | session + role | admin |
| `GET /api/health` | none | liveness (no data) |
