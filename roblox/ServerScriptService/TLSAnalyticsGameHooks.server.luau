--[[
	TLSAnalyticsGameHooks (Script, ServerScriptService) — The Last Shift's gameplay instrumentation.

	Observe-only, like Telemetry.server.luau: it reads state the game already publishes (GameState
	attributes, LastStop.OutpostRun, player attributes) and changes nothing. Every handler is wrapped in
	pcall. Event names and fields are documented in docs/INSTRUMENTATION.md.

	Chapter 1 (station shifts)   GameState.Phase "Shift" → run_start; "Ended" → run_complete / run_fail
	                             (LastOutcome, FailureCause). Stage = "night_<GameState.Chapter>".
	Chapter 2 (Outpost, Route 9) OutpostRun.Phase "Night" → run_start; "Results" → run_complete.
	Both                         a player leaving mid-run → run_abandon (reason "left")
	Funnel                       lobby_joined → gate_entered → run_start → first_customer → final_hour → run_complete
	Other                        horror_event (GameState.ActiveEvent / IntroScare), downed (player attribute
	                             Downed; cause = the event active at that moment), objective_complete, retry,
	                             device counters (what the client reports through the existing Telemetry remote)
]]
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")

local A = require(ServerScriptService:WaitForChild("TLSAnalytics"))
local Root = ReplicatedStorage:WaitForChild("LastStop")
local State = Root:WaitForChild("GameState")

local function safe(fn)
	return function(...)
		local ok, err = pcall(fn, ...)
		if not ok then
			warn("[TLSAnalyticsGameHooks] " .. tostring(err))
		end
	end
end

local function training()
	local t = State:GetAttribute("Training")
	return t ~= nil and t ~= false and t ~= ""
end
local function mode()
	return State:GetAttribute("ServerMode") or "Lobby"
end

-- current run per chapter, shared by everyone on this server
local ch1 = nil -- { runId, stage, chapter }
local ch2 = nil
local inRun = {} -- [player] = run table they are part of
local firstCustomer = {} -- [player] = runId already reported

local function newRunId()
	return string.lower(string.sub(HttpService:GenerateGUID(false), 1, 18))
end

