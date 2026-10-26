-- Regression harness for the bridge's tag ops (SU-21, bridge 0.36.0) under stock Lua (5.4 or newer): tags, tags.of,
-- tags.protect, and the TAGS decoding in the object reads.
--
-- Modelled as on onPC 2.5.1 (docs/probes/su-21-tags-macos-2.5.1.md): the tag pool is ShowData().Tags (sparse); an
-- object's TAGS reads "#<hex>:<protect>,..." in the Edit role and "<name>:<protect>,..." otherwise (names may hold
-- colons); tag:GetReferences() lists every referencing object while tag:Children() lists only the first; a cue's tag
-- sits on its Part 0; StrToHandle / HandleToStr convert handles.
--
-- Run from the repository root:   lua test/lua/tags_ops_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1, Edit = 2 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- Fake handles
-------------------------------------------------------------------------------

local registry = setmetatable({}, { __mode = "k" })
local fileMeta = getmetatable(io.stdout)
local handleMeta = { __gc = fileMeta and fileMeta.__gc, __close = fileMeta and fileMeta.__close, __name = "FakeHandle" }
local methods = {}
local byHex = {}
handleMeta.__index = function(u, key)
  local def = registry[u]
  if not def then return nil end
  if methods[key] then return methods[key] end
  if key == "name" then return def.name end
  if key == "no" then return def.no end
  return nil
end

