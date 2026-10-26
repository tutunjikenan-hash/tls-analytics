--!nocheck
local A = MODULE()
local function at(t, fn) task.delay(t, fn) end

task.spawn(function()
	RESPONSES = { 503, 401 } -- 503, then a proxy-style 401 (no dashboard error code): both retried, same request id
	local p1 = MakePlayer(1001, {})
	table.insert(PlayersList, p1)
	-- a receipt granted before the boot script started the client is kept, not lost
	local early = A.wrapProcessReceipt(function(r) return Enum.ProductPurchaseDecision.PurchaseGranted end)
	print("RESULT|early|" .. tostring(early({ PlayerId = 1001, PurchaseId = "PURCHASE-EARLY", ProductId = 3500002, CurrencySpent = 10 })))
	A.start()
	local p2 = MakePlayer(1002, { SourcePlaceId = 134111235673543, ReferredByPlayerId = 77 })
	at(3, function() table.insert(PlayersList, p2); game:GetService("Players").PlayerAdded:Fire(p2) end)

	-- developer products through the wrapped handler
	local granted = A.wrapProcessReceipt(function(r) return Enum.ProductPurchaseDecision.PurchaseGranted end)
	local notyet = A.wrapProcessReceipt(function(r) return Enum.ProductPurchaseDecision.NotProcessedYet end)
	local broken = A.wrapProcessReceipt(function(r) error("save failed") end)
	at(20, function()
		print("RESULT|granted|" .. tostring(granted({ PlayerId = 1001, PurchaseId = "PURCHASE-ABC", ProductId = 3500001, CurrencySpent = 25 })))
		print("RESULT|again|" .. tostring(granted({ PlayerId = 1001, PurchaseId = "PURCHASE-ABC", ProductId = 3500001, CurrencySpent = 25 })))
		print("RESULT|notyet|" .. tostring(notyet({ PlayerId = 1001, PurchaseId = "PURCHASE-DEF", ProductId = 3500001, CurrencySpent = 25 })))
		local ok, err = pcall(broken, { PlayerId = 1001, PurchaseId = "PURCHASE-XYZ", ProductId = 3500001, CurrencySpent = 25 })
		print("RESULT|broken|" .. tostring(ok) .. "|" .. tostring(err))
	end)
	-- a game pass whose ownership only shows up on the second check
	OWNS["1002:777"] = { false, true, last = true }
	at(30, function() game:GetService("MarketplaceService").PromptGamePassPurchaseFinished:Fire(p2, 777, true) end)
	at(31, function() game:GetService("MarketplaceService").PromptProductPurchaseFinished:Fire(1001, 3500001, false) end)
	at(40, function()
		A.setStage(p1, "night_2")
		A.track(p1, "run_start", { runId = "run-1", chapter = "ch1", stage = "night_2", props = { crew = 2 } })
		A.track(p1, "Bad Name", {})
		A.track(nil, "server_note", { value = 1.5 })
		A.track(p1, "messy_props", { value = 0 / 0, stage = string.rep("é", 40), props = { bad = 0 / 0, inf = math.huge, txt = string.rep("é", 150), raw = "\255abc", ok = 3 } })
	end)
	at(70, function()
		for i, p in ipairs(PlayersList) do if p == p1 then table.remove(PlayersList, i) end end
		p1.Parent = nil
		game:GetService("Players").PlayerRemoving:Fire(p1)
	end)
	at(130, function()
		print("CLOSE|start")
		CLOSE()
		print("CLOSE|done")
	end)
end)
RUN_UNTIL(200)
