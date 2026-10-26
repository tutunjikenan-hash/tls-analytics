--[[
	TLSAnalyticsBoot (Script, ServerScriptService) — starts the analytics client.
	Requires: Game Settings → Security → Allow HTTP Requests = ON, and the Roblox Secret
	"tls_analytics_key" (see docs/STUDIO_INSTALL.md).
]]
local TLSAnalytics = require(script.Parent:WaitForChild("TLSAnalytics"))
local ok, err = pcall(TLSAnalytics.start)
if not ok then
	warn("[TLSAnalytics] failed to start: " .. tostring(err))
end
