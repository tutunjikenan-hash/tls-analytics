--!nocheck
-- Minimal Roblox mocks + a fake clock/scheduler, enough to run TLSAnalytics outside Roblox.
local REAL_BASE_MS = tonumber(BASE_MS) -- injected by the runner
local now = 0 -- fake seconds
local tasks = {}
local os = setmetatable({ clock = function() return now end }, { __index = os })

local function schedule(co, at, ...) table.insert(tasks, { co = co, at = at, args = table.pack(...) }) end
task = {}
function task.spawn(fn, ...)
	local co = type(fn) == "thread" and fn or coroutine.create(fn)
	local ok, err = coroutine.resume(co, ...)
	if not ok then print("TASKERR|" .. tostring(err)) end
	return co
end
function task.wait(t)
	t = t or 0.03
	local start = now
	coroutine.yield({ wait = math.max(t, 0.03) })
	return now - start
end
function task.delay(t, fn, ...) local co = coroutine.create(fn); schedule(co, now + t, ...) end
local function resumeWithWait(co, ...)
	local ok, r = coroutine.resume(co, ...)
	if not ok then print("TASKERR|" .. tostring(r)); return end
	if coroutine.status(co) == "suspended" and type(r) == "table" and r.wait then schedule(co, now + r.wait) end
end
-- patch spawn so yields inside spawned threads are scheduled
function task.spawn(fn, ...)
	local co = type(fn) == "thread" and fn or coroutine.create(fn)
	resumeWithWait(co, ...)
	return co
end
function RUN_UNTIL(t)
	while true do
		table.sort(tasks, function(a, b) return a.at < b.at end)
		local nxt = tasks[1]
		if not nxt or nxt.at > t then now = t; return end
		table.remove(tasks, 1)
		now = math.max(now, nxt.at)
		resumeWithWait(nxt.co, table.unpack(nxt.args, 1, nxt.args.n))
	end
end

-- JSON like Roblox's JSONEncode (empty table -> [])
local function enc(v)
	local t = type(v)
	if t == "nil" then return "null" end
	if t == "boolean" then return v and "true" or "false" end
	if t == "number" then
		if v == math.floor(v) and math.abs(v) < 2^53 then return string.format("%d", v) end
		return string.format("%.14g", v)
	end
	if t == "string" then
		return '"' .. v:gsub('[%c"\\]', function(c)
			if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
			return string.format("\\u%04x", string.byte(c))
		end) .. '"'
	end
	if t == "table" then
		if next(v) == nil then return "[]" end
		if #v > 0 then
			local out = {}
			for i = 1, #v do out[i] = enc(v[i]) end
			return "[" .. table.concat(out, ",") .. "]"
		end
		local out = {}
		for k, x in pairs(v) do if x ~= nil then table.insert(out, enc(tostring(k)) .. ":" .. enc(x)) end end
		table.sort(out)
		return "{" .. table.concat(out, ",") .. "}"
	end
	error("cannot encode " .. t)
end

local function signal()
	local s = { fns = {} }
	function s:Connect(fn) table.insert(self.fns, fn); return { Disconnect = function() end } end
	function s:Fire(...) for _, fn in ipairs(self.fns) do task.spawn(fn, ...) end end
	return s
end

local guidN = 0
RESPONSES = {} -- queue of status codes; default 200
local HttpService = {
	GenerateGUID = function(_, braces)
		guidN += 1
		return string.format("%08X-%04X-4000-8000-%012X", guidN, REAL_BASE_MS % 65536, guidN)
	end,
	JSONEncode = function(_, v) return enc(v) end,
	GetSecret = function(_, name)
		if name ~= "tls_analytics_key" then error("no such secret") end
		return { AddPrefix = function(_, p) return p .. SECRET end }
	end,
	RequestAsync = function(_, req)
		local status = table.remove(RESPONSES, 1) or 200
		task.wait(0.2) -- network time
		print("REQ|" .. status .. "|" .. req.Headers["X-TLS-Request-Id"] .. "|" .. req.Headers["Authorization"] .. "|" .. req.Body)
		return { StatusCode = status, Body = "{}" }
	end,
}
PlayersList = {}
local Players = { PlayerAdded = signal(), PlayerRemoving = signal() }
function Players:GetPlayers() local o = {} for _, p in ipairs(PlayersList) do table.insert(o, p) end return o end
function Players:GetPlayerByUserId(id) for _, p in ipairs(PlayersList) do if p.UserId == id then return p end end return nil end
OWNS = {} -- [uid..":"..pass] = list of answers
local Marketplace = { PromptGamePassPurchaseFinished = signal(), PromptProductPurchaseFinished = signal() }
function Marketplace:GetProductInfo(id, infoType)
	if infoType == "GamePass" then return { Name = "Test Pass", PriceInRobux = 199 } end
	return { Name = "Test Product " .. id }
end
function Marketplace:UserOwnsGamePassAsync(uid, pass)
	local q = OWNS[uid .. ":" .. pass]
	return q and (table.remove(q, 1) or q.last) or false
end
local services = {
	HttpService = HttpService,
	Players = Players,
	RunService = { IsStudio = function() return false end },
	MarketplaceService = Marketplace,
	LocalizationService = { GetCountryRegionForPlayerAsync = function() task.wait(0.1); return "US" end },
	Stats = { GetTotalMemoryUsageMb = function() return 1234.5 end },
}
CLOSE = nil
game = {
	JobId = "job-harness-1", PlaceId = 134111235673543, PlaceVersion = 812, PrivateServerId = "", PrivateServerOwnerId = 0,
	GetService = function(_, n) return services[n] end,
	BindToClose = function(_, fn) CLOSE = fn end,
}
workspace = { GetRealPhysicsFPS = function() return 59.7 end }
Enum = {
	ProductPurchaseDecision = { PurchaseGranted = "PurchaseGranted", NotProcessedYet = "NotProcessedYet" },
	InfoType = { Product = "Product", GamePass = "GamePass" },
}
DateTime = { now = function() return { UnixTimestampMillis = REAL_BASE_MS + math.floor(now * 1000) } end }
function typeof(v) if type(v) == "table" and v.__instance then return "Instance" end return type(v) end
function warn(...) print("WARN|" .. table.concat({ ... }, " ")) end
function MakePlayer(uid, joinData)
	local p = { __instance = true, UserId = uid, Name = "P" .. uid, Parent = true }
	function p:IsA(c) return c == "Player" end
	function p:GetJoinData() return joinData or {} end
	return p
end
CONFIG = {
	Endpoint = "http://localhost:3000/api/ingest/v1/events", SecretName = "tls_analytics_key", Environment = "simulation",
	Enabled = true, SendFromStudio = true, FlushSeconds = 5, FlushAtEvents = 100, HeartbeatSeconds = 10, MaxBatch = 400,
	MaxQueue = 5000, ShutdownFlushSeconds = 20, Debug = false,
}
script = { WaitForChild = function(_, n) return { __module = CONFIG } end }