-- An object's tags: { { tag = <handle>, protect = bool }, ... }; TAGS renders them per role.
-- A sequence a kill tag has acted on lists that tag with other text after the colon (live 2026-10-19), commas included.
local KILLED = "-'..--).0-*(+,))+(0("
local function renderTags(def, role)
  local parts = {}
  for _, e in ipairs(def.tagList) do
    local t = registry[e.tag]
    parts[#parts + 1] = (role == Enums.Roles.Edit and t.hex or t.name) .. ":" .. (e.killed and KILLED or (e.protect and "1" or "0"))
  end
  return table.concat(parts, ",")
end

function methods.Get(u, name, role)
  local def = registry[u]
  local key = tostring(name):lower()
  if key == "tags" then
    if not def.tagList then return nil end
    return renderTags(def, role)
  end
  local v = def.props[key]
  if type(v) == "function" then return v(role) end
  return v
end
function methods.Set(u, name, value)
  local def = registry[u]
  if tostring(name):lower() ~= "tags" then def.props[tostring(name):lower()] = value; return end
  if value == "" then return end -- ignored on 2.5.1
  local list = {}
  for entry in value:gmatch("[^,]+") do
    local hex, flag = entry:match("^(#%x+):(%d)$")
    assert(hex and byHex[hex:upper()], "fake Set(Tags) got " .. tostring(value))
    list[#list + 1] = { tag = byHex[hex:upper()], protect = flag == "1" }
  end
  def.tagList = list
  def.sets = (def.sets or 0) + 1
end
function methods.GetClass(u) return registry[u].class end
function methods.Addr(u) return registry[u].addr end
function methods.AddrNative(u) return registry[u].addrNative end
function methods.Parent(u) return registry[u].parent end
function methods.Children(u) return registry[u].children or {} end
function methods.Count(u) local d = registry[u]; return d.count or #(d.children or {}) end
function methods.GetReferences(u) return registry[u].refs end

local function H(def)
  local u = io.tmpfile()
  debug.setmetatable(u, handleMeta)
  local lowered = {}
  for k, v in pairs(def.props or {}) do lowered[tostring(k):lower()] = v end
  def.props = lowered
  registry[u] = def
  if def.hex then byHex[def.hex:upper()] = u end
  return u
end
StrToHandle = function(s) return byHex[tostring(s):upper()] end
HandleToStr = function(h) return registry[h] and registry[h].hex end
IsObjectValid = function() return true end

local dataPools = H({ name = "DataPools", class = "DataPools" })
local dataPool = H({ name = "Default", class = "Pool", no = 1, parent = dataPools }) -- as on 2.5.1
local seqPool = H({ name = "Sequences", class = "Sequences", no = 7, parent = dataPool })
local groupPool = H({ name = "Groups", class = "Groups", no = 6, parent = dataPool })
local macroPool = H({ name = "Macros", class = "Macros", no = 9, parent = dataPool })
local tagPool = H({ name = "Tags", class = "Tags", children = {} })
local appearance = H({ name = "Red", class = "Appearance", no = 3 })

local tagA = H({ name = "McpTag A", class = "Tag", no = 950, hex = "#1BC000E42", addr = "14.5.950", parent = tagPool, tagList = {},
  props = { TagType = "Kill Instant", ForwardCommands = "Yes", Action = "Pool Default", Note = "", Lock = "No", Appearance = appearance } })
local tagC = H({ name = "McpTag:C", class = "Tag", no = 952, hex = "#1BC000E44", addr = "14.5.952", parent = tagPool, tagList = {},
  props = { TagType = "None", ForwardCommands = "No", Action = "Toggle", Note = "encore set", Lock = "No" } })
registry[tagPool].children = { tagA, tagC }

local seq950 = H({ name = "Seq A", class = "Sequence", no = 950, addr = "14.14.1.7.950", addrNative = "ShowData.DataPools.Default.Sequences.950", parent = seqPool, tagList = {} })
local seq951 = H({ name = "Seq B", class = "Sequence", no = 951, addr = "14.14.1.7.951", parent = seqPool, tagList = {} })
local cue1 = H({ name = "Cue 1", class = "Cue", no = 1000, parent = seq950 })
local part0 = H({ name = "Part 0", class = "Part", parent = cue1, props = { Part = 0 }, tagList = {} })
registry[cue1].children = { part0 }
local cueBare = H({ name = "Cue 2", class = "Cue", no = 2500, parent = seq950, children = {} })
local group950 = H({ name = "Grp", class = "Group", no = 950, parent = groupPool, tagList = {} })
local macro950 = H({ name = "Mac", class = "Macro", no = 950, parent = macroPool, tagList = {} })
local line1 = H({ name = "MacroLine 1", class = "MacroLine", no = 1, parent = macro950, tagList = {} })
local fixture = H({ name = "Par", class = "Fixture", no = 1 })

local function carry(obj, tag, protect) local l = registry[obj].tagList; l[#l + 1] = { tag = tag, protect = protect or false } end
carry(seq950, tagA); carry(seq950, tagC, true)
carry(seq951, tagC)
carry(part0, tagA)
carry(group950, tagA, true)
carry(macro950, tagA)
carry(line1, tagA)
carry(tagC, tagA)
registry[tagA].refs = { seq950, part0, group950, macro950, line1, tagC }
registry[tagA].children = { H({ name = "Ref", class = "TagReference" }) } -- only the first, as on 2.5.1
registry[tagA].count = 6
registry[tagC].refs = { seq950, seq951 }
registry[tagC].count = 2

local objects = {
  ["Sequence 950"] = { seq950 }, ["Sequence 950 Thru 951"] = { seq950, seq951 }, ["Sequence 950 Cue 1"] = { cue1 },
  ["Sequence 950 Cue 2"] = { cueBare }, ["Group 950"] = { group950 }, ["Macro 950.1"] = { line1 }, ["Fixture 1"] = { fixture },
  ["Tag 952"] = { tagC }, ["Sequence 951"] = { seq951 },
}
ObjectList = function(ref) return objects[ref] end
ShowData = function() return { Tags = tagPool } end

-------------------------------------------------------------------------------
-- Load the plugin
-------------------------------------------------------------------------------

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
local saved
local function byClass(refs, cls) for _, r in ipairs(refs or {}) do if r.class == cls then return r end end end

-------------------------------------------------------------------------------
-- tags
-------------------------------------------------------------------------------

local r = request("ping")
check("ping reports bridge 0.36.0", r.ok and r.result.bridgeVersion == "0.45.0", J(r))

r = request("tags", {})
check("tags lists the pool", r.ok and r.result.count == 2 and r.result.total == 2 and r.result.incomplete == false and r.result.items[1].no == 950 and r.result.items[2].name == "McpTag:C", J(r))
local a = r.ok and r.result.items[1] or {}
check("a tag's settings", a.tagType == "Kill Instant" and a.forwardCommands == true and a.action == "Pool Default" and a.note == "" and a.count == 6 and a.addr == "14.5.950", J(a))
check("the appearance as number and name", a.appearance and a.appearance.no == 3 and a.appearance.name == "Red", J(a.appearance))
check("every reference from GetReferences, not the single child", a.referencesTotal == 6 and #a.references == 6, J(a.references))
local sref = byClass(a.references, "Sequence")
check("a sequence reference: number, name, data pool, address, protect", sref and sref.no == 950 and sref.name == "Seq A" and sref.dataPool.name == "Default" and sref.dataPool.no == 1 and sref.addr == "14.14.1.7.950" and sref.protect == false, J(sref))
local pref = byClass(a.references, "Part")
check("a cue reference is its part, with sequence and cue", pref and pref.sequence == 950 and pref.cue == 1 and pref.part == 0 and pref.no == nil, J(pref))
check("the protect flag comes from the object's TAGS", byClass(a.references, "Group").protect == true, J(a.references))
local lref = byClass(a.references, "MacroLine")
check("a macro line says its macro", lref and lref.macro == 950 and lref.no == 1, J(lref))
check("a tag carrying a tag is a reference too", byClass(a.references, "Tag") and byClass(a.references, "Tag").no == 952, J(a.references))
local c = r.ok and r.result.items[2] or {}
check("a tag's own tags decode to number, name, protect", c.tags and #c.tags == 1 and c.tags[1].tag == 950 and c.tags[1].name == "McpTag A" and c.tags[1].protect == false, J(c.tags))
check("a name with a colon is kept whole; protect per reference", c.forwardCommands == false and byClass(c.references, "Sequence").protect == true, J(c))

r = request("tags", { tags = { "McpTag:C", 999 }, class = "Sequence" })
check("tags by name, a missing one reported, references filtered by class", r.ok and r.result.count == 1 and r.result.items[1].no == 952 and r.result.items[1].referencesTotal == 2 and r.result.missing[1] == 999, J(r))
r = request("tags", { tags = { 950 }, class = "Sequence", refLimit = 1 })
check("a class filter counts only that class", r.ok and #r.result.items[1].references == 1 and r.result.items[1].referencesTotal == 1 and r.result.items[1].referencesIncomplete == false, J(r))
r = request("tags", { tags = { 950 }, refLimit = 2 })
check("a page of references below the total says incomplete", r.ok and #r.result.items[1].references == 2 and r.result.items[1].referencesTotal == 6 and r.result.items[1].referencesIncomplete == true, J(r))
r = request("tags", { tags = { 950 }, refLimit = 2, refOffset = 4 })
check("the last page of references is complete", r.ok and #r.result.items[1].references == 2 and r.result.items[1].references[1].class == "MacroLine" and r.result.items[1].referencesIncomplete == false and r.result.items[1].referencesOffset == 4, J(r))
r = request("tags", { limit = 1, references = false })
check("a page of tags: total and incomplete", r.ok and r.result.total == 2 and r.result.count == 1 and r.result.incomplete == true and r.result.items[1].no == 950, J(r))
r = request("tags", { offset = 1, limit = 1, references = false })
check("the next page of tags", r.ok and r.result.count == 1 and r.result.items[1].no == 952 and r.result.incomplete == false, J(r))
r = request("tags", { from = 951, to = 999, references = false })
check("a number range", r.ok and r.result.total == 1 and r.result.items[1].no == 952, J(r))
r = request("tags", { references = false })
check("references: false lists settings only", r.ok and r.result.items[1].references == nil, J(r))
r = request("tags", { tags = { true } })
check("a tag that is neither number nor name is refused", r.ok == false and r.code == "bad-args", J(r))

-------------------------------------------------------------------------------
-- TAGS in the object reads
-------------------------------------------------------------------------------

r = request("objects", { ref = "Sequence 950", fields = { "Tags", "Name" } })
local tags = r.ok and r.result.items[1].fields.Tags
check("objects returns TAGS decoded", type(tags) == "table" and #tags == 2 and tags[1].tag == 950 and tags[2].name == "McpTag:C" and tags[2].protect == true, J(r))
r = request("objects", { ref = "Sequence 950", fields = { "TAGS" }, asText = false })
check("in either role, by any spelling", r.ok and r.result.items[1].fields.TAGS[1].name == "McpTag A", J(r))
r = request("objects", { ref = "Sequence 950 Thru 951", fields = { "Tags" } })
check("each object of a range reads its own list", r.ok and #r.result.items[1].fields.Tags == 2 and #r.result.items[2].fields.Tags == 1 and r.result.items[2].fields.Tags[1].tag == 952, J(r))
registry[group950].tagList, saved = {}, registry[group950].tagList
r = request("objects", { ref = "Group 950", fields = { "Tags" } })
check("an object without tags reads an empty list", r.ok and type(r.result.items[1].fields.Tags) == "table" and #r.result.items[1].fields.Tags == 0, J(r))
registry[group950].tagList = saved
saved = byHex["#1BC000E44"]
byHex["#1BC000E44"] = nil
r = request("objects", { ref = "Sequence 951", fields = { "Tags" } })
byHex["#1BC000E44"] = saved
objects["Sequence 951"] = { seq951 }
r = request("objects", { ref = "Sequence 951", fields = { "Tags" } })
check("a resolvable handle reads its number", r.ok and r.result.items[1].fields.Tags[1].tag == 952, J(r))
byHex["#1BC000E44"] = nil
r = request("objects", { ref = "Sequence 951", fields = { "Tags" } })
byHex["#1BC000E44"] = saved
check("an unresolvable handle keeps its text", r.ok and r.result.items[1].fields.Tags[1].handle == "#1BC000E44" and r.result.items[1].fields.Tags[1].tag == nil, J(r))

-------------------------------------------------------------------------------
-- tags.of
-------------------------------------------------------------------------------

r = request("tags.of", { ref = "Sequence 950 Cue 1" })
local it = r.ok and r.result.items[1] or {}
check("tags.of reads a cue as its Part 0", it.class == "Part" and it.fromCue == true and it.sequence == 950 and it.cue == 1 and it.tags[1].tag == 950, J(r))
r = request("tags.of", { ref = "Sequence 950 Cue 2" })
check("a cue without a part is an item error", r.ok and r.result.items[1].error ~= nil and r.result.items[1].cue == 2.5, J(r))
r = request("tags.of", { ref = "Fixture 1" })
check("an object without TAGS says so", r.ok and r.result.items[1].carriesTags == false, J(r))
r = request("tags.of", { ref = "Sequence 999" })
check("nothing found is not-found", r.ok == false and r.code == "not-found", J(r))

-------------------------------------------------------------------------------
-- tags.protect
-------------------------------------------------------------------------------

r = request("tags.protect", { ref = "Sequence 950 Thru 951", tag = 950, protect = true })
local p1, p2 = r.ok and r.result.items[1] or {}, r.ok and r.result.items[2] or {}
check("protect sets the flag of that tag only, keeping the others", p1.before == false and p1.after == true and p1.changed == true and registry[seq950].tagList[2].protect == true and registry[seq950].tagList[1].protect == true, J(r))
check("an object without the tag is an item error, unchanged", p2.error and p2.error:find("does not carry") and registry[seq951].sets == nil, J(p2))
r = request("tags.protect", { ref = "Sequence 950", tag = "McpTag A", protect = true })
check("an unchanged flag is not written again", r.ok and r.result.items[1].changed == false and registry[seq950].sets == 1, J(r))
r = request("tags.protect", { ref = "Sequence 950 Cue 1", tag = 950, protect = true })
check("protect on a cue writes its part", r.ok and r.result.items[1].class == "Part" and registry[part0].tagList[1].protect == true, J(r))
r = request("tags.protect", { ref = "Sequence 950", tag = 999, protect = true })
check("an unknown tag is refused", r.ok == false and r.code == "no-tag", J(r))
r = request("tags.protect", { ref = "Sequence 950", tag = 950, protect = "yes" })
check("protect must be a boolean", r.ok == false and r.code == "bad-args", J(r))

-------------------------------------------------------------------------------
-- A kill tag's entry on a played sequence: other text after the colon, commas included
-------------------------------------------------------------------------------

registry[seq951].tagList = { { tag = tagC, killed = true }, { tag = tagA, protect = true } }
r = request("tags.of", { ref = "Sequence 951" })
local k = r.ok and r.result.items[1].tags or {}
check("the killed entry is one tag with an unknown flag; the next entry still decodes", #k == 2 and k[1].tag == 952 and k[1].protect == nil and k[1].flagUnreadable == true and k[2].tag == 950 and k[2].protect == true, J(r))
r = request("tags", { tags = { 952 } })
local kref
for _, x in ipairs(r.ok and r.result.items[1].references or {}) do if x.no == 951 then kref = x end end
check("its reference says the flag is unreadable", kref and kref.protect == nil and kref.flagUnreadable == true, J(kref))
r = request("tags.protect", { ref = "Sequence 951", tag = 952, protect = true })
check("protect on the unreadable entry writes it, keeping the readable ones", r.ok and r.result.items[1].changed == true and r.result.items[1].before == nil and registry[seq951].tagList[1].protect == true and registry[seq951].tagList[2].protect == true, J(r))
registry[seq951].tagList = { { tag = tagC, killed = true }, { tag = tagA, protect = true } }
local sets = registry[seq951].sets
r = request("tags.protect", { ref = "Sequence 951", tag = 950, protect = false })
check("another tag's unreadable flag is not overwritten: the object is refused", r.ok and r.result.items[1].error and r.result.items[1].error:find("cannot be read") and registry[seq951].sets == sets, J(r))
r = request("tags.of", { ref = "Sequence 951", raw = true })
check("raw: true returns the Edit and default role text", r.ok and r.result.items[1].text.edit:find("#1BC000E44:", 1, true) == 1 and r.result.items[1].text.default:find("McpTag:C:", 1, true) == 1, J(r))

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
