# Installing the Roblox side

Do this after the dashboard is deployed (you need its https URL and an ingest key).
Nothing here changes gameplay, saves or purchases. **Do not publish until you have tested in Studio.**

## 1. Create an ingest key

Dashboard → Settings → Game server keys → create a key named "Production servers" allowing
`production` and `studio`. Copy it (shown once). It starts with `tls_`.

## 2. Store it as a Roblox Secret (never in a script)

- **Live servers**: Creator Hub → your experience → **Secrets** → *Create secret*:
  name `tls_analytics_key`, value = the key, domain = your dashboard host (e.g. `analytics.example.com`).
- **Studio play-tests**: Studio → Game Settings → **Security** → *Secrets* (local secrets for Studio),
  for example `{"tls_analytics_key": ["tls_…", "analytics.example.com"]}`.
  Check Roblox's current *Secrets Store* documentation if the field format has changed.

Secrets are readable only by server scripts (`HttpService:GetSecret`), can only be sent to the
domain you set, and are never visible to clients. The key is never written into any script.

## 3. Allow HTTP requests

Game Settings → **Security** → *Allow HTTP Requests* → On. (Required for HttpService.)

## 4. Add the scripts

From `roblox/ServerScriptService/` in this project, create in **ServerScriptService**:

| Instance | Type | Source |
|---|---|---|
| `TLSAnalytics` | ModuleScript | `TLSAnalytics/init.luau` |
| `TLSAnalytics.Config` | ModuleScript (child of TLSAnalytics) | `TLSAnalytics/Config.luau` — set `Endpoint` to `https://<your host>/api/ingest/v1/events` |
| `TLSAnalyticsBoot` | Script | `TLSAnalyticsBoot.server.luau` |
| `TLSAnalyticsGameHooks` | Script | `TLSAnalyticsGameHooks.server.luau` |

Nothing goes in ReplicatedStorage or StarterPlayer: clients never get the code or the key.

## 5. Record purchases (one line in ShopService)

See [PURCHASES.md](PURCHASES.md). Without this line everything else works; developer-product revenue
would simply not be recorded (game passes are recorded either way).

## 6. Test in Studio

1. Play (one player, or a local server with 2 players). Studio sessions are sent as environment
   **studio**, never production.
2. Output should show no `[TLSAnalytics]` warnings. Set `Config.Debug = true` to print each request.
3. In the dashboard switch the environment to **Studio tests**: within ~15 s you appear on Live
   players; leave and you disappear within ~45 s.
4. Start a shift and finish or fail it: Gameplay shows a run.
5. Purchases in Studio are test purchases and are recorded in the studio environment only.

Common warnings: *secret is not available* (step 2), *HTTP requests are not enabled* (step 3),
*rejected the ingest key (401/403)* (wrong key, revoked, or key not allowed for `studio`).

## 7. Go live

Save (File → Save), then publish when you decide to. Production servers start sending immediately;
the dashboard's environment switch defaults to Production.

To switch analytics off without removing anything: `Config.Enabled = false`, or revoke the key in
the dashboard (servers stop within 30 s).
