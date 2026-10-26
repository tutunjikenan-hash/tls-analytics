# Production checklist

Dashboard
- [ ] Deployed over HTTPS; `APP_URL` is that URL; `/api/health` returns ok
- [ ] `PLAYER_ID_PEPPER` is 32+ random characters and stored somewhere safe (never change it)
- [ ] `DATABASE_SSL=require`; database backups enabled
- [ ] At least one instance always running (not scaled to zero)
- [ ] Owner signed in; `BOOTSTRAP_OWNER_*` removed
- [ ] Reporting time zone set; creator share checked
- [ ] Discord webhook set, alert rules reviewed; a test alert or report received
- [ ] `ROBLOX_UNIVERSE_ID` set (Roblox-reported visits/favorites)
- [ ] Users have the smallest role they need

Roblox
- [ ] Production ingest key created (environments: production, studio)
- [ ] Secret `tls_analytics_key` in Creator Hub with the dashboard domain; Studio local secret for testing
- [ ] Allow HTTP Requests on
- [ ] Four scripts installed in ServerScriptService; `Config.Endpoint` points to the dashboard
- [ ] ShopService ProcessReceipt line changed (PURCHASES.md)
- [ ] Studio test: appear and disappear on Live (studio env), a run on Gameplay, no warnings in Output
- [ ] File → Save, then publish when ready
- [ ] First hour after publishing: Live shows players, Server health shows no rejected events,
      Settings → Background jobs all ok
