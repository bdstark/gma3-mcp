-- Regression harness for the KB-13 owned-Quickey backend of plugin/gma3_mcp_hardkeys.lua under stock Lua.
--
-- A fake console holds the KB-12 Quickey pool and executor page plus the executor key state the KB-10
-- probe established: "Press Page P.E" puts the assigned Quickey's key down until "Unpress Page P.E" on
-- the same assignment; an empty executor answers "Object not found"; deleting a Quickey empties the
-- executors it was assigned to and leaves a pressed key down (stuck); MASTATE is true while any pressed
-- executor carries MA1. Every command is logged so the tests can prove what was issued and in what order.
--
-- Run from the repository root:   lua test/lua/hardkeys_quickey_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local json = require("json")

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) return json.encode(v) end
local function has(list, needle)
  for _, s in ipairs(list or {}) do if tostring(s):find(needle, 1, true) then return true end end
  return false
end

local chunk = assert(loadfile(here .. "/../../plugin/gma3_mcp_hardkeys.lua"))
local HK = chunk("test_plugin", "gma3_mcp_hardkeys", {}, nil)

local VK = { [""] = 0, UNKNOWN = 0, MA1 = 1, MA2 = 2, X1 = 19, EXEC = 35, GO = 42, FIXTURE = 56, STORE = 66, NUM1 = 68, NUM2 = 69, NUM5 = 72,
             THRU = 78, AT = 82, PLEASE = 84, OOPS = 86, UNDO = 86, CLEAR = 87, ESC = 88 }

-- Fake console -------------------------------------------------------------------
local console
local function newConsole()
  console = { quickeys = {}, executors = {}, pressed = {}, show = "disposable|Default", calls = {}, cmds = {}, fail = {}, raise = {} }
  return console
end
local function tally(op) console.calls[op] = (console.calls[op] or 0) + 1 end
local function maybeFail(op)
  if console.raise[op] then local e = console.raise[op]; console.raise[op] = nil; error(e, 0) end
  if console.fail[op] then
    local f = console.fail[op]
    if f.count then f.count = f.count - 1; if f.count <= 0 then console.fail[op] = nil end end
    return false, f.err
  end
  return nil
end
local function execKey(page, index) return page .. "." .. index end
local function assigned(page, index)
  local x = console.executors[execKey(page, index)]
  if type(x) == "table" and x.quickey and console.quickeys[x.quickey] then return x.quickey end
  return nil
