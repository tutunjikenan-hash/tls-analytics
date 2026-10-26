# TLS Analytics

Private, real-time analytics for **The Last Shift** (Roblox). Game servers send events straight to this
dashboard over HTTPS; numbers appear within seconds instead of Roblox's 24–48 hour delay.

- **Live**: concurrent players, servers, joins and leaves, stage per player, regions (5 s updates, SSE)
- **Overview, growth, engagement, retention**: visits, DAU/WAU/MAU, new vs returning, playtime, D1–D30 cohorts
- **Revenue**: confirmed developer-product and game-pass purchases, gross vs estimated vs verified earnings
- **Gameplay**: runs per chapter and night, completion, failure causes, funnel, where players leave
- **Server health, alerts** (Discord), daily and weekly reports, CSV export, users and roles, audit log

Nothing is estimated where it can be measured, and nothing is shown that isn't measured: empty
periods show "no data", comparisons with periods before tracking began are not shown, and revenue
that game servers can't see (Premium Payouts, etc.) is listed as not tracked.

```
Roblox game servers ──HTTPS batches──▶ /api/ingest/v1/events ──▶ PostgreSQL ◀── background jobs
 (TLSAnalytics Luau)   key + request id   validate · dedupe       raw + base     reaper · CCU ·
                                                                   + aggregates   rollups · alerts
                                       dashboard (Next.js) ◀── SSE live stream ─┘
```

## Quick start (local)

```bash
npm ci
cp .env.example .env.local          # set DATABASE_URL, PLAYER_ID_PEPPER, APP_URL=http://localhost:3000, COOKIE_SECURE=false, DATABASE_SSL=disable
npm run db:migrate
npm run user:create -- --email you@example.com --name "You" --role owner
npm run dev                          # http://localhost:3000
npm run key:create -- --name Simulator --env simulation
TLS_INGEST_KEY=tls_... npm run simulate -- --backfill-days 6 --live-minutes 5
npm test                             # needs a Postgres; uses its own throw-away *_test database
```

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, tables, jobs |
| [docs/METRICS.md](docs/METRICS.md) | Exact definition of every number |
| [docs/STUDIO_INSTALL.md](docs/STUDIO_INSTALL.md) | Installing the Roblox scripts, HTTP, secrets |
| [docs/PURCHASES.md](docs/PURCHASES.md) | ProcessReceipt and game-pass integration, reconciliation |
| [docs/INSTRUMENTATION.md](docs/INSTRUMENTATION.md) | Gameplay events, `TLSAnalytics.track`, adding new ones |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Hosting (Railway / Fly / Render + Supabase / Neon), Docker |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, RBAC, ingest security, privacy, retention |
| [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md) | Tests, simulator, Studio testing |
| [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md) | Before turning it on for real players |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Radix UI (shadcn-style components) ·
Recharts · PostgreSQL 16 · zod · Server-Sent Events · Vitest. Luau on the Roblox side.
