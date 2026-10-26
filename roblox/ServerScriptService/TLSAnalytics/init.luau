--[[
	TLSAnalytics (ModuleScript, ServerScriptService) — server-side analytics client for the TLS dashboard.

	What it sends (all from the server; clients can never send analytics or see the key):
	  • session_start / session_end   for every player on this server (+ country, teleport, share link)
	  • server_start / server_heartbeat / server_stop   heartbeat every 10 s with the players present (live CCU)
	  • purchase   only after the game's own ProcessReceipt returned PurchaseGranted, and game passes only
	               after UserOwnsGamePassAsync confirms ownership
	  • game       gameplay events via TLSAnalytics.track(...)
	  • counter    per-minute counts (purchase prompts, receipt errors, ...)

	Delivery: events are queued, sent in batches (every 5 s or 100 events) with a unique request id per
	batch; a failed batch is retried with exponential backoff using the SAME request id, so the backend
	can never count it twice. Every call is wrapped so analytics can never break gameplay or purchases.

	Privacy: the Roblox UserId is sent over HTTPS and the backend immediately replaces it with a keyed
	hash (HMAC); it is never stored.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local MarketplaceService = game:GetService("MarketplaceService")
local LocalizationService = game:GetService("LocalizationService")
local Stats = game:GetService("Stats")

local Config = require(script:WaitForChild("Config"))

local M = {}
M.Config = Config

local IS_STUDIO = RunService:IsStudio()
local ENV = IS_STUDIO and "studio" or Config.Environment
local SERVER_ID = (game.JobId ~= "" and game.JobId) or ("studio-" .. HttpService:GenerateGUID(false))
local SERVER_KIND = IS_STUDIO and "studio"
	or (game.PrivateServerId ~= "" and (game.PrivateServerOwnerId ~= 0 and "private" or "reserved"))
	or "public"

local started = false
local disabled = false
local closing = false -- set in BindToClose: no more heartbeats after server_stop
local authHeader = nil -- Secret (with "Bearer " prefix)
local queue = {} -- pending events
local inFlight = false
local backoffUntil = 0
local backoffStep = 0
local sessions = {} -- [Player] = { sid, joinedAt }
local stages = {} -- [Player] = stage string
local counters = {} -- [name] = n (this minute)
local productNames = {} -- [productId] = name
local passPrices = {} -- [passId] = { price, name }
local startClock = os.clock()

local function log(...)
	if Config.Debug then
		print("[TLSAnalytics]", ...)
	end
end
local function warnOnce(key, msg)
	M._warned = M._warned or {}
	if not M._warned[key] then
		M._warned[key] = true
		warn("[TLSAnalytics] " .. msg)
	end
end

-- cut a string to at most maxBytes without splitting a UTF-8 character (invalid UTF-8 can't be encoded)
local function clip(v: string, maxBytes: number): string
	if utf8.len(v) == nil then
		v = string.gsub(v, "[\128-\255]", "?") -- not valid UTF-8 at all: keep it ASCII
	end
	if #v <= maxBytes then
		return v
	end
	local cut = maxBytes
	while cut > 0 and utf8.len(string.sub(v, 1, cut)) == nil do
		cut -= 1
	end
	return string.sub(v, 1, cut)
end

local function finite(n: number): boolean
	return n == n and n ~= math.huge and n ~= -math.huge
end

local function nowMs(): number
	return DateTime.now().UnixTimestampMillis
end

local function guid(): string
	return string.lower((HttpService:GenerateGUID(false)))
end

-- events queued before start() (e.g. a receipt processed while the boot script is still loading) are
-- kept and sent once the client starts; nothing is queued once analytics is switched off
local function push(ev)
	if disabled then
		return
	end
	-- JSONEncode turns an empty table into [] — never send an empty object
	if type(ev.d) == "table" and next(ev.d) == nil then
		ev.d = nil
	end
	ev.id = guid()
	ev.ts = ev.ts or nowMs()
	if #queue >= Config.MaxQueue then
		-- make room: oldest heartbeat first, then the oldest other non-purchase event.
		-- Purchases are never dropped (the queue may exceed MaxQueue by purchases alone).
		local victim = nil
		for i, q in ipairs(queue) do
			if q.type == "server_heartbeat" then
				victim = i
				break
			end
		end
		if not victim then
			for i, q in ipairs(queue) do
				if q.type ~= "purchase" then
					victim = i
					break
				end
			end
		end
		if victim then
			table.remove(queue, victim)
		end
		warnOnce("queue_full", "queue full (endpoint unreachable?) — dropping oldest non-purchase events")
	end
	table.insert(queue, ev)
end

----------------------------------------------------------------------------
-- HTTP delivery
----------------------------------------------------------------------------
-- the dashboard's own error codes that mean "this key will not work"; anything else (a proxy, a WAF,
-- a deploy in progress) is treated as temporary
local KEY_ERRORS = { invalid_key = true, missing_bearer_key = true, environment_not_allowed_for_key = true }

local function send(batch, requestId): (boolean, number?, string?)
	local okEnc, body = pcall(HttpService.JSONEncode, HttpService, {
		v = 1,
		env = ENV,
		serverId = SERVER_ID,
		placeId = game.PlaceId,
		placeVersion = game.PlaceVersion,
		serverKind = SERVER_KIND,
		sentAt = nowMs(),
		events = batch,
	})
	if not okEnc then
		return false, -1, nil -- this batch cannot be encoded (see flush: it is split to isolate the bad event)
	end
	local ok, res = pcall(HttpService.RequestAsync, HttpService, {
		Url = Config.Endpoint,
		Method = "POST",
		Headers = {
			["Content-Type"] = "application/json",
			["Authorization"] = authHeader,
			["X-TLS-Request-Id"] = requestId,
		},
		Body = body,
	})
	if not ok then
		log("network error:", res)
		return false, nil, nil
	end
	log("HTTP", res.StatusCode, #batch, "events")
	local errorCode = nil
	if res.StatusCode >= 400 then
		pcall(function()
			errorCode = HttpService:JSONDecode(res.Body).error
		end)
	end
	return res.StatusCode >= 200 and res.StatusCode < 300, res.StatusCode, errorCode
end

local pendingBatch = nil -- { events, requestId } kept across retries so the request id stays the same

local function backoff(maxSeconds: number)
	backoffStep = math.min(backoffStep + 1, 8)
	backoffUntil = os.clock() + math.min(maxSeconds, 2 ^ backoffStep) * (0.75 + math.random() * 0.5)
end

-- a batch the server cannot accept as a whole: retry the halves (new request ids, nothing was
-- stored); a single event that still fails is dropped, so one bad value never blocks the rest
local function splitPending(reason: string)
	local evs = pendingBatch.events
	if #evs <= 1 then
		warnOnce("dropped_" .. reason, "dropped an event the dashboard could not accept (" .. reason .. ")")
		pendingBatch = nil
		return
	end
	local half = math.floor(#evs / 2)
	local rest = table.move(evs, half + 1, #evs, 1, {})
	for i = #rest, 1, -1 do
		table.insert(queue, 1, rest[i])
	end
	pendingBatch = { events = table.move(evs, 1, half, 1, {}), requestId = guid() }
end

local function flushOnce(force: boolean?)
	if not force and os.clock() < backoffUntil then
		return
	end
	if not pendingBatch then
		if #queue == 0 then
			return
		end
		local n = math.min(#queue, Config.MaxBatch)
		local events = table.move(queue, 1, n, 1, {})
		for _ = 1, n do
			table.remove(queue, 1)
		end
		pendingBatch = { events = events, requestId = guid() }
	end
	local ok, status, errorCode = send(pendingBatch.events, pendingBatch.requestId)
	if ok then
		pendingBatch = nil
		backoffStep = 0
		backoffUntil = 0
		return
	end
	if (status == 401 or status == 403) and errorCode and KEY_ERRORS[errorCode] then
		-- the key is wrong or revoked: keep the data and try again every few minutes (the key may be fixed)
		warnOnce("auth", "the dashboard rejected the ingest key (" .. tostring(errorCode) .. "). Check the Roblox secret and the key's environments; retrying every 5 minutes.")
		backoffUntil = os.clock() + 300
		return
	end
	if status == -1 or status == 400 or status == 413 then
		splitPending(status == -1 and "encode" or tostring(status))
		return
	end
	-- 429 / 5xx / proxy errors / network: exponential backoff with jitter, same batch + request id
	backoff(60)
	warnOnce("retrying", "the dashboard is unreachable (" .. tostring(status or "network") .. "); retrying with backoff")
end

-- never leaves inFlight stuck, whatever happens inside
local function flush(force: boolean?)
	if disabled or inFlight or not authHeader then
		return
	end
	inFlight = true
	local ok, err = pcall(flushOnce, force)
	inFlight = false
	if not ok then
		warnOnce("flush_error", "flush failed: " .. tostring(err))
		pendingBatch = nil
	end
end

----------------------------------------------------------------------------
-- counters (aggregated per minute)
----------------------------------------------------------------------------
function M.count(name: string, n: number?)
	if type(name) ~= "string" or not string.match(name, "^[a-z][a-z0-9_]+$") then
		return
	end
	counters[name] = (counters[name] or 0) + (n or 1)
end

local function flushCounters()
	for name, n in pairs(counters) do
		if n > 0 then
			push({ type = "counter", d = { name = name, value = math.floor(n) } })
		end
	end
	counters = {}
end

----------------------------------------------------------------------------
-- sessions
----------------------------------------------------------------------------
local function joinInfo(player: Player)
	local teleportIn, referred = false, false
	pcall(function()
		local jd = player:GetJoinData()
		-- lobby → shift servers are the same place: arriving from it continues the same visit
		teleportIn = jd and jd.SourcePlaceId ~= nil and jd.SourcePlaceId == game.PlaceId
		referred = jd and jd.ReferredByPlayerId ~= nil and jd.ReferredByPlayerId ~= 0
	end)
	return teleportIn, referred
end

local function onJoin(player: Player)
	if sessions[player] then
		return
	end
	local s = { sid = guid(), joinedAt = os.clock(), ts = nowMs() }
	sessions[player] = s
	local teleportIn, referred = joinInfo(player)
	task.spawn(function()
		local country = nil
		pcall(function()
			country = LocalizationService:GetCountryRegionForPlayerAsync(player)
		end)
		local d = { teleportIn = teleportIn or nil, referred = referred or nil }
		if type(country) == "string" and string.match(country, "^%u%u$") then
			d.country = country
		end
		push({ type = "session_start", sid = s.sid, uid = player.UserId, ts = s.ts, d = d })
	end)
end

local function onLeave(player: Player, reason: string?)
	local s = sessions[player]
	if not s then
		return
	end
	sessions[player] = nil
	stages[player] = nil
	push({ type = "session_end", sid = s.sid, uid = player.UserId, d = { reason = reason or "left", durationSec = math.floor(os.clock() - s.joinedAt) } })
end

function M.sessionId(player: Player): string?
	local s = sessions[player]
	return s and s.sid
end

--- Where the player is right now (shown on the Live page), e.g. "lobby", "night_3", "results".
function M.setStage(player: Player, stage: string?)
	if typeof(player) == "Instance" and player:IsA("Player") then
		stages[player] = stage and clip(tostring(stage), 64) or nil
	end
end

local function heartbeat()
	local list = {}
	for player, s in pairs(sessions) do
		if player.Parent then
			table.insert(list, { sid = s.sid, uid = player.UserId, stage = stages[player] })
		end
	end
	local fps = nil
	pcall(function()
		fps = math.floor(workspace:GetRealPhysicsFPS() + 0.5)
	end)
	local mem = nil
	pcall(function()
		mem = math.floor(Stats:GetTotalMemoryUsageMb())
	end)
	push({ type = "server_heartbeat", d = { players = list, fps = fps, memMb = mem, uptimeSec = math.floor(os.clock() - startClock) } })
end

----------------------------------------------------------------------------
-- gameplay events
----------------------------------------------------------------------------
--[[
	TLSAnalytics.track(player | nil, "event_name", { runId=, chapter=, stage=, area=, value=, props={...} })
	Names are snake_case (2-48 chars). props: up to 20 string/number/boolean values.
]]
function M.track(player: Player?, name: string, data: { [string]: any }?)
	local ok, err = pcall(function()
		if type(name) ~= "string" or not string.match(name, "^[a-z][a-z0-9_]+$") or #name > 48 then
			warnOnce("bad_name_" .. tostring(name), "event names must be snake_case: " .. tostring(name))
			return
		end
		data = data or {}
		local d = { name = name }
		for _, k in ipairs({ "runId", "chapter", "stage", "area" }) do
			if data[k] ~= nil then
				d[k] = clip(tostring(data[k]), (k == "area" or k == "runId") and 64 or 32)
			end
		end
		if type(data.value) == "number" and finite(data.value) then
			d.value = data.value
		end
		if type(data.props) == "table" then
			local props, n = {}, 0
			for k, v in pairs(data.props) do
				local tv = type(v)
				if n < 20 and type(k) == "string" and (tv == "string" or (tv == "number" and finite(v)) or tv == "boolean") then
					props[clip(k, 40)] = tv == "string" and clip(v, 200) or v
					n += 1
				end
			end
			if n > 0 then
				d.props = props
			end
		end
		local ev = { type = "game", d = d }
		if typeof(player) == "Instance" and player:IsA("Player") then
			ev.uid = player.UserId
			ev.sid = M.sessionId(player)
		end
		push(ev)
	end)
	if not ok then
		warnOnce("track_error", "track failed: " .. tostring(err))
	end
end

----------------------------------------------------------------------------
-- purchases
----------------------------------------------------------------------------
local function productName(productId: number, infoType)
	if productNames[productId] ~= nil then
		return productNames[productId] or nil
	end
	local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, productId, infoType)
	if ok and info then
		productNames[productId] = info.Name -- failures are not cached, so a later purchase tries again
		return info.Name
	end
	return nil
end

--[[
	Wraps the game's ProcessReceipt. The original handler runs exactly as before and its result is
	returned unchanged; a purchase is recorded only when it returned PurchaseGranted. Recording happens
	in a separate thread, so it can never delay or break the receipt.
	Usage (ShopService):  MarketplaceService.ProcessReceipt = TLSAnalytics.wrapProcessReceipt(processReceipt)
]]
function M.wrapProcessReceipt(handler)
	return function(receipt)
		local ok, result = pcall(handler, receipt)
		if not ok then
			M.count("receipt_error")
			error(result, 0) -- same behaviour as before: Roblox treats an error as "not processed" and retries
		end
		if result == Enum.ProductPurchaseDecision.PurchaseGranted then
			task.spawn(function()
				pcall(function()
					local player = Players:GetPlayerByUserId(receipt.PlayerId)
					push({
						type = "purchase",
						uid = receipt.PlayerId,
						sid = player and M.sessionId(player) or nil,
						d = {
							purchaseId = tostring(receipt.PurchaseId),
							kind = "developer_product",
							productId = receipt.ProductId,
							productName = productName(receipt.ProductId, Enum.InfoType.Product),
							robux = math.max(0, math.floor(tonumber(receipt.CurrencySpent) or 0)),
							priceSource = "receipt_currency_spent",
							status = "confirmed",
						},
					})
				end)
			end)
		elseif result == Enum.ProductPurchaseDecision.NotProcessedYet then
			M.count("receipt_not_processed")
		end
		return result
	end
end

local function passInfo(passId: number)
	if passPrices[passId] then
		return passPrices[passId]
	end
	local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, passId, Enum.InfoType.GamePass)
	if ok and info then
		passPrices[passId] = { price = tonumber(info.PriceInRobux) or 0, name = info.Name }
		return passPrices[passId]
	end
	return { price = 0, name = nil }
end

local function recordPass(player: Player, passId: number, status: string)
	local info = passInfo(passId)
	if info.price == 0 and not passPrices[passId] then
		task.wait(5) -- the price lookup failed: try once more (a 0 is corrected server-side by a later report)
		info = passInfo(passId)
	end
	push({
		type = "purchase",
		uid = player.UserId,
		sid = M.sessionId(player),
		d = {
			purchaseId = "gp", -- the backend keys game passes by player + pass (one purchase each)
			kind = "game_pass",
			productId = passId,
			productName = info.name,
			robux = math.max(0, math.floor(info.price)),
			priceSource = "catalog_list_price",
			status = status,
		},
	})
end

-- a game-pass purchase counts only once Roblox confirms ownership (the event alone is not enough)
local function onPassFinished(player: Player, passId: number, purchased: boolean)
	M.count("gamepass_prompt")
	if not purchased then
		return
	end
	task.spawn(function()
		for _, delaySec in ipairs({ 0, 5, 15 }) do
			task.wait(delaySec)
			if not player.Parent then
				break
			end
			local ok, owns = pcall(MarketplaceService.UserOwnsGamePassAsync, MarketplaceService, player.UserId, passId)
			if ok and owns then
				recordPass(player, passId, "confirmed")
				return
			end
		end
		-- not confirmed yet: recorded as pending (not counted as revenue) and re-checked later
		recordPass(player, passId, "pending_verification")
		for _, delaySec in ipairs({ 60, 180 }) do
			task.wait(delaySec)
			local ok, owns = pcall(MarketplaceService.UserOwnsGamePassAsync, MarketplaceService, player.UserId, passId)
			if ok and owns then
				recordPass(player, passId, "confirmed")
				return
			end
		end
	end)
end

----------------------------------------------------------------------------
-- start / shutdown
----------------------------------------------------------------------------
function M.start()
	if started then
		return M
	end
	if not Config.Enabled or (IS_STUDIO and not Config.SendFromStudio) then
		log("disabled by Config")
		disabled = true
		queue = {}
		return M
	end
	local ok, secret = pcall(HttpService.GetSecret, HttpService, Config.SecretName)
	if not ok or not secret then
		warn("[TLSAnalytics] secret '" .. Config.SecretName .. "' is not available (" .. tostring(secret) .. "). Add it in Creator Hub → Secrets (and in Studio: Game Settings → Security). Analytics is off.")
		disabled = true
		queue = {}
		return M
	end
	local okp, prefixed = pcall(function()
		return secret:AddPrefix("Bearer ")
	end)
	if not okp then
		warn("[TLSAnalytics] could not prepare the secret: " .. tostring(prefixed))
		disabled = true
		queue = {}
		return M
	end
	authHeader = prefixed
	started = true

	push({ type = "server_start" })
	for _, p in ipairs(Players:GetPlayers()) do
		onJoin(p)
	end
	Players.PlayerAdded:Connect(onJoin)
	Players.PlayerRemoving:Connect(function(p)
		onLeave(p, "left")
	end)
	MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, passId, purchased)
		pcall(onPassFinished, player, passId, purchased)
	end)
	MarketplaceService.PromptProductPurchaseFinished:Connect(function()
		M.count("purchase_prompt")
	end)

	task.spawn(function()
		local lastHb, lastCounters = 0, os.clock()
		while not disabled do
			local t = os.clock()
			if closing then
				break -- BindToClose owns the final flush
			end
			if t - lastHb >= Config.HeartbeatSeconds then
				lastHb = t
				pcall(heartbeat)
			end
			if t - lastCounters >= 60 then
				lastCounters = t
				pcall(flushCounters)
			end
			pcall(flush)
			-- wait the flush interval, or less when the queue fills up
			local waited = 0
			while waited < Config.FlushSeconds and #queue < Config.FlushAtEvents do
				waited += task.wait(0.5)
			end
		end
	end)

	game:BindToClose(function()
		closing = true
		for _, p in ipairs(Players:GetPlayers()) do
			onLeave(p, "server_shutdown")
		end
		pcall(flushCounters)
		push({ type = "server_stop", d = { reason = "shutdown" } })
		local deadline = os.clock() + Config.ShutdownFlushSeconds
		while (#queue > 0 or pendingBatch) and os.clock() < deadline and not disabled do
			pcall(flush, true)
			task.wait(pendingBatch and 1 or 0.1)
		end
	end)
	log("started", ENV, SERVER_ID, SERVER_KIND)
	return M
end

M.environment = ENV
M.serverId = SERVER_ID
return M