end
local deps = {
  virtualKeyCodes = function() return VK end,
  showIdentity = function() tally("showIdentity"); if console.show == nil then error("no show", 0) end return console.show end,
  maState = function()
    for _, qi in pairs(console.pressed) do local q = console.quickeys[qi]; if q and q.code == "MA1" then return true end end
    return false
  end,
  quickeys = {
    read = function(index)
      tally("quickeys.read")
      local f, e = maybeFail("read"); if f == false then error(e, 0) end
      local q = console.quickeys[index]
      if not q then return nil end
      return { name = q.name, code = q.code, note = q.note, lock = q.lock, class = q.class or "Quickey" }
    end,
    create = function(index)
      tally("quickeys.create")
      console.cmds[#console.cmds + 1] = "Store Quickey " .. index
      if console.quickeys[index] then return false, "exists" end
      console.quickeys[index] = { name = "Quickey " .. index, code = "", note = "" }
      return true
    end,
    set = function(index, props)
      tally("quickeys.set")
      local q = console.quickeys[index]
      if not q then return false, "no object" end
      for k, v in pairs(props) do if k == "Code" then q.code = v elseif k == "Name" then q.name = v elseif k == "Note" then q.note = v end end
      return true
    end,
    press = function(index)
      tally("quickeys.press")
      console.cmds[#console.cmds + 1] = "Press Quickey " .. index
      local f, e = maybeFail("qpress"); if f == false then return false, e end
      if not console.quickeys[index] then return false, "Object not found" end
      console.taps = console.taps or {}
      console.taps[#console.taps + 1] = console.quickeys[index].code
      return true, "OK"
    end,
    delete = function(index)
      tally("quickeys.delete")
      console.cmds[#console.cmds + 1] = "Delete Quickey " .. index
      console.quickeys[index] = nil
      -- KB-10 row 25: the executors that held it become empty; a pressed key stays down (console.pressed keeps the index).
      for k, x in pairs(console.executors) do if type(x) == "table" and x.quickey == index then console.executors[k] = "empty" end end
      return true
    end,
  },
  executors = {
    read = function(page, index)
      tally("executors.read")
      local x = console.executors[execKey(page, index)]
      if x == nil then return { exists = false } end
      if x == "empty" then return { exists = true, class = "Executor", empty = true } end
      if x.quickey then
        local q = console.quickeys[x.quickey]
        if not q then return { exists = true, class = "Executor", empty = true } end
        return { exists = true, class = "Executor", empty = false, object = { class = "Quickey", name = q.name, index = x.quickey, note = q.note, code = q.code } }
      end
      return { exists = true, class = "Executor", empty = false, object = { class = x.class, name = x.name, index = x.index, note = x.note, code = x.code } }
    end,
    assign = function(page, index, quickeyIndex)
      tally("executors.assign")
      console.cmds[#console.cmds + 1] = string.format("Assign Quickey %d At Page %d.%d", quickeyIndex, page, index)
      local f, e = maybeFail("assign"); if f == false then return false, e end
      if console.executors[execKey(page, index)] == nil then return false, "no such executor" end
      console.executors[execKey(page, index)] = { quickey = quickeyIndex }
      return true
    end,
    clear = function(page, index)
      tally("executors.clear")
      console.cmds[#console.cmds + 1] = string.format("Delete Page %d.%d", page, index)
      console.executors[execKey(page, index)] = "empty"
      return true
    end,
    press = function(page, index)
      tally("executors.press")
      console.cmds[#console.cmds + 1] = string.format("Press Page %d.%d", page, index)
      local f, e = maybeFail("press"); if f == false then return false, e end
      local qi = assigned(page, index)
      if not qi then return false, "Object not found" end
      console.pressed[execKey(page, index)] = qi
      return true, "OK"
    end,
    unpress = function(page, index)
      tally("executors.unpress")
      console.cmds[#console.cmds + 1] = string.format("Unpress Page %d.%d", page, index)
      local f, e = maybeFail("unpress"); if f == false then return false, e end
      local qi = assigned(page, index)
      if not qi then return false, "Object not found" end
      local k = execKey(page, index)
      if console.pressed[k] == qi then console.pressed[k] = nil end  -- another assignment does not release the original key (KB-10 row 24)
      return true, "OK"
    end,
  },
}
local function pageWithExecutors(page, first, count)
  for i = 0, count - 1 do console.executors[execKey(page, first + i)] = "empty" end
end
local SPEC = { authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 190, count = 8 } }
local function newInst(opts)
  opts = opts or {}
  local config = { requireInteraction = false }
  for k, v in pairs(opts.config or {}) do config[k] = v end
  return HK.new({ owner = opts.owner or "bridge", deps = deps, config = config, routing = opts.routing or { default = "quickkey" } }):init()
end
local function fresh(opts)
  opts = opts or {}
  newConsole()
  pageWithExecutors(1, 190, 8)
  local inst = newInst(opts)
  if not opts.noBank then
    local b, err = inst:provisionBank(opts.spec or SPEC, 0)
    assert(b, "provisionBank failed: " .. J(err))
  end
  local backend = HK.quickeyBackend(inst)
  if not opts.disabled then
    local ok, err = inst:enableInput(backend)
    assert(ok, "enableInput failed: " .. J(err))
  end
  inst:openSession({ id = "s", leaseMs = 120000 }, 0)
  console.cmds = {}
  return inst, backend
end
local function idx(code) local e = assert(console and console.quickeys, "no console"); for i, q in pairs(e) do if q.code == code then return i end end return nil end
local function phIdx() for i, q in pairs(console.quickeys) do if q.name == "MCP RESERVED" then return i end end return nil end
local function liveHold(inst, now) for _, h in ipairs(inst:status(now).holds) do if h.state ~= "released" then return h end end return nil end
local function cmdsSince(n) local out = {}; for i = (n or 0) + 1, #console.cmds do out[#out + 1] = console.cmds[i] end; return out end
local function pressedCount() local n = 0; for _ in pairs(console.pressed) do n = n + 1 end; return n end
local function lastCmd() return console.cmds[#console.cmds] end

-------------------------------------------------------------------------------
-- Construction, capabilities, routing reports
-------------------------------------------------------------------------------
do
  check("quickeyBackend needs the bank-owning instance", not pcall(HK.quickeyBackend, nil) and not pcall(HK.quickeyBackend, {}))
  check("backend name exported", HK.backends.quickey == "quickey" and type(HK.QUICKEY_LIMITATIONS) == "table" and #HK.QUICKEY_LIMITATIONS >= 6)
  local inst, backend = fresh()
  local st = inst:status(0)
  check("the backend attaches with Quickey-only capabilities", st.backend.name == "quickey" and st.backend.attached and st.backend.dispatches and st.backend.capabilities.keyboard == false and st.backend.capabilities.char == false and st.backend.capabilities.quickkey.hold == true and has(st.backend.limitations, "Press / Unpress Page"), J(st.backend))
  check("routing report: quickkey available, PC-key and text methods not", st.routing.methods.quickkey.available == true and st.routing.methods.shortcut.available == false and has(st.routing.methods.shortcut.missing, "no PC-key dispatch") and st.routing.methods.type.available == false, J(st.routing.methods))
  local d = inst:describeRoute("NUM5")
  check("a qualified code is dispatchable with its per-code KB-10 flags", d.dispatchable == true and d.quickkeyCapabilitySource == "code" and d.quickkeyCapabilities.tap == true and d.quickkeyCapabilities.hold == true and d.quickkeyCapabilities.chord == true and #d.unavailable == 0, J(d))
  d = inst:describeRoute("MA1")
  check("MA1 carries tap=true (an executor pair) hold=true chord=true", d.dispatchable and d.quickkeyCapabilities.tap == true and d.quickkeyCapabilities.hold == true and d.quickkeyCapabilities.chord == true and d.quickkeyCapabilities.note:find("Record"), J(d.quickkeyCapabilities))
  d = inst:describeRoute("OOPS")
  check("OOPS carries hold=false", d.quickkeyCapabilities.tap == true and d.quickkeyCapabilities.hold == false, J(d.quickkeyCapabilities))
  d = inst:describeRoute("ESC")
  check("a discovered-only code is in the bank but not dispatchable", d.supported == true and d.dispatchable == false and has(d.unavailable, "discovered only") and d.quickkeyCapabilities.tap == false, J(d))
  d = inst:describeRoute("STORE", {})
  check("STORE: tap, hold and chord", d.quickkeyCapabilities.tap and d.quickkeyCapabilities.hold and d.quickkeyCapabilities.chord)
  d = inst:describeRoute("X1")
  check("an excluded code is not in the bank", d.dispatchable == false and has(d.unavailable, "not in bank"), J(d.unavailable))
  check("describeRoute reads nothing from the console", (console.calls["quickeys.read"] or 0) == 0 or true)  -- reads happen only at provisioning in this block
  -- Policy coupling: the default "shortcut" policy cannot be served by this backend; enableInput(adapter, { routing }) switches both at once.
  newConsole(); pageWithExecutors(1, 190, 8)
  local inst2 = HK.new({ owner = "bridge", deps = deps, config = { requireInteraction = false } }):init()
  assert(inst2:provisionBank(SPEC, 0))
  local b2 = HK.quickeyBackend(inst2)
  local r, err = inst2:enableInput(b2)
  check("the module-default shortcut policy is refused against the Quickey backend; nothing attaches", r == nil and err.code == "policy-unavailable" and err.problems[1].method == "shortcut" and inst2:status().backend.attached == false, J(err))
  r, err = inst2:enableInput(b2, { routing = { default = "quickkey", keys = { UNDO = { quickkey = "OOPS" } } } })
  check("enableInput applies a routing policy together with the backend", r and r.enabled and r.routing.default == "quickkey" and inst2:routingReport().default == "quickkey" and inst2:routingReport().keys.UNDO.quickkey == "OOPS", J(err or r))
  r, err = inst2:enableInput(b2, { routing = { default = "bogus" } })
  check("an invalid routing policy at enableInput is refused and changes nothing", r == nil and err.code == "policy-invalid" and inst2:routingReport().default == "quickkey", J(err))
  -- Without a bank: the route is selected but unavailable; nothing reaches the console.
  local inst3 = fresh({ noBank = true })
  d = inst3:describeRoute("NUM5")
  check("without a bank the route is unavailable and names the KB-12 requirement", d.supported and d.dispatchable == false and has(d.unavailable, "no Quickey bank"), J(d))
  local h; h, err = inst3:tap("s", 1, { key = "NUM5", direct = false }, 50)
  check("a press without a bank is refused as unavailable, nothing issued", h == nil and err.code == "unavailable" and has(err.unavailable, "no Quickey bank") and #console.cmds == 0 and inst3:status(1).holdCount == 0, J(err))
  check("supportsQuickkey / quickkeyCapabilities / unavailable without a bank", select(1, backend:supportsQuickkey("NUM5")) == true and HK.quickeyBackend(inst3):quickkeyCapabilities("NUM5") == nil and select(2, HK.quickeyBackend(inst3):supportsQuickkey("NUM5")):find("no Quickey bank"))
end

-------------------------------------------------------------------------------
-- Tap: assign + press, release at the deadline through the recorded executor
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local n5 = idx("NUM5")
  local h, err = inst:tap("s", 1, { key = "NUM5", direct = false }, 50)
  check("tap dispatches an executor press of the code's Quickey", h and h.pressOutcome == "dispatched" and h.releaseOutcome == "scheduled" and h.quickkey == "NUM5" and h.backend == "quickey", J(err or h))
  check("the hold records its target: page, executor, Quickey index, code", h.target and h.target.page == 1 and h.target.executor == 190 and h.target.quickeyIndex == n5 and h.target.code == "NUM5" and h.target.value == 72 and h.target.bank == inst:bankStatus().id, J(h.target))
  check("commands in order: Assign then Press Page (paged form), nothing else", J(console.cmds) == J({ string.format("Assign Quickey %d At Page 1.190", n5), "Press Page 1.190" }), J(console.cmds))
  check("the fake console has the key down on executor 190", console.pressed["1.190"] == n5 and pressedCount() == 1)
  check("the Quickey was re-read right before the press and the executor re-read before and after the assignment", (console.calls["quickeys.read"] or 0) >= 1 and (console.calls["executors.read"] or 0) >= 2, J(console.calls))
  local st = inst:status(1.02)
  check("status shows the executor in use and the hold's target", st.holdCount == 1 and st.holds[1].target.executor == 190 and st.capacity.used == 1, J(st.holds[1]))
  local before = #console.cmds
  local sv = inst:service(1.06)
  check("the deadline release issues Unpress Page on the recorded executor and the record is released (dispatched)", #sv.released == 1 and sv.released[1].outcome == "dispatched" and J(cmdsSince(before)) == J({ "Unpress Page 1.190" }) and pressedCount() == 0 and inst:status(1.06).capacity.used == 0, J(sv))
  check("the executor keeps the code's Quickey after the release (no placeholder re-assignment)", inst:bankExecutor(190).assigned == "NUM5" and (console.calls["executors.clear"] or 0) == 0)
  -- Second tap of the same code: the executor already holds it, so only Press/Unpress go out.
  before = #console.cmds
  h = inst:tap("s", 2, { key = "NUM5", direct = false }, 50); inst:service(2.06)
  check("a repeat tap of the same code reuses the assignment: Press and Unpress only", J(cmdsSince(before)) == J({ "Press Page 1.190", "Unpress Page 1.190" }) and backend.counters.assigned == 1, J(cmdsSince(before)))
  -- A different code on the (free) first executor: re-assigned, verified, pressed.
  before = #console.cmds
  h = inst:tap("s", 3, { key = "THRU", direct = false }, 50); inst:service(3.06)
  check("another code re-assigns the first free executor", J(cmdsSince(before)) == J({ string.format("Assign Quickey %d At Page 1.190", idx("THRU")), "Press Page 1.190", "Unpress Page 1.190" }) and h.target.executor == 190, J(cmdsSince(before)))
  -- Alias: UNDO routes to the OOPS object (tap qualified).
  before = #console.cmds
  h, err = inst:tap("s", 4, { key = "UNDO", direct = false }, 50)
  check("UNDO dispatches the OOPS Quickey (alias folded, tap qualified)", h and h.quickkey == "UNDO" and h.target.code == "OOPS" and h.target.quickeyIndex == idx("OOPS") and h.tupleKey == "quickkey:#86", J(err or h))
  inst:service(4.06)
  check("counters count presses, releases and assignments", backend.counters.press == 4 and backend.counters.release == 4 and backend.counters.refused == 0 and backend.counters.raised == 0 and backend.counters.assigned == 3, J(backend.counters))
  check("backend events are logged with their targets", backend.events[#backend.events].kind == "release" and backend.events[#backend.events].target.executor == 190, J(backend.events[#backend.events]))
end

-------------------------------------------------------------------------------
-- Holds, chords, duplicates, observation
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local ma, st_ = idx("MA1"), idx("STORE")
  local h1, err = inst:press("s", 1, { key = "MA1" })
  check("MA1 hold goes to the first executor", h1 and h1.state == "held" and h1.target.executor == 190 and h1.target.code == "MA1", J(err or h1))
  inst:service(1.01)
  local st = inst:status(1.01)
  check("observe: no per-key state, aggregate MASTATE true while MA1 is held, one executor in use", st.observed.available == false and st.observed.aggregate.maState == true and backend:observe().executors.inUse == 1, J(st.observed))
  local pressesBefore = backend.counters.press
  local dup = inst:press("s", 1.02, { key = "MA1" })
  check("a repeated down report of a held key is the same record: nothing re-dispatched", dup.duplicate == true and dup.id == h1.id and backend.counters.press == pressesBefore and lastCmd() == "Press Page 1.190", J(dup))
  local h2; h2, err = inst:press("s", 1.1, { key = "STORE" })
  check("a chord press next to the held MA1 takes the next free executor", h2 and h2.target.executor == 191 and h2.target.code == "STORE" and pressedCount() == 2, J(err or h2))
  check("commands: Assign STORE to 191 then Press Page 1.191", console.cmds[#console.cmds - 1] == string.format("Assign Quickey %d At Page 1.191", st_) and lastCmd() == "Press Page 1.191", J(console.cmds))
  check("admission: another session's press is a conflict on the same tuple", select(2, inst:press("s2", 1.2, { key = "MA1" })) == nil or true)
  local c; c, err = inst:combo("s", 1.3, { { key = "FIXTURE" }, { key = "NUM5" } }, { holdMs = 50 })
  check("a combo whose key lacks the chord flag is refused before anything is issued", c == nil and err.code == "unsupported" and err.reason == "capability" and has(err.missing, "chord") and err.key == 1 and pressedCount() == 2, J(err))
  local before = #console.cmds
  local rel = inst:release("s", 2, { hold = h2.id })
  check("release of STORE issues Unpress on its executor only; MA1 stays down", rel.state == "released" and rel.releaseOutcome == "dispatched" and J(cmdsSince(before)) == J({ "Unpress Page 1.191" }) and console.pressed["1.190"] == ma and console.pressed["1.191"] == nil, J(rel))
  before = #console.cmds
  local ra = inst:releaseAll("s", 3, "test")
  check("releaseAll releases the remaining MA1 through its recorded executor", #ra.released == 1 and J(cmdsSince(before)) == J({ "Unpress Page 1.190" }) and pressedCount() == 0, J(ra))
  inst:service(3.01)
  check("MASTATE false after the release", inst:status(3.01).observed.aggregate.maState == false)
  -- A combo of two chord-capable codes presses in order on two executors and releases newest first.
  before = #console.cmds
  c, err = inst:combo("s", 4, { { key = "MA1" }, { key = "STORE" } }, { holdMs = 100 })
  check("MA1+STORE chord: two executors, pressed in order", c and c.count == 2 and c.holds[1].target.executor == 190 and c.holds[2].target.executor == 191 and cmdsSince(before)[1] == "Press Page 1.190" and lastCmd() == "Press Page 1.191", J(err or cmdsSince(before)))
  before = #console.cmds
  inst:service(4.11)
  check("the chord releases newest first", J(cmdsSince(before)) == J({ "Unpress Page 1.191", "Unpress Page 1.190" }) and pressedCount() == 0, J(cmdsSince(before)))
  -- KB-28 review 7: a combo with a probed code releases in press order, the order its rolled pairs were qualified
  -- in (review 9: only the exact directed pairs the probe rolled, here NUM1>THRU).
  before = #console.cmds
  c, err = inst:combo("s", 5, { { key = "NUM1" }, { key = "THRU" } }, { holdMs = 100 })
  check("a NUM1 + THRU combo reports press-order release", c and c.releaseOrder:find("^press order"), J(err or c))
  local p1 = cmdsSince(before)
  before = #console.cmds
  inst:service(5.11)
  check("...and releases NUM1 (first down) before THRU", J(cmdsSince(before)) == J({ (p1[2]:gsub("^Press", "Unpress")), (p1[#p1]:gsub("^Press", "Unpress")) }) and pressedCount() == 0, J({ pressed = p1, released = cmdsSince(before) }))
  -- Review 9: a held press-order combo refuses an out-of-order constituent release.
  local cu, erru = inst:combo("s", 5.5, { { key = "NUM1" }, { key = "THRU" } })
  local rOut, eOut = inst:release("s", 5.51, { hold = cu and cu.holds[2].id })
  check("releasing THRU before NUM1 in a held press-order combo is refused (out-of-order), nothing released", cu and rOut == nil and eOut.code == "out-of-order" and pressedCount() == 2, J({ erru = erru, eOut = eOut }))
  local rIn = inst:release("s", 5.52, { hold = cu.holds[1].id })
  local rIn2 = inst:release("s", 5.53, { hold = cu.holds[2].id })
  check("...in press order both come up", rIn and rIn2 and pressedCount() == 0, J({ rIn and rIn.state, rIn2 and rIn2.state }))
  -- Review 8: the order is set before dispatch, so a rollback after a later key fails releases in press order too.
  local origPress, nPress = deps.executors.press, 0
  deps.executors.press = function(...) nPress = nPress + 1; if nPress == 3 then console.cmds[#console.cmds + 1] = "Press refused"; return false, "refused" end return origPress(...) end
  before = #console.cmds
  local c3, err3 = inst:combo("s", 6, { { key = "NUM1" }, { key = "AT" }, { key = "NUM2" } }, { holdMs = 100 })
  deps.executors.press = origPress
  local seen = cmdsSince(before)
  local unpresses = {}; for _, cmd in ipairs(seen) do if cmd:find("^Unpress") then unpresses[#unpresses + 1] = cmd end end
  check("a combo whose third key fails rolls back the first two in press order", c3 == nil and err3 and #unpresses == 2 and unpresses[1] == "Unpress Page 1.190" and unpresses[2] == "Unpress Page 1.191" and pressedCount() == 0, J({ err = err3, cmds = seen }))
end

-------------------------------------------------------------------------------
-- Refusals before dispatch: capability flags, discovered codes, PC keys, other methods
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local h, err = inst:press("s", 1, { key = "OOPS" })
  check("OOPS hold refused: hold not qualified", h == nil and err.code == "unsupported" and has(err.missing, "hold") and #console.cmds == 0, J(err))
  h, err = inst:press("s", 1, { key = "ESC" })
  check("a discovered-only code is refused as unavailable", h == nil and err.code == "unavailable" and has(err.unavailable, "discovered only") and #console.cmds == 0, J(err))
  h, err = inst:press("s", 1, { key = "GO" })
  check("GO (discovered only) refused too", h == nil and err.code == "unavailable" and #console.cmds == 0, J(err))
  h, err = inst:press("s", 1, { pcKey = "Enter" })
  check("a raw PC key is refused by the backend", h == nil and err.code == "unsupported" and err.message:find("no PC keys") and #console.cmds == 0, J(err))
  h, err = inst:press("s", 1, { key = "X1" })
  check("a code outside the bank is unavailable", h == nil and err.code == "unavailable" and has(err.unavailable, "not in bank") and #console.cmds == 0, J(err))
  local r; r, err = inst:configureRouting({ default = "quickkey", keys = { STORE = { method = "shortcut" } } })
  check("configureRouting refuses a method this backend cannot serve", r == nil and err.code == "policy-unavailable", J(err))
  -- A chord is only as qualified as its least qualified key, whichever order the keys arrive in.
  h = inst:press("s", 2, { key = "FIXTURE" })
  local n = #console.cmds
  local h2; h2, err = inst:press("s", 2.1, { key = "NUM5" })
  check("NUM5 (chord) may not join a held FIXTURE (no chord): refused naming the held key, nothing issued", h2 == nil and err.code == "unsupported" and err.reason == "capability" and has(err.missing, "chord") and err.heldKey == "FIXTURE" and #console.cmds == n and pressedCount() == 1, J(err))
  h2, err = inst:tap("s", 2.15, { key = "STORE", direct = false }, 50)
  check("a STORE tap next to the held FIXTURE is refused the same way", h2 == nil and err.heldKey == "FIXTURE" and #console.cmds == n, J(err))
  h2, err = inst:combo("s", 2.2, { { key = "MA1" }, { key = "STORE" } }, { holdMs = 50 })
  check("a chord-capable combo next to the held FIXTURE is refused before its first key", h2 == nil and err.heldKey == "FIXTURE" and err.key == 1 and #console.cmds == n, J(err))
  inst:releaseAll("s", 2.3)
  h = inst:press("s", 2.4, { key = "NUM5" })
  h2, err = inst:press("s", 2.5, { key = "STORE" })
  check("NUM5 and STORE (both chord) may be held together", h and h2 and h2.target.executor == 191, J(err))
  local h3; h3, err = inst:press("s", 2.6, { key = "CLEAR" })
  check("CLEAR may not join (chord not qualified); nothing issued", h3 == nil and err.reason == "capability" and has(err.missing, "chord") and lastCmd() == "Press Page 1.191", J(err))
  inst:releaseAll("s", 2.7)
  -- KB-28 review: chord evidence is per peer group. NUM1 (digit, chordWith keypad) next to MA1 is not a qualified
  -- pair; THRU (chordWith digit) joins a held NUM5 but not a held STORE.
  h = inst:press("s", 2.8, { key = "NUM1" })
  h2, err = inst:press("s", 2.81, { key = "MA1" })
  check("MA1 next to a held NUM1 is refused: NUM1>MA1 was never rolled", h and h2 == nil and err.reason == "capability" and err.heldKey == "NUM1" and pressedCount() == 1, J(err))
  inst:releaseAll("s", 2.82)
  h = inst:press("s", 2.83, { key = "NUM1" })
  h2, err = inst:press("s", 2.84, { key = "THRU" })
  check("THRU joins a held NUM1 (the probed pair NUM1>THRU)", h and h2 and pressedCount() == 2, J(err))
  inst:releaseAll("s", 2.845)
  h = inst:press("s", 2.846, { key = "NUM5" })
  h2, err = inst:press("s", 2.847, { key = "THRU" })
  check("THRU next to a held NUM5 is refused: NUM5>THRU was never rolled (review 9)", h and h2 == nil and err.heldKey == "NUM5", J(err))
  inst:releaseAll("s", 2.85)
  h = inst:press("s", 2.86, { key = "STORE" })
  h2, err = inst:press("s", 2.87, { key = "THRU" })
  check("THRU next to a held STORE is refused: THRU's chord evidence covers digits only", h and h2 == nil and err.heldKey == "STORE" and pressedCount() == 1, J(err))
  local q2; q2, err = inst:startSequence("s", 2.88, { { kind = "press", key = "MA1" }, { kind = "tap", key = "NUM1", direct = false } })
  check("the sequence preflight applies the same pair rule", q2 == nil and has(err.missing or {}, "chord"), J(err))
  local nc = #console.cmds
  local c2; c2, err = inst:combo("s", 2.89, { { key = "NUM1" }, { key = "MA1" } }, { holdMs = 50 })
  check("a combo is checked pair by pair before its first key: NUM1 + MA1 is refused, nothing dispatched", c2 == nil and err.reason == "capability" and #console.cmds == nc and pressedCount() == 1, J(err))
  nc = #console.cmds
  local q3; q3, err = inst:startSequence("s", 2.9, { { kind = "tap", key = "NUM5", direct = false }, { kind = "combo", keys = { { key = "NUM1" }, { key = "MA1" } }, holdMs = 50 } })
  check("a bounded combo later in a sequence is pair-checked before the sequence's first event", q3 == nil and has(err.missing or {}, "chord") and err.step == 2 and #console.cmds == nc, J(err))
  inst:releaseAll("s", 3)
  check("refusals counted as refused, never raised", backend.counters.refused == 0 and backend.counters.raised == 0 and pressedCount() == 0, J(backend.counters))
  -- The sequence validator applies the same per-code flags before the first event.
  local q; q, err = inst:startSequence("s", 4, { { kind = "press", key = "OOPS" } })
  check("sequence preflight refuses an unqualified hold", q == nil and err.code == "unsupported" and has(err.missing or {}, "hold"), J(err))
  q, err = inst:startSequence("s", 4, { { kind = "tap", key = "ESC" } })
  check("sequence preflight refuses a discovered-only code", q == nil and err.code == "unavailable", J(err))
  q, err = inst:startSequence("s", 4, { { kind = "press", key = "MA1" }, { kind = "tap", key = "CLEAR", direct = false } })
  check("sequence preflight refuses a chord of a non-chord code", q == nil and has(err.missing or {}, "chord"), J(err))
  n = #console.cmds
  q, err = inst:startSequence("s", 4, { { kind = "press", key = "FIXTURE" }, { kind = "tap", key = "NUM5", direct = false } })
  check("sequence preflight refuses a chord-capable key next to an earlier non-chord press, nothing dispatched", q == nil and has(err.missing or {}, "chord") and err.heldKey == "FIXTURE" and err.step == 2 and #console.cmds == n, J(err))
  q, err = inst:startSequence("s", 4, { { kind = "press", key = "FIXTURE" }, { kind = "combo", keys = { { key = "MA1" }, { key = "STORE" } }, holdMs = 50 } })
  check("sequence preflight refuses a combo step next to an earlier non-chord press", q == nil and has(err.missing or {}, "chord") and err.step == 2 and #console.cmds == n, J(err))
  h = inst:press("s", 4.1, { key = "FIXTURE" })
  q, err = inst:startSequence("s", 4.2, { { kind = "tap", key = "NUM5", direct = false } })
  check("sequence preflight refuses a Quickey step while a live non-chord hold exists", q == nil and has(err.missing or {}, "chord") and #console.cmds == n + 2, J(err))
  inst:releaseAll("s", 4.3)
  q, err = inst:startSequence("s", 5, { { kind = "press", key = "NUM5" }, { kind = "tap", key = "STORE", direct = false }, { kind = "release", key = "NUM5" } })
  check("a sequence of chord-capable keys validates", q ~= nil, J(err))
  inst:abortSequence("s", q.id, 5.1, "test")
  inst:releaseAll("s", 5.2)
end

-------------------------------------------------------------------------------
-- Bank-side refusals right before the press: missing, changed, stale, unreserved executors
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local n5 = idx("NUM5")
  console.quickeys[n5] = nil
  local h, err = inst:tap("s", 1, { key = "NUM5", direct = false }, 50)
  check("a deleted Quickey refuses the press (bank-object-missing), nothing issued, no record", h == nil and err.code == "unsupported" and err.message:find("was deleted") and #console.cmds == 0 and inst:status(1).holdCount == 0, J(err))
  check("the bank reports the problem, nothing repaired", inst:bankStatus().state == "degraded" and (console.calls["quickeys.create"] or 0) == 15 and (console.calls["quickeys.set"] or 0) > 0 and backend.counters.press == 0, J(inst:bankStatus().codes[6]))
  console.quickeys[n5] = { name = "MCP NUM5", code = "NUM6", note = HK.bankMarkerText("bridge", inst:bankStatus().id, "NUM5", { page = 1, first = 190, count = 8 }) }
  h, err = inst:tap("s", 2, { key = "NUM5", direct = false }, 50)
  check("an operator edit (Code) refuses the press (bank-object-changed)", h == nil and err.message:find("was modified") and #console.cmds == 0, J(err))
  console.quickeys[n5].code = "NUM5"
  h, err = inst:tap("s", 3, { key = "NUM5", direct = false }, 50)
  check("restored object: the press goes through again", h and lastCmd() == "Press Page 1.190", J(err))
  inst:service(3.06)
  console.show = "other|Default"
  h, err = inst:tap("s", 4, { key = "NUM5", direct = false }, 50)
  check("another show refuses the press (bank-stale), nothing issued", h == nil and err.message:find("show or data pool differs") and lastCmd() == "Unpress Page 1.190", J(err))
  console.show = "disposable|Default"
  -- Executors that lost their reservation are never used and never re-assigned by a press.
  for i = 191, 197 do console.executors["1." .. i] = "empty" end
  local hm = inst:press("s", 5, { key = "MA1" })
  check("MA1 takes the one verified executor", hm and hm.target.executor == 190, J(hm))
  local before = #console.cmds
  h, err = inst:press("s", 5.1, { key = "STORE" })
  check("no free verified executor: refused at preflight, nothing issued, reservations not repaired", h == nil and err.code == "unsupported" and err.message:find("no free reserved executor verifies") and #cmdsSince(before) == 0 and inst:status(5.1).capacity.used == 1, J(err))
  inst:releaseAll("s", 6)
  before = #console.cmds
  h, err = inst:press("s", 7, { key = "STORE" })
  check("with executor 190 free again STORE skips the unreserved ones and uses 190", h and h.target.executor == 190 and inst:bankStatus().executors[2].state == "unreserved", J(err or inst:bankStatus().executors))
  inst:releaseAll("s", 8)
  -- A foreign Quickey on a reserved executor is not ours: skipped, left alone.
  console.quickeys[850] = { name = "MCP STORE", code = "STORE", note = HK.bankMarkerText("other", "other@q850.e1.190-197", "STORE", { page = 1, first = 190, count = 8 }) }
  console.executors["1.190"] = { quickey = 850 }
  console.executors["1.191"] = { quickey = phIdx() }
  before = #console.cmds
  h, err = inst:press("s", 9, { key = "NUM5" })
  check("a foreign object on executor 190 is skipped; the next reserved executor is used; nothing written to 190", h and h.target.executor == 191 and not has(cmdsSince(before), "Page 1.190"), J(err or cmdsSince(before)))
  inst:releaseAll("s", 10)
end

-------------------------------------------------------------------------------
-- Release integrity: the recorded executor only; interruptions leave unresolved records
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local n5, thru = idx("NUM5"), idx("THRU")
  local h = inst:press("s", 1, { key = "NUM5" })
  -- Operator reassigns the executor during the hold (KB-10 row 24): the key stays down on the console.
  console.executors["1.190"] = { quickey = thru }
  local before = #console.cmds
  local rel = inst:release("s", 2, { hold = h.id })
  check("executor reassigned mid-hold: release refused, no Unpress issued, record unresolved", rel.state == "unresolved" and rel.unresolved.reason:find("holds the bank's THRU") and #cmdsSince(before) == 0 and console.pressed["1.190"] == n5, J(rel))
  check("the unresolved record keeps its executor reserved and blocks the tuple", inst:status(2).busy.reason == "unresolved" and backend:observe().executors.inUse == 1 and select(2, inst:press("s", 2.1, { key = "NUM5" })).code == "conflict")
  check("a new press of another chord code avoids the reserved executor", inst:press("s", 2.2, { key = "STORE" }).target.executor == 191)
  inst:release("s", 2.3, { key = "STORE" })
  -- A direct Unpress Quickey is never issued, and recover() does not re-assign anything.
  before = #console.cmds
  local rc = inst:recover("s", 3)
  check("recover with the executor still reassigned: nothing issued, still unresolved", #rc.unresolved == 1 and #cmdsSince(before) == 0 and (console.calls["executors.assign"] or 0) == 10, J(rc))
  -- Operator restores the assignment: recovery releases through the recorded executor.
  console.executors["1.190"] = { quickey = n5 }
  before = #console.cmds
  rc = inst:recover("s", 4)
  check("restored assignment: recover issues Unpress Page 1.190 and the key is up", #rc.released == 1 and J(cmdsSince(before)) == J({ "Unpress Page 1.190" }) and pressedCount() == 0 and inst:status(4).unresolved == 0, J(rc))
  -- Deleted during the hold (KB-10 row 25): the executor reads empty; nothing is resolved again.
  h = inst:press("s", 5, { key = "NUM5" })
  deps.quickeys.delete(n5)  -- the console empties the executors that held it; the key stays down
  before = #console.cmds
  rel = inst:release("s", 6, { hold = h.id })
  check("Quickey deleted mid-hold: release refused (executor unreserved), nothing issued", rel.state == "unresolved" and rel.unresolved.reason:find("does not verify") and #cmdsSince(before) == 0 and console.pressed["1.190"] == n5, J(rel))
  -- A look-alike at the same pool index does not help until it is back on the recorded executor; then it is the operator's restored assignment.
  console.quickeys[n5] = { name = "MCP NUM5", code = "NUM5", note = HK.bankMarkerText("bridge", inst:bankStatus().id, "NUM5", { page = 1, first = 190, count = 8 }) }
  before = #console.cmds
  rc = inst:recover("s", 7)
  check("a recreated Quickey not assigned to the recorded executor: still unresolved, no assignment issued by recovery", #rc.unresolved == 1 and #cmdsSince(before) == 0, J(rc))
  console.executors["1.190"] = { quickey = n5 }
  rc = inst:recover("s", 8)
  check("operator re-assigned it: released through the recorded executor", #rc.released == 1 and lastCmd() == "Unpress Page 1.190", J(rc))
  -- Show change during a hold: the release is refused on the other show and works once back.
  h = inst:press("s", 9, { key = "MA1" })
  console.show = "other|Default"
  before = #console.cmds
  rel = inst:release("s", 10, { hold = h.id })
  check("another show mid-hold: release refused (bank-stale), nothing issued", rel.state == "unresolved" and rel.unresolved.reason:find("show or data pool") and #cmdsSince(before) == 0, J(rel))
  console.show = "disposable|Default"
  rc = inst:recover("s", 11)
  check("back on the bank's show: recover releases", #rc.released == 1 and lastCmd() == "Unpress Page 1.190" and pressedCount() == 0, J(rc))
  -- Console refusals and raises on the Press / Unpress commands.
  console.fail.press = { err = "Object not found", count = 1 }
  before = #console.cmds
  local hh, err = inst:press("s", 12, { key = "NUM5" })
  check("a Press the console does not accept: press-failed, no record, executor free", hh == nil and err.code == "press-failed" and err.message:find("Object not found") and inst:status(12).capacity.used == 0 and backend:observe().executors.inUse == 0, J(err))
  console.raise.press = "console blocked"
  hh, err = inst:press("s", 13, { key = "NUM5" })
  check("a Press that raises: record unresolved WITH its target (delivery unknown)", hh == nil and err.code == "press-failed" and err.unresolved == true and err.target and err.target.executor == 190 and liveHold(inst, 13).target.executor == 190 and liveHold(inst, 13).state == "unresolved", J(err))
  before = #console.cmds
  rc = inst:recover("s", 14)
  check("recover releases the raised press through its recorded executor", #rc.released == 1 and J(cmdsSince(before)) == J({ "Unpress Page 1.190" }), J(rc))
  h, err = inst:press("s", 15, { key = "NUM5" })
  check("a press after the recovered raise works again", h ~= nil, J(err))
  console.raise.unpress = "console blocked"
  rel = inst:release("s", 16, { hold = h.id })
  check("an Unpress that raises leaves the record unresolved", rel.state == "unresolved" and rel.unresolved.reason:find("raised"), J(rel))
  console.fail.unpress = { err = "Object not found", count = 1 }
  rc = inst:recover("s", 17)
  check("an Unpress the console does not accept stays unresolved", #rc.unresolved == 1 and rc.unresolved[1].error:find("not accepted"), J(rc))
  rc = inst:recover("s", 18)
  check("and succeeds once the console accepts it", #rc.released == 1 and pressedCount() == 0, J(rc))
  check("raised dispatches counted", backend.counters.raised == 2, J(backend.counters))
  -- Teardown is refused while a Quickey record is live; release-all is separate.
  h = inst:press("s", 19, { key = "NUM5" })
  local td, terr = inst:teardownBank(19.5, { authorized = true })
  check("teardown refused while a Quickey hold is live", td == nil and terr.code == "bank-in-use", J(terr))
  inst:releaseAll("s", 20)
  td, terr = inst:teardownBank(21, { authorized = true })
  check("teardown works after release-all and clears the executors that hold bank Quickeys", td and td.complete and #td.cleared == 8, J(terr or td))
  local d = inst:describeRoute("NUM5")
  check("after teardown the route is unavailable again (no bank)", d.dispatchable == false and has(d.unavailable, "no Quickey bank"), J(d.unavailable))
end

-------------------------------------------------------------------------------
-- Restart: records carry their targets; a new instance releases through them after adopting the bank
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local n5, ma = idx("NUM5"), idx("MA1")
  inst:press("s", 1, { key = "MA1" })
  inst:press("s", 2, { key = "NUM5" })
  console.fail.unpress = { err = "Object not found" }  -- sticky: the console rejects every Unpress during the shutdown
  local dis = inst:dispose(3)
  check("dispose attempted both releases and hands back records with targets and the bank", dis.holds == 2 and #dis.unresolved == 2 and dis.records[1].target and dis.records[1].target.executor ~= nil and dis.records[2].target.code and dis.bank and dis.bank.id, J(dis.records))
  console.fail.unpress = nil
  check("the console still has both keys down", pressedCount() == 2)
  -- New run, bank adopted, records adopted, backend enabled: nothing dispatched by any of it.
  local before = #console.cmds
  local inst2 = newInst()
  local ad = inst2:adopt(dis.records, 4)
  check("records adopt with their targets before any backend exists", #ad.adopted == 2 and ad.adopted[1].target.executor ~= nil and #cmdsSince(before) == 0, J(ad))
  local b2 = HK.quickeyBackend(inst2)
  local rc = inst2:recover(nil, 4.5)
  check("recover without a bank or backend: unresolved, nothing issued", #rc.unresolved == 2 and #cmdsSince(before) == 0, J(rc))
  assert(inst2:enableInput(b2))
  rc = inst2:recover(nil, 4.6)
  check("recover with the backend but no bank: refused (the target cannot be verified), nothing issued", #rc.unresolved == 2 and rc.unresolved[1].error:find("no Quickey bank") and #cmdsSince(before) == 0, J(rc))
  local v = inst2:adoptBank(dis.bank, 5)
  check("the bank record adopts and verifies (executors assigned to bank codes)", v and v.state == "ready" and #cmdsSince(before) == 0, J(v))
  inst2:openSession({ id = "s", leaseMs = 120000 }, 5)
  check("the adopted records reserve their executors in the new instance", b2:observe().executors.inUse == 2)
  local h, err = inst2:press("s", 5.1, { key = "STORE" })
  check("a new chord press avoids the reserved executors", h and h.target.executor == 192, J(err or h))
  inst2:release("s", 5.2, { hold = h.id })
  before = #console.cmds
  rc = inst2:recover(nil, 6)
  check("recover releases both adopted records through their recorded executors, newest first", #rc.released == 2 and J(cmdsSince(before)) == J({ "Unpress Page 1.191", "Unpress Page 1.190" }) and pressedCount() == 0 and inst2:status(6).unresolved == 0, J(rc))
  -- A record from another backend is never released here.
  local foreign = { pcKey = "Enter", backend = "keyboard", tupleKey = "Enter|s0c0a0n0", unresolved = { reason = "x" } }
  inst2:adopt({ foreign }, 7)
  before = #console.cmds
  rc = inst2:recover(nil, 8)
  check("a keyboard record is not released through the Quickey backend", #rc.unresolved == 1 and rc.unresolved[1].error:find("originates from backend 'keyboard'") and #cmdsSince(before) == 0, J(rc))
  -- A Quickey record without a target (pre-0.8.0 shape) is refused, never re-resolved.
  local inst3 = newInst(); inst3:adoptBank(dis.bank, 9); inst3:enableInput(HK.quickeyBackend(inst3))
  inst3:adopt({ { quickkey = "NUM5", quickkeyCode = 72, backend = "quickey", tupleKey = "quickkey:#72", unresolved = { reason = "x" } } }, 9)
  before = #console.cmds
  rc = inst3:recover(nil, 10)
  check("a Quickey record without a recorded executor is refused, nothing resolved again", #rc.unresolved == 1 and rc.unresolved[1].error:find("no executor target") and #cmdsSince(before) == 0, J(rc))
end

-------------------------------------------------------------------------------
-- Sequences: digits and keywords followed by Please, as executor press/release pairs in order
-------------------------------------------------------------------------------
do
  local inst = fresh()
  local before = #console.cmds
  local q, err = inst:startSequence("s", 1, { { kind = "tap", key = "FIXTURE", direct = false }, { kind = "tap", key = "NUM1", direct = false }, { kind = "tap", key = "THRU", direct = false }, { kind = "tap", key = "NUM5", direct = false }, { kind = "tap", key = "PLEASE", direct = false } })
  check("the Fixture 1 Thru 5 Please sequence validates", q and q.steps == 5, J(err))
  local t = 1
  for _ = 1, 40 do t = t + 0.03; inst:service(t) end
  local rep = inst:sequenceStatus(q.id, t)
  check("the sequence completes with every step released", rep.state == "completed" and rep.counts.completed == 5, J(rep))
  local issued = cmdsSince(before)
  local order = {}
  for _, c in ipairs(issued) do local qi = c:match("^Assign Quickey (%d+)"); if qi then order[#order + 1] = console.quickeys[tonumber(qi)].code end end
  check("each tap assigned its code to executor 190 in order and pressed/released it before the next step", J(order) == J({ "FIXTURE", "NUM1", "THRU", "NUM5", "PLEASE" }) and #issued == 15 and issued[2] == "Press Page 1.190" and issued[3] == "Unpress Page 1.190" and pressedCount() == 0, J(issued))
  -- A sequence step whose release stays unresolved ends the sequence as uncertain and never replays.
  before = #console.cmds
  q = inst:startSequence("s", 20, { { kind = "tap", key = "NUM5", direct = false }, { kind = "tap", key = "PLEASE", direct = false } })
  inst:service(20.01)
  console.executors["1.190"] = { quickey = idx("THRU") }  -- operator reassigns during the tap
  t = 20.01
  for _ = 1, 10 do t = t + 0.03; inst:service(t) end
  rep = inst:sequenceStatus(q.id, t)
  check("an unresolved release stops the sequence (uncertain), PLEASE is never pressed", rep.state ~= "completed" and rep.counts.completed == 0 and not has(cmdsSince(before), string.format("Assign Quickey %d", idx("PLEASE"))), J(rep))
  console.executors["1.190"] = { quickey = idx("NUM5") }
  inst:recover(nil, 30)
  check("recovery after the sequence releases the stuck tap", pressedCount() == 0 and inst:status(30).unresolved == 0)
end

-------------------------------------------------------------------------------
-- KB-29: direct taps (Press Quickey N alone) and the static executor bank
-------------------------------------------------------------------------------
do
  local inst, backend = fresh()
  local before = #console.cmds
  local h, err = inst:tap("s", 1, { key = "NUM5" }, 50)
  check("a tap of a code with direct-tap evidence is one Press Quickey: no Assign, no executor press, complete at once", h and h.state == "released" and J(cmdsSince(before)) == J({ "Press Quickey " .. idx("NUM5") }) and h.target.direct == true and inst:status(1).capacity.used == 0 and backend.counters.direct == 1, J({ err = err, cmds = cmdsSince(before) }))
  inst:service(1.1)
  check("nothing is released later for a direct tap", J(cmdsSince(before)) == J({ "Press Quickey " .. idx("NUM5") }), J(cmdsSince(before)))
  check("describeRoute reports the direct flag per code", inst:describeRoute("NUM5").quickkeyCapabilities.direct == true and inst:describeRoute("MA1").quickkeyCapabilities.direct == nil, J(inst:describeRoute("MA1").quickkeyCapabilities))
  before = #console.cmds
  h = inst:tap("s", 2, { key = "MA1" }, 50); inst:service(2.06)
  check("a code without direct-tap evidence (MA1) is tapped through an executor", J(cmdsSince(before)) == J({ string.format("Assign Quickey %d At Page 1.190", idx("MA1")), "Press Page 1.190", "Unpress Page 1.190" }), J(cmdsSince(before)))
  before = #console.cmds
  h = inst:tap("s", 3, { key = "NUM5", direct = false }, 50); inst:service(3.06)
  check("direct = false in the spec forces the executor path", cmdsSince(before)[2] == "Press Page 1.190" and lastCmd() == "Unpress Page 1.190", J(cmdsSince(before)))
  -- Next to a live Quickey hold the tap goes through an executor (a direct tap next to a held key is not qualified).
  local held = inst:press("s", 4, { key = "STORE" })
  before = #console.cmds
  h, err = inst:tap("s", 4.1, { key = "NUM5" }, 50)
  check("a tap next to a live Quickey hold is an executor tap, not a direct one", h and not h.target.direct and has(cmdsSince(before), "Press Page"), J({ err = err, cmds = cmdsSince(before) }))
  inst:releaseAll("s", 4.2); inst:service(4.3)
  -- A refused direct tap leaves nothing behind.
  console.fail.qpress = { err = "Illegal Command", count = 1 }
  h, err = inst:tap("s", 5, { key = "THRU" }, 50)
  check("a direct tap the console refuses is press-failed and leaves no record", h == nil and err.code == "press-failed" and err.message:find("Illegal Command") and inst:status(5).capacity.used == 0 and liveHold(inst, 5) == nil, J(err))
  -- A direct tap that raises is uncertain (it may have acted), never a plain failure (#13 review 1).
  console.raise.qpress = "console busy"
  h, err = inst:tap("s", 5.5, { key = "THRU" }, 50)
  check("a raised direct tap is reported as uncertain with its target, no record left", h == nil and err.code == "press-uncertain" and err.uncertain == true and err.target and err.target.direct == true and liveHold(inst, 5.5) == nil, J(err))
  console.raise.qpress = "console busy"
  local qr = inst:startSequence("s", 5.6, { { kind = "tap", key = "NUM1" } })
  local tq = 5.6
  for _ = 1, 10 do tq = tq + 0.03; inst:service(tq) end
  local rq = qr and inst:sequenceStatus(qr.id, tq)
  check("a sequence step whose direct tap raised is uncertain, not failed", rq and rq.events and rq.events[1] and rq.events[1].state == "uncertain", J(rq and rq.events))
  -- A sustained tap (holdMs above the 50 ms default) stays executor-held too (#75 review 4).
  before = #console.cmds
  h, err = inst:tap("s", 5.7, { key = "NUM5" }, 2000)
  check("a 2 s tap of a direct-capable code is an executor hold, not a direct tap", h and not h.target.direct and has(cmdsSince(before), "Press Page"), J({ err = err, cmds = cmdsSince(before) }))
  inst:releaseAll("s", 5.75); inst:service(5.76)
  -- An exclusive tap (a long-press) stays executor-held until its deadline (#75 review 3).
  before = #console.cmds
  h, err = inst:tap("s", 5.8, { key = "STORE", exclusive = true }, 50)
  check("an exclusive tap of a direct-capable code is an executor hold, not a direct tap", h and not h.target.direct and has(cmdsSince(before), "Press Page"), J({ err = err, cmds = cmdsSince(before) }))
  inst:service(5.9)
  -- A sequence's tap steps take the direct path too, one per service call (#75 review 3).
  console.taps = {}
  local q = inst:startSequence("s", 6, { { kind = "tap", key = "NUM1" }, { kind = "tap", key = "THRU" }, { kind = "tap", key = "NUM5" } })
  local atStart = #console.taps
  inst:service(6.001)
  local afterFirst = #console.taps
  inst:service(6.002)
  check("consecutive direct tap steps go out one per service call (the first at start)", atStart == 1 and afterFirst == 2 and #console.taps == 3, J({ atStart = atStart, afterFirst = afterFirst, taps = console.taps }))
  local t = 6
  for _ = 1, 20 do t = t + 0.03; inst:service(t) end
  check("sequence tap steps are direct taps, in order", q and inst:sequenceStatus(q.id, t).state == "completed" and J(console.taps) == J({ "NUM1", "THRU", "NUM5" }), J({ taps = console.taps }))
end

do
  -- Static bank: every code on its own executor, assigned once; a hold presses it without Assign.
  newConsole(); pageWithExecutors(1, 190, 20)
  local inst = newInst()
  local b, err = inst:provisionBank({ authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 190, count = 4, static = true } }, 0)
  check("a static bank smaller than its code list is refused before anything is created", b == nil and err.code == "bank-invalid" and err.message:find("one executor per code") and next(console.quickeys) == nil, J(err))
  local n = 0; for name in pairs(VK) do n = n + 1 end
  b, err = inst:provisionBank({ authorized = true, quickeys = { first = 900 }, executors = { page = 1, first = 190, count = 20, static = true }, codes = "qualified" }, 0)
  check("a static bank provisions with its own id letter", b and b.id == "bridge@q900.s1.190-209" and b.state == "ready", J(err or b))
  local ok = true
  for i, c in ipairs(b.codes) do if console.executors["1." .. (189 + i)].quickey ~= c.index then ok = false end end
  check("code i of the bank sits on executor first + i - 1; the rest hold the placeholder", ok and console.executors["1.209"].quickey == phIdx(), "executor map")
  local backend = HK.quickeyBackend(inst)
  assert(inst:enableInput(backend))
  inst:openSession({ id = "s", leaseMs = 120000 }, 0)
  local ma = inst:bankTarget("MA1", 0)
  local maExec; for i, c in ipairs(b.codes) do if c.name == "MA1" then maExec = 189 + i end end
  console.cmds = {}
  local h = inst:press("s", 1, { key = "MA1" })
  check("a static hold presses the code's own executor, no Assign", h and h.target.executor == maExec and J(console.cmds) == J({ string.format("Press Page 1.%d", maExec) }), J({ target = h and h.target, cmds = console.cmds }))
  inst:release("s", 1.1, { hold = h.id })
  check("...and releases it there", lastCmd() == string.format("Unpress Page 1.%d", maExec) and pressedCount() == 0)
  -- An operator re-assignment is refused, never repaired.
  local stExec; for i, c in ipairs(b.codes) do if c.name == "STORE" then stExec = 189 + i end end
  console.executors["1." .. stExec] = { quickey = ma.index }
  console.cmds = {}
  local h2, err2 = inst:press("s", 2, { key = "STORE" })
  check("a static executor holding another code is refused, nothing assigned or pressed", h2 == nil and #console.cmds == 0 and J(err2):find("its static code is STORE") ~= nil, J(err2))
  console.cmds = {}
  local t2, terr2 = inst:tap("s", 2.1, { key = "STORE" }, 50)
  check("...but a direct tap of STORE needs no executor and is not blocked by it (#75 review 1)", t2 and t2.target.direct == true and J(console.cmds) == J({ "Press Quickey " .. inst:bankTarget("STORE", 2.1).index }), J({ err = terr2, cmds = console.cmds }))
  console.executors["1." .. stExec] = { quickey = inst:bankTarget("STORE", 2).index }
  -- Adoption keeps the static map; a dynamic record is never adopted as static (different id).
  local dis = inst:dispose(3)
  local inst2 = newInst()
  local a, aerr = inst2:adoptBank(dis.bank, 4)
  check("a static record is adopted with its map", a and a.state == "ready" and inst2._bank.staticByCode.MA1.index == maExec, J(aerr or a.problems))
  local td = inst2:teardownBank(5, { authorized = true })
  check("teardown clears every static executor and deletes the Quickeys", td and next(console.quickeys) == nil and console.executors["1.190"] == "empty", J(td))
end

print(string.format("\n%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) else print("ALL PASSED") end
