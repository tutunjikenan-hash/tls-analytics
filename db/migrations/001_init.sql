-- ============================================================================================
-- The Last Shift analytics — initial schema
--
-- Conventions
--   * Every timestamp is timestamptz and stored in UTC. Reporting days are computed with the
--     reporting time zone from `settings` (see db/migrations README and docs/METRICS.md).
--   * `env` separates data sources completely: 'production' (live Roblox servers),
--     'studio' (Roblox Studio play tests) and 'simulation' (scripts/simulate.ts). Every query in the
--     app filters on env, so test data can never leak into production numbers.
--   * Roblox UserIds are never stored. The ingest API turns each one into `player_key`, an HMAC-SHA256
--     of the UserId with a server-side pepper (PLAYER_ID_PEPPER), truncated to 24 hex characters.
-- ============================================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- settings ------------------------------------------------------------------------
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);
INSERT INTO settings (key, value) VALUES
  ('reporting_timezone', '"UTC"'),
  ('raw_event_retention_days', '90'),
  ('heartbeat_retention_days', '14'),
  ('session_timeout_seconds', '45'),
  ('creator_share', '0.7'),
  ('tracking_started_at', 'null'),
  ('gameplay_funnel', '["lobby_joined","gate_entered","run_start","first_customer","final_hour","run_complete"]'),
  ('daily_report_hour', '9'),
  ('reports_enabled', 'true');

-- ---------- dashboard users, sessions, audit ----------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner','admin','analyst','viewer')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  disabled_at    timestamptz,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz
);

CREATE TABLE user_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip_hash      text,
  revoked_at   timestamptz
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  target    text,
  details   jsonb NOT NULL DEFAULT '{}',
  ip_hash   text
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- ---------- ingestion keys + replay protection ----------------------------------------------------
-- A key is shown once when created; only its SHA-256 is stored.
CREATE TABLE ingest_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  key_hash      bytea NOT NULL UNIQUE,
  key_prefix    text NOT NULL,
  environments  text[] NOT NULL,          -- which env values this key may write, e.g. {production,studio}
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CHECK (environments <@ ARRAY['production','studio','simulation']::text[] AND cardinality(environments) > 0)
);

-- one row per accepted request id; a replayed or retried request is answered from here and does nothing
CREATE TABLE ingest_requests (
  request_id   uuid PRIMARY KEY,
  key_id       uuid NOT NULL REFERENCES ingest_keys(id) ON DELETE CASCADE,
  received_at  timestamptz NOT NULL DEFAULT now(),
  accepted     int NOT NULL,
  duplicates   int NOT NULL,
  rejected     int NOT NULL
);
CREATE INDEX ingest_requests_received ON ingest_requests (received_at);

