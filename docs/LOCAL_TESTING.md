# Local testing

## Automated tests

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/tls_test npm test
```

The suite creates the database (its name must end in `_test`), migrates it, runs, and drops it.
It never touches another database. 54 tests cover:

- ingest: keys, environments, request ids, replay window, malformed events, rate limits, no UserIds stored
- deduplication: retried requests, re-batched events, duplicate purchase ids, repeats inside one batch
- sessions and visits: playtime, clipping, teleports continuing a visit, CCU counting a player once,
  out-of-order events, inferred starts
- disconnected servers: reaper closes at the last heartbeat, a late heartbeat reopens, shutdowns
- revenue: confirmed only, gross vs estimated, pending game passes, refunds, no downgrade
- rollups: daily/hourly match base tables, idempotent, time zones, late events folded in
- retention: calendar cohorts, unfinished days never written
- date ranges incl. a 25-hour DST day
- every dashboard page on an empty database (no fake zeros) and with data
- alerts (cooldowns, baselines, empty game ≠ outage), auth (lockout, hashing, revocation), roles
- revenue never reaches the viewer role; late teleports are re-linked; refunds reach the aggregates;
  a missing game-pass price is corrected; Studio test players (negative UserIds) are accepted

## The Luau client, end to end

`roblox/tests/` runs the **real** `TLSAnalytics` module under the Luau runtime with mocked Roblox
services and a simulated clock, then replays the requests it produced against a running dashboard:

```bash
# luau binaries: https://github.com/luau-lang/luau/releases (luau-ubuntu.zip / luau-macos.zip / luau-windows.zip)
TLS_INGEST_KEY=tls_... LUAU=/path/to/luau DATABASE_URL=... npm run test:luau
```

24 checks: a failed request (503, then a proxy-style 401) is retried with the same request id;
a receipt granted before the client started is kept; NaN/infinite values and broken UTF-8 are cleaned; no event sent twice; join data
(teleport, share link) and country; a granted receipt is recorded with `CurrencySpent`, while
NotProcessedYet and erroring receipts are not (errors are re-raised unchanged); a game pass counts
only after ownership is confirmed; counters; `track` validation; heartbeats with stage; leave and
shutdown; nothing sent after `server_stop`; and the backend accepts every event with the game's
real place id.

## Simulator

Sends realistic traffic over HTTP, exactly like game servers, into the **simulation** environment
(it refuses production):

```bash
npm run key:create -- --name Simulator --env simulation
TLS_INGEST_KEY=tls_... npm run simulate -- --backfill-days 6 --live-minutes 5 --players 400
npm run db:clear-env -- --env simulation     # start over (never clears production)
```

Then pick **Simulation** in the environment switch. Products are fictional ("Sim …").

## Studio

Play-tests send to the **studio** environment (see STUDIO_INSTALL.md). Use a local server with
2–3 players to test teleports, multiple sessions and CCU.
