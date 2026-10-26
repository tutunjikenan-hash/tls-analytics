# Security and privacy

## Dashboard access
- Email + password (bcrypt cost 12, 12+ characters). Sign-in is limited to 10 attempts per minute per
  IP (the address the hosting proxy appended to X-Forwarded-For, which clients can't forge); 10 failed
  attempts lock the account for 15 min (an owner can unlock users in Settings → Users). Unknown emails take the same time to reject as wrong passwords.
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Strict`, `Secure` (in production)
  cookie. Only the SHA-256 of the token is stored. Sessions expire (`SESSION_TTL_HOURS`) and are
  revoked on sign-out, when a user is disabled, their role changes or their password is reset.
- Every mutating request must come from the dashboard's own origin (in addition to SameSite).
- Roles: **viewer** (dashboards, no revenue) < **analyst** (+ revenue, CSV) < **admin** (+ settings,
  keys, alerts, reconciliation, audit) < **owner** (+ users). The last active owner can't be removed.
- Audit log: sign-ins (and failures), settings, alert rules, keys, users, exports, reconciliation.
- Security headers: no framing, nosniff, no referrer, HSTS, `noindex`.

## Ingest
- Keys are random 256-bit (`tls_…`), shown once; only SHA-256 is stored; compared in constant time.
  Each key is limited to the environments it may write (e.g. a simulator key can't write production).
  Revocation takes effect within 30 s.
- On Roblox the key is a **Secret** (`HttpService:GetSecret`), only usable by server scripts and only
  towards the configured domain. It is never in a script, never sent to clients. All analytics are
  sent from the server; there is no client → analytics path.
- Replay protection: every request carries a unique `X-TLS-Request-Id` (stored, a repeat does
  nothing) and `sentAt` must be within 15 minutes. Event ids are deduplicated forever (within raw
  event retention, minimum 8 days > the 7-day event age limit). Purchases are unique per `PurchaseId`.
- Validation: every field is schema-checked; bad events are rejected individually; body ≤ 512 KB,
  ≤ 500 events; timestamps within 7 days back / 5 minutes ahead.
- Rate limits: per key (60 000 requests/min) and per server (120/min, a server normally sends ~12) → `429` + `Retry-After`.

## Privacy
- Roblox UserIds are never stored: `player_key = HMAC-SHA256(PLAYER_ID_PEPPER, userId)`, first 24
  hex chars. Without the pepper the keys can't be linked back to accounts. No names, no chat, no IPs
  (dashboard IPs are stored only as keyed hashes in the audit log).
- Country comes from `LocalizationService` (country level only).
- Retention: raw events 90 days, server heartbeats 14 days (Settings), ingest request ids 2 days,
  audit log 400 days. Aggregates and pseudonymous facts are kept to compute history.
- Deleting a player's data on request: compute their key with the pepper and delete rows with that
  `player_key` (players, sessions, player_days, purchases, runs, gameplay_events).

## Secrets you manage
`PLAYER_ID_PEPPER`, `DATABASE_URL`, `DISCORD_WEBHOOK_URL`, the ingest key (Roblox Secret), the
bootstrap password (remove after first use). None of them reach the browser.