-- ---------- raw events (dedupe + audit trail) -----------------------------------------------------
CREATE TABLE raw_events (
  event_id     uuid PRIMARY KEY,
  env          text NOT NULL,
  type         text NOT NULL,
  server_id    text NOT NULL,
  session_id   uuid,
  player_key   text,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX raw_events_env_time ON raw_events (env, occurred_at);
CREATE INDEX raw_events_received ON raw_events (received_at);

-- ---------- game servers ------------------------------------------------------------------------
CREATE TABLE servers (
  env                text NOT NULL,
  server_id          text NOT NULL,
  place_id           bigint,
  place_version      int,
  server_kind        text,                   -- public | reserved | private | studio
  started_at         timestamptz NOT NULL,
  last_heartbeat_at  timestamptz NOT NULL,
  ended_at           timestamptz,
  end_reason         text,                   -- shutdown | lost (no heartbeat)
  player_count       int NOT NULL DEFAULT 0,
  fps                real,
  memory_mb          real,
  uptime_sec         int,
  stats_at           timestamptz,             -- time of the heartbeat the fps/memory/player_count came from
  PRIMARY KEY (env, server_id)
);
CREATE INDEX servers_open ON servers (env, last_heartbeat_at) WHERE ended_at IS NULL;
CREATE INDEX servers_started ON servers (env, started_at);

CREATE TABLE server_heartbeats (
  env           text NOT NULL,
  server_id     text NOT NULL,
  at            timestamptz NOT NULL,
  player_count  int NOT NULL,
  fps           real,
  memory_mb     real,
  PRIMARY KEY (env, server_id, at)
);
CREATE INDEX server_heartbeats_time ON server_heartbeats (env, at);

-- ---------- players, visits, sessions -------------------------------------------------------------
CREATE TABLE players (
  env              text NOT NULL,
  player_key       text NOT NULL,
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  country          text,
  PRIMARY KEY (env, player_key)
);
CREATE INDEX players_first_seen ON players (env, first_seen_at);

-- A session is one player's presence on one game server (join -> leave).
-- A visit groups the sessions of one experience visit: a teleport between our own servers
-- (lobby -> shift server) continues the same visit instead of counting a new one.
CREATE TABLE sessions (
  session_id     uuid PRIMARY KEY,
  env            text NOT NULL,
  player_key     text NOT NULL,
  server_id      text NOT NULL,
  visit_id       uuid NOT NULL,
  started_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  ended_at       timestamptz,
  end_reason     text,                      -- left | server_shutdown | timeout
  teleport_in    boolean NOT NULL DEFAULT false,
  referred       boolean NOT NULL DEFAULT false,  -- joined through a share link (GetJoinData().ReferredByPlayerId)
  inferred_start boolean NOT NULL DEFAULT false,  -- start event never arrived; started at first heartbeat
  stage          text,
  country        text,
  CHECK (last_seen_at >= started_at)
);
CREATE INDEX sessions_env_start ON sessions (env, started_at);
CREATE INDEX sessions_env_end ON sessions (env, ended_at);
CREATE INDEX sessions_open ON sessions (env, last_seen_at) WHERE ended_at IS NULL;
CREATE INDEX sessions_player ON sessions (env, player_key, started_at);
CREATE INDEX sessions_visit ON sessions (visit_id);
CREATE INDEX sessions_unlinked ON sessions (started_at) WHERE teleport_in AND visit_id = session_id;

-- one row per player per reporting day on which the player was active (exact DAU / WAU / MAU / retention)
CREATE TABLE player_days (
  env         text NOT NULL,
  day         date NOT NULL,
  player_key  text NOT NULL,
  PRIMARY KEY (env, day, player_key)
);
CREATE INDEX player_days_player ON player_days (env, player_key, day);

-- ---------- purchases ---------------------------------------------------------------------------
CREATE TABLE purchases (
  env                     text NOT NULL,
  purchase_id             text NOT NULL,          -- Roblox receipt PurchaseId, or gp:<player_key>:<passId>
  kind                    text NOT NULL CHECK (kind IN ('developer_product','game_pass')),
  product_id              bigint NOT NULL,
  product_name            text,
  player_key              text NOT NULL,
  session_id              uuid,
  server_id               text,
  robux_gross             int NOT NULL CHECK (robux_gross >= 0),
  price_source            text NOT NULL,          -- receipt_currency_spent | catalog_list_price
  status                  text NOT NULL CHECK (status IN ('confirmed','pending_verification')),
  purchased_at            timestamptz NOT NULL,
  estimated_creator_robux int NOT NULL,
  verified_creator_robux  int,                    -- only from reconciliation with official reports
  reconciled_at           timestamptz,
  refunded_at             timestamptz,            -- only when an authoritative source reports it
  PRIMARY KEY (env, purchase_id)
);
CREATE INDEX purchases_time ON purchases (env, purchased_at);
CREATE INDEX purchases_player ON purchases (env, player_key);

-- ---------- gameplay ----------------------------------------------------------------------------
CREATE TABLE gameplay_events (
  event_id     uuid PRIMARY KEY,
  env          text NOT NULL,
  name         text NOT NULL,
  player_key   text,
  session_id   uuid,
  server_id    text NOT NULL,
  run_id       text,
  chapter      text,
  stage        text,
  area         text,
  value        double precision,
  props        jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL
);
CREATE INDEX gameplay_events_time ON gameplay_events (env, occurred_at);
CREATE INDEX gameplay_events_name ON gameplay_events (env, name, occurred_at);
CREATE INDEX gameplay_events_run ON gameplay_events (env, run_id);

-- a gameplay run (one shift / one Chapter 2 run attempt by one player)
CREATE TABLE runs (
  env          text NOT NULL,
  run_id       text NOT NULL,
  player_key   text NOT NULL,
  chapter      text,
  stage        text,                       -- e.g. night number reached
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  outcome      text CHECK (outcome IN ('completed','failed','abandoned')),
  fail_reason  text,
  attempt      int,                        -- n-th run of this player for this chapter+stage
  PRIMARY KEY (env, run_id, player_key)
);
CREATE INDEX runs_time ON runs (env, started_at);
CREATE INDEX runs_player ON runs (env, player_key, chapter, stage, started_at);

-- ---------- live CCU + aggregates -----------------------------------------------------------------
-- sampled every 15 s by the job runner: exact count of distinct players with an open, fresh session
CREATE TABLE ccu_minutes (
  env         text NOT NULL,
  minute      timestamptz NOT NULL,
  peak_ccu    int NOT NULL,
  last_ccu    int NOT NULL,
  servers     int NOT NULL,
  samples     int NOT NULL DEFAULT 1,
  PRIMARY KEY (env, minute)
);

CREATE TABLE hourly_stats (
  env               text NOT NULL,
  hour              timestamptz NOT NULL,       -- UTC hour start
  visits            int NOT NULL,
  sessions          int NOT NULL,
  unique_players    int NOT NULL,
  new_players       int NOT NULL,
  playtime_sec      bigint NOT NULL,
  revenue_robux     bigint NOT NULL,
  purchases         int NOT NULL,
  peak_ccu          int NOT NULL,
  joins             int NOT NULL,
  leaves            int NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, hour)
);