local function startFor(player, run)
	if inRun[player] == run then
		return
	end
	inRun[player] = run
	A.track(player, "run_start", { runId = run.runId, chapter = run.chapter, stage = run.stage, props = { crew = #Players:GetPlayers(), difficulty = tostring(State:GetAttribute("Difficulty") or "") } })
	A.setStage(player, (run.chapter == "ch2" and "ch2_" or "") .. run.stage)
end

local function endFor(player, run, name, props)
	if inRun[player] ~= run then
		return
	end
	inRun[player] = nil
	A.track(player, name, { runId = run.runId, chapter = run.chapter, stage = run.stage, props = props })
end

local function endAll(run, name, props)
	for _, p in ipairs(Players:GetPlayers()) do
		endFor(p, run, name, props)
	end
end

----------------------------------------------------------------------------
-- lobby: joined, gate entered (Pod attribute), stage
----------------------------------------------------------------------------
local function watchPlayer(p)
	if mode() == "Lobby" and State:GetAttribute("Phase") == "Lobby" then
		A.track(p, "lobby_joined")
		A.setStage(p, "lobby")
	end
	p:GetAttributeChangedSignal("Pod"):Connect(safe(function()
		if p:GetAttribute("Pod") ~= nil and mode() == "Lobby" then
			A.track(p, "gate_entered", { props = { gate = tostring(p:GetAttribute("Pod")) } })
			A.setStage(p, "gate")
		end
	end))
	p:GetAttributeChangedSignal("Downed"):Connect(safe(function()
		if p:GetAttribute("Downed") == true then
			local run = inRun[p]
			local ev = State:GetAttribute("ActiveEvent")
			A.track(p, "downed", {
				runId = run and run.runId,
				chapter = run and run.chapter,
				stage = run and run.stage,
				props = { cause = (type(ev) == "string" and ev ~= "") and ev or "unknown" },
			})
		end
	end))
	-- a player who joins a server mid-run takes part in it
	if ch1 and State:GetAttribute("Phase") == "Shift" then
		startFor(p, ch1)
	elseif ch2 then
		startFor(p, ch2)
	end
end
Players.PlayerAdded:Connect(safe(watchPlayer))
for _, p in ipairs(Players:GetPlayers()) do
	task.spawn(safe(watchPlayer), p)
end
Players.PlayerRemoving:Connect(safe(function(p)
	local run = inRun[p]
	if run then
		endFor(p, run, "run_abandon", { reason = "left" })
	end
	inRun[p] = nil
	firstCustomer[p] = nil
end))

----------------------------------------------------------------------------
-- Chapter 1: shift phases
----------------------------------------------------------------------------
local lastFailCause = ""
State:GetAttributeChangedSignal("FailureCause"):Connect(safe(function()
	local c = tostring(State:GetAttribute("FailureCause") or "")
	if c ~= "" then
		lastFailCause = c
	end
end))

State:GetAttributeChangedSignal("Phase"):Connect(safe(function()
	local ph = State:GetAttribute("Phase")
	if ph == "Shift" then
		local night = tonumber(State:GetAttribute("Chapter")) or 0
		ch1 = { runId = newRunId(), chapter = training() and "training" or "ch1", stage = "night_" .. tostring(night) }
		lastFailCause = ""
		for _, p in ipairs(Players:GetPlayers()) do
			startFor(p, ch1)
		end
	elseif ph == "Ended" and ch1 then
		local run = ch1
		local outcome = State:GetAttribute("LastOutcome")
		if outcome == "Survived" then
			endAll(run, "run_complete")
		else
			local cause = lastFailCause ~= "" and string.sub(lastFailCause, 1, 60) or tostring(outcome or "unknown")
			local mistakes = tonumber(State:GetAttribute("Mistakes")) or 0
			endAll(run, "run_fail", { reason = cause, mistakes = mistakes })
		end
		for _, p in ipairs(Players:GetPlayers()) do
			A.setStage(p, "results")
		end
		ch1 = nil
	elseif ph == "Lobby" then
		for _, p in ipairs(Players:GetPlayers()) do
			A.setStage(p, "lobby")
		end
	end
end))

State:GetAttributeChangedSignal("FinalHourStage"):Connect(safe(function()
	if State:GetAttribute("FinalHourStage") == 1 and ch1 then
		for _, p in ipairs(Players:GetPlayers()) do
			if inRun[p] == ch1 then
				A.track(p, "final_hour", { runId = ch1.runId, chapter = ch1.chapter, stage = ch1.stage })
			end
		end
	end
end))

local function horror(kind)
	local run = ch1 or ch2
	if not run then
		return
	end
	for _, p in ipairs(Players:GetPlayers()) do
		if inRun[p] == run then
			A.track(p, "horror_event", { runId = run.runId, chapter = run.chapter, stage = run.stage, props = { kind = kind } })
		end
	end
end
State:GetAttributeChangedSignal("ActiveEvent"):Connect(safe(function()
	local ev = State:GetAttribute("ActiveEvent")
	if type(ev) == "string" and ev ~= "" then
		horror(ev)
	end
end))
State:GetAttributeChangedSignal("IntroScare"):Connect(safe(function()
	if State:GetAttribute("IntroScare") then
		horror("IntroScare")
	end
end))

-- shared story objectives: report each one the crew finishes
local objId = ""
State:GetAttributeChangedSignal("StoryObjectiveId"):Connect(safe(function()
	local nid = tostring(State:GetAttribute("StoryObjectiveId") or "")
	if objId ~= "" and nid ~= objId and ch1 then
		for _, p in ipairs(Players:GetPlayers()) do
			if inRun[p] == ch1 then
				A.track(p, "objective_complete", { runId = ch1.runId, chapter = ch1.chapter, stage = ch1.stage, props = { objective = string.sub(objId, 1, 60) } })
			end
		end
	end
	objId = nid
end))

-- first customer served (NightService.onResolve, chained the same way Telemetry and ShiftOrders do)
task.spawn(safe(function()
	local NightService = require(ServerScriptService:WaitForChild("LastStop"):WaitForChild("Modules"):WaitForChild("NightService"))
	local orig = NightService.onResolve
	NightService.onResolve = function(s, c, action, player, ok, ...)
		pcall(function()
			if ok and ch1 and typeof(player) == "Instance" and player:IsA("Player") and firstCustomer[player] ~= ch1.runId then
				firstCustomer[player] = ch1.runId
				A.track(player, "first_customer", { runId = ch1.runId, chapter = ch1.chapter, stage = ch1.stage })
			end
		end)
		if orig then
			return orig(s, c, action, player, ok, ...)
		end
		return nil
	end
end))

-- retry / play again on the results screen (the same remote Telemetry listens to)
task.spawn(safe(function()
	local action = Root:WaitForChild("Remotes"):WaitForChild("Action", 30)
	if not action then
		return
	end
	local last = {}
	action.OnServerEvent:Connect(safe(function(player, kind)
		if (kind == "PlayAgain" or kind == "Retry") and State:GetAttribute("Phase") == "Ended" then
			if not last[player] or os.clock() - last[player] > 10 then
				last[player] = os.clock()
				A.track(player, "retry", { props = { kind = kind } })
			end
		end
	end))
	Players.PlayerRemoving:Connect(function(p)
		last[p] = nil
	end)
end))

-- device (client-reported through the existing Telemetry remote; counted once per player per server)
task.spawn(safe(function()
	local remote = Root:WaitForChild("Remotes"):WaitForChild("Telemetry", 30)
	if not remote then
		return
	end
	local DEVICES = { ["Device:Touch"] = "device_touch", ["Device:Mouse"] = "device_desktop", ["Device:Gamepad"] = "device_console" }
	local counted = {}
	remote.OnServerEvent:Connect(safe(function(player, kind)
		local name = type(kind) == "string" and DEVICES[kind]
		if name and not counted[player] then
			counted[player] = true
			A.count(name)
		end
	end))
	Players.PlayerRemoving:Connect(function(p)
		counted[p] = nil
	end)
end))

----------------------------------------------------------------------------
-- Chapter 2: the Outpost (Route 9) run
----------------------------------------------------------------------------
task.spawn(safe(function()
	local Pub = Root:WaitForChild("OutpostRun", 60)
	if not Pub then
		return
	end
	local lastPhase = Pub:GetAttribute("Phase")
	Pub:GetAttributeChangedSignal("Phase"):Connect(safe(function()
		local ph = Pub:GetAttribute("Phase")
		if ph == lastPhase then
			return
		end
		lastPhase = ph
		local night = tonumber(Pub:GetAttribute("Night")) or 0
		if ph == "Night" then
			ch2 = { runId = tostring(Pub:GetAttribute("RunId") or newRunId()) .. "-n" .. night, chapter = "ch2", stage = "night_" .. night }
			for _, p in ipairs(Players:GetPlayers()) do
				startFor(p, ch2)
			end
		elseif ph == "Results" and ch2 then
			endAll(ch2, "run_complete", { completed = tonumber(Pub:GetAttribute("Completed")) or night })
			for _, p in ipairs(Players:GetPlayers()) do
				A.setStage(p, "ch2_results")
			end
			ch2 = nil
		elseif ph == "Prep" or ph == "Dusk" then
			for _, p in ipairs(Players:GetPlayers()) do
				A.setStage(p, "ch2_" .. string.lower(tostring(ph)))
			end
		end
	end))
	Pub:GetAttributeChangedSignal("Active"):Connect(safe(function()
		if Pub:GetAttribute("Active") == false and ch2 then
			-- the run closed without reaching Results (crew wiped / left)
			endAll(ch2, "run_fail", { reason = "run_closed" })
			ch2 = nil
		end
	end))
end))
