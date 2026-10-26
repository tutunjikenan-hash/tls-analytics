# Deployment

The app is one Docker image (Next.js standalone server). It needs a long-running process (SSE and
background jobs), so use a container host, not serverless functions.

Recommended: **Railway**, **Fly.io** or **Render** for the app + **Supabase** or **Neon** for Postgres
(any Postgres 14+ works).

## 1. Database

Create a Postgres database. Copy a connection string that supports long-lived connections
(Supabase: the *session* pooler or direct connection, not the transaction pooler — advisory locks
need a session). Set `DATABASE_SSL=require`.

## 2. Environment variables

See `.env.example`. Required: `DATABASE_URL`, `DATABASE_SSL`, `PLAYER_ID_PEPPER` (32+ random
characters; never change it later), `APP_URL` (the https URL). For the first start without a shell:
`BOOTSTRAP_OWNER_EMAIL` + `BOOTSTRAP_OWNER_PASSWORD` (12+ characters) — remove both after you sign in.
Optional: `DISCORD_WEBHOOK_URL`, `ROBLOX_UNIVERSE_ID`.

## 3. Deploy

- **Railway / Render**: new service from this repository; it builds the `Dockerfile`. Expose port 3000,
  health check path `/api/health`.
- **Fly.io**: `fly launch` (detects the Dockerfile), `fly secrets set DATABASE_URL=… PLAYER_ID_PEPPER=…`,
  `fly deploy`. Keep at least one machine always running (`min_machines_running = 1`), otherwise jobs
  and alerts stop while it sleeps.
- **Docker anywhere**: `docker build -t tls-analytics . && docker run -p 3000:3000 --env-file .env tls-analytics`
  behind an HTTPS reverse proxy (Caddy, nginx). `docker compose up --build` runs it with a local Postgres.

On start the server applies pending migrations (advisory-locked; `RUN_MIGRATIONS=false` to opt out),
then starts the jobs. Several instances are fine: one is elected job leader.

Client IPs (for the sign-in limit) are taken from the address your host's proxy appends to
`X-Forwarded-For`. If you put a second proxy in front (e.g. Cloudflare), all sign-ins may share one
limit; that only slows sign-in attempts, it never blocks game data.

The proxy must not buffer `text/event-stream` (the app sends `X-Accel-Buffering: no` for nginx).

## 4. After the first deploy

1. Sign in with the bootstrap owner, then remove the `BOOTSTRAP_OWNER_*` variables and redeploy.
2. Settings → set the reporting time zone.
3. Settings → Game server keys → create the production key → follow [STUDIO_INSTALL.md](STUDIO_INSTALL.md).
4. Add users with the least role they need.

## Backups

Use the provider's automated backups (Supabase/Neon/RDS: daily, point-in-time recovery). The data
that cannot be rebuilt is `sessions`, `players`, `purchases`, `runs`, `gameplay_events`, `servers`
and the dashboard tables; every aggregate can be recomputed with `npm run rollup:rebuild`.

## Scaling notes

The ingest path does one transaction per batch. A few hundred concurrent players produce roughly one
request per server every 5 s. Postgres on a small instance handles thousands of CCU; raise
`DATABASE_POOL_MAX` and the instance size before anything else.