CREATE TABLE daily_stats (
  env                 text NOT NULL,
  day                 date NOT NULL,            -- reporting-time-zone day
  timezone            text NOT NULL,
  visits              int NOT NULL,
  sessions            int NOT NULL,
  dau                 int NOT NULL,
  new_players         int NOT NULL,
  returning_players   int NOT NULL,
  playtime_sec        bigint NOT NULL,
  avg_visit_sec       double precision,
  median_visit_sec    double precision,
  revenue_robux       bigint NOT NULL,
  est_creator_robux   bigint NOT NULL,
  purchases           int NOT NULL,
  paying_users        int NOT NULL,
  peak_ccu            int NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, day)
);

CREATE TABLE retention_cohorts (
  env          text NOT NULL,
  cohort_day   date NOT NULL,
  day_offset   int NOT NULL,
  cohort_size  int NOT NULL,
  retained     int NOT NULL,
  timezone     text NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, cohort_day, day_offset)
);

-- figures reported by Roblox itself (public game stats API, or entered by hand from the Creator
-- Dashboard). Always shown labelled "Roblox-reported", never mixed into measured numbers.
CREATE TABLE roblox_reported (
  id          bigserial PRIMARY KEY,
  metric      text NOT NULL,                 -- visits | playing | favorites | ...
  value       bigint NOT NULL,
  as_of       timestamptz NOT NULL,
  source      text NOT NULL,                 -- games_api | manual
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX roblox_reported_metric ON roblox_reported (metric, as_of DESC);

-- ---------- alerts + reports ----------------------------------------------------------------------
CREATE TABLE alert_rules (
  kind          text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT true,
  params        jsonb NOT NULL,
  cooldown_min  int NOT NULL DEFAULT 30,
  severity      text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical'))
);
INSERT INTO alert_rules (kind, params, cooldown_min, severity) VALUES
  ('ccu_spike',            '{"pct": 50, "min_ccu": 10, "window_min": 10}', 30, 'info'),
  ('ccu_drop',             '{"pct": 40, "min_ccu": 10, "window_min": 10}', 30, 'warning'),
  ('departure_surge',      '{"multiplier": 3, "min_leaves": 10}', 30, 'warning'),
  ('revenue_spike',        '{"multiplier": 3, "min_robux": 500}', 60, 'info'),
  ('purchase_errors',      '{"min_errors": 1}', 15, 'critical'),
  ('server_failures',      '{"min_lost": 2, "window_min": 15}', 30, 'critical'),
  ('ingestion_outage',     '{"silent_min": 5}', 15, 'critical'),
  ('completion_rate_shift','{"pct_points": 15, "min_runs": 20}', 360, 'warning');

CREATE TABLE alert_events (
  id           bigserial PRIMARY KEY,
  env          text NOT NULL,
  kind         text NOT NULL,
  severity     text NOT NULL,
  title        text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  fired_at     timestamptz NOT NULL DEFAULT now(),
  notified_at  timestamptz,
  notify_error text,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX alert_events_time ON alert_events (env, fired_at DESC);

CREATE TABLE report_runs (
  kind        text NOT NULL,                 -- daily | weekly
  period_key  text NOT NULL,                 -- e.g. 2026-10-26 or 2026-W43
  sent_at     timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  error       text,
  PRIMARY KEY (kind, period_key)
);

-- in-game counters the servers report (e.g. purchase-processing errors) — summed, never per player
CREATE TABLE server_counters (
  env        text NOT NULL,
  name       text NOT NULL,
  minute     timestamptz NOT NULL,
  value      bigint NOT NULL,
  PRIMARY KEY (env, name, minute)
);

-- job leadership / bookkeeping
CREATE TABLE job_state (
  name        text PRIMARY KEY,
  last_run_at timestamptz,
  last_ok_at  timestamptz,
  last_error  text,
  info        jsonb NOT NULL DEFAULT '{}'
);
