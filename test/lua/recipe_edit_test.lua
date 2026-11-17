-- Regression harness for the bridge's Edit Recipe ops (bridge 0.52.0) under stock Lua (5.4 or newer):
-- recipe.editState, recipe.editBegin.
--
-- Modelled as on onPC 2.5.1 (live 2026-11-14): the current environment's RecipeEditor reads RecipeEditing "Yes" / "No",
-- the programmer's Part Zero holds the recipe lines built in Edit Recipe mode, and EditRecipe is queued with
-- CmdIndirect because the "Update last object?" dialog it can open would stall the plugin thread.
--
-- Run from the repository root:   lua test/lua/recipe_edit_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
Enums = { PathType = {}, Roles = { Display = 1 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
CurrentUser = function() return { name = "Admin" } end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end

local console = { modal = false, queue = {}, last = "OK: ClearAll" }
CmdObj = function() return { Get = function(_, k) if k == "LastCommand" then return console.last end return "Root" end } end
CmdIndirect = function(c) console.queue[#console.queue + 1] = c end
GetTopModal = function() return console.modal or nil end

local Obj = {}
Obj.__index = function(t, k)
  local v = Obj[k]
  if v ~= nil then return v end
  for _, c in ipairs(rawget(t, "kids") or {}) do if rawget(c, "name") == k then return c end end
  return nil
end
function Obj:Children() return self.kids end
function Obj:Count() return #self.kids end
function Obj:GetClass() return self.class end
function Obj:Get(k) local v = self.pv[k:upper()]; if v == nil and k:upper() == "NAME" then return self.name end; return v end
local function obj(class, name, props, kids)
  local o = setmetatable({ class = class, name = name, pv = {}, kids = kids or {} }, Obj)
  for k, v in pairs(props or {}) do o.pv[k:upper()] = v end
  return o
end

local RE = obj("RecipeEditor", "RecipeEditor", { RecipeEditing = "No" })
local ENV = obj("UserEnvironment", "Normal", {}, { RE })
local PZ = obj("Part", "Part Zero", { No = 0 })
local PROG = obj("Programmer", "Programmer", {}, { PZ })
CurrentEnvironment = function() return ENV end
Programmer = function() return PROG end

local function ui(class, name, text)
  return { class = class, name = name, Text = text, kids = {}, GetClass = function(s) return s.class end, UIChildren = function(s) return s.kids end,
    IsVisible = function() return true end, IsEnabled = function() return true end }
end
local function messageBox(title, text, buttons)
  local m = ui("MessageBox", "MsgBox")
  m.GetDisplayIndex = function() return 1 end
  local box = ui("UIObject", "Frame")
  m.kids = { box }
  box.kids[#box.kids + 1] = ui("UIObject", "Title", title)
  box.kids[#box.kids + 1] = ui("UIObject", "Text", text)
  for i, b in ipairs(buttons) do box.kids[#box.kids + 1] = ui("Button", "Button " .. i, b) end
  return m
end

local signals = {}
local pluginHandle = { name = "gma3_mcp_bridge", Count = function() return 1 end, Ptr = function(_, i) return i == 1 and { name = "gma3_mcp_bridge", Get = function() return false end } or nil end }
local componentHandle = { name = "gma3_mcp_bridge", Parent = function() return pluginHandle end }
local chunk = assert(loadfile(pluginPath))
chunk("gma3_mcp_bridge", "gma3_mcp_bridge", signals, componentHandle)
local state = _G.__gma3_mcp_bridge
local json = require("json")
local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) local ok, s = pcall(json.encode, v); return ok and s or tostring(v) end
local function request(op, args)
  local line = json.encode({ id = "t", op = op, args = args or {} })
  local co = coroutine.create(function() return state._handleLine({ id = 1 }, line) end)
  local ok, res = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok, res = coroutine.resume(co) end
  assert(ok, res)
  return json.decode(res)
end

local r = request("ping")
check("ping reports bridge 0.55.0", r.ok and r.result.bridgeVersion == "0.55.0", J(r))

r = request("recipe.editState")
check("editState: mode off, Part Zero empty, no dialog, last command", r.ok and r.result.editing == false and r.result.editingRaw == "No" and #r.result.partZeroLines == 0 and r.result.modal == false and r.result.lastCommand == "OK: ClearAll" and r.result.environment == "Normal", J(r))

r = request("recipe.editBegin", { target = "Preset 1.9002", exclusive = true })
check("editBegin queues EditRecipe with CmdIndirect, nothing run on the plugin thread", r.ok and r.result.queued == true and r.result.command == "EditRecipe Preset 1.9002" and console.queue[1] == "EditRecipe Preset 1.9002" and #console.queue == 1, J({ r, console.queue }))

r = request("recipe.editBegin", { target = "Sequence 9000 Cue 5 Part 0", exclusive = true })
check("editBegin accepts a cue part", r.ok and console.queue[2] == "EditRecipe Sequence 9000 Cue 5 Part 0", J(r))
r = request("recipe.editBegin", { target = "Sequence 9000 Cue 5.5 Part 1", exclusive = true })
check("editBegin accepts a decimal cue number", r.ok and console.queue[3] == "EditRecipe Sequence 9000 Cue 5.5 Part 1", J(r))
console.queue = {}

r = request("recipe.editBegin", { target = "Preset 1.9002" })
check("editBegin without exclusive is refused", r.ok == false and r.code == "not-exclusive" and #console.queue == 0, J(r))
r = request("recipe.editBegin", { target = "Preset 1.9002; Delete Preset 1.1", exclusive = true })
check("editBegin refuses anything but the two target forms", r.ok == false and r.code == "bad-args" and #console.queue == 0, J(r))
r = request("recipe.editBegin", { target = "Sequence 9000 Cue 5", exclusive = true })
check("editBegin refuses a cue without its part", r.ok == false and r.code == "bad-args" and #console.queue == 0, J(r))

RE.pv.RECIPEEDITING = "Yes"
r = request("recipe.editState")
check("editState reads the mode on", r.ok and r.result.editing == true and r.result.editingRaw == "Yes", J(r))
r = request("recipe.editBegin", { target = "Preset 1.9002", exclusive = true })
check("editBegin refuses while the mode is on", r.ok == false and r.code == "editing-on" and #console.queue == 0, J(r))
RE.pv.RECIPEEDITING = true
r = request("recipe.editState")
check("a boolean RecipeEditing reads as on", r.ok and r.result.editing == true, J(r))
RE.pv.RECIPEEDITING = "No"

PZ.kids = { obj("PhaserRecipe", "[9000 'TEST PH'/1 'Sine']") }
r = request("recipe.editState")
check("editState lists Part Zero's lines with their class", r.ok and #r.result.partZeroLines == 1 and r.result.partZeroLines[1].class == "PhaserRecipe" and r.result.partZeroLines[1].name == "[9000 'TEST PH'/1 'Sine']", J(r))
r = request("recipe.editBegin", { target = "Preset 1.9002", exclusive = true })
check("editBegin refuses while Part Zero holds a line", r.ok == false and r.code == "part-zero-busy" and #console.queue == 0, J(r))
PZ.kids = {}

console.modal = messageBox("Update last object?", "FeatureGroup 4 'Color'.Preset 9002 'TEST PH PHASER COUL'", { "OK", "Cancel" })
r = request("recipe.editState")
check("editState reports the dialog with title, message and buttons", r.ok and r.result.modal.title == "Update last object?" and r.result.modal.text:find("Preset 9002", 1, true) and #r.result.modal.buttons == 2, J(r))
r = request("recipe.editBegin", { target = "Preset 1.9002", exclusive = true })
check("editBegin refuses while a dialog is open", r.ok == false and r.code == "modal-open" and #console.queue == 0, J(r))
console.modal = false

GetTopModal = function() error("lookup broke") end
r = request("recipe.editState")
check("an unreadable dialog lookup is reported, never taken for no dialog", r.ok and r.result.modal == false and type(r.result.modalError) == "string", J(r))
r = request("recipe.editBegin", { target = "Preset 1.9002", exclusive = true })
check("editBegin refuses when the dialog lookup fails", r.ok == false and r.code == "modal-unknown" and #console.queue == 0, J(r))
GetTopModal = function() return console.modal or nil end

console.queue = {}
r = request("recipe.editEnd", { exclusive = true })
check("editEnd refuses while the mode is off (EditRecipe is a toggle)", r.ok == false and r.code == "editing-off" and #console.queue == 0, J(r))
r = request("recipe.editEnd", {})
check("editEnd without exclusive is refused", r.ok == false and r.code == "not-exclusive" and #console.queue == 0, J(r))
RE.pv.RECIPEEDITING = "Yes"
console.modal = messageBox("Update last object?", "x", { "OK", "Cancel" })
r = request("recipe.editEnd", { exclusive = true })
check("editEnd refuses while a dialog is open", r.ok == false and r.code == "modal-open" and #console.queue == 0, J(r))
console.modal = false
PZ.kids = { obj("PhaserRecipe", "[9000 'TEST PH'/1 'Sine']") }
r = request("recipe.editEnd", { exclusive = true })
check("editEnd queues the toggle with CmdIndirect while the mode is on, even with a line in Part Zero", r.ok and r.result.queued == true and console.queue[1] == "EditRecipe" and #console.queue == 1, J({ r, console.queue }))
PZ.kids = {}
RE.pv.RECIPEEDITING = "No"
console.queue = {}

PROG.kids = {}
r = request("recipe.editState")
check("a programmer without a Part Zero reads as no recipe line, not an error", r.ok and #r.result.partZeroLines == 0 and r.result.partZero == false, J(r))
PROG.kids = { PZ }
r = request("recipe.editState")
check("editState reports the Part Zero present", r.ok and r.result.partZero == true, J(r))

local savedEnv = CurrentEnvironment
CurrentEnvironment = function() return obj("UserEnvironment", "Normal", {}, {}) end
r = request("recipe.editState")
check("an environment without a RecipeEditor is an error", r.ok == false and r.code == "no-recipe-editor", J(r))
CurrentEnvironment = savedEnv

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
