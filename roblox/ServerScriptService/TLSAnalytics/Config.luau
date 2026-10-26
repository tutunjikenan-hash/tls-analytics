--[[
	TLSAnalytics configuration (ModuleScript, server only).
	Nothing secret lives here: the ingest key is a Roblox Secret (Creator Hub → your experience →
	Secrets), read with HttpService:GetSecret and sent only in the Authorization header.
]]
return {
	-- the dashboard's ingest endpoint (must be https in a live game)
	Endpoint = "https://YOUR-DASHBOARD-DOMAIN/api/ingest/v1/events",

	-- name of the Roblox Secret that holds the ingest key (tls_...)
	SecretName = "tls_analytics_key",

	-- live servers send "production"; Studio play-tests are always sent as "studio"
	Environment = "production",

	-- set false to switch everything off without removing the scripts
	Enabled = true,

	-- also send from Studio play-tests (into the separate "studio" environment)
	SendFromStudio = true,

	FlushSeconds = 5, -- send queued events at least this often
	FlushAtEvents = 100, -- or as soon as this many are queued
	HeartbeatSeconds = 10, -- server + player heartbeat (live CCU)
	MaxBatch = 400, -- events per request (server accepts 500)
	MaxQueue = 5000, -- oldest heartbeats are dropped first when the endpoint is unreachable for long
	ShutdownFlushSeconds = 20, -- BindToClose budget

	Debug = false, -- print each request result to the output
}
