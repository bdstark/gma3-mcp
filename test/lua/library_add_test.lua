-- Regression harness for the bridge's user-library upload ops (SU-22, bridge 0.38.0) under stock Lua (5.4 or newer):
-- patch.libraryStat and patch.libraryAdd.
--
-- The four library folders are temp folders on disk; DirList lists them as the console does (name, size, time), so a
-- file the bridge writes shows up in patch.library under source "user".
--
-- Run from the repository root:   lua test/lua/library_add_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
Enums = { PathType = { Temp = 1, GrandMA3Library = 2, GrandMA2Library = 3, UserFixtures = 4, WorldServerLibrary = 5 }, Roles = { Display = 1 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
CurrentUser = function() return nil end
CmdObj = function() return { Get = function() return "Root" end } end
GetTopModal = function() return nil end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end

local LIBDIR = os.tmpname(); os.remove(LIBDIR)
os.execute('mkdir -p "' .. LIBDIR .. '/ma3" "' .. LIBDIR .. '/ma2" "' .. LIBDIR .. '/user" "' .. LIBDIR .. '/ws"')
local LIBPATHS = { [2] = LIBDIR .. "/ma3", [3] = LIBDIR .. "/ma2", [4] = LIBDIR .. "/user", [5] = LIBDIR .. "/ws" }
local USER = LIBPATHS[4]
local function put(path, bytes) local f = assert(io.open(path, "wb")); f:write(bytes); f:close() end
local function slurp(path) local f = io.open(path, "rb"); if not f then return nil end local s = f:read("a"); f:close(); return s end
put(LIBPATHS[2] .. "/taken@in ma3.xml", "<GMA3/>")
GetPath = function(pt) return LIBPATHS[pt] end
DirList = function(path, filter)
  local ext = filter and filter:match("^%*%.(.+)$")
  local out = {}
  local p = io.popen('ls -1 "' .. path .. '" 2>/dev/null')
  for name in p:lines() do
    if not ext or name:sub(-#ext - 1) == "." .. ext then
      local f = io.open(path .. "/" .. name, "rb"); local size = f and f:seek("end") or 0; if f then f:close() end
      out[#out + 1] = { name = name, size = size, time = 0 }
    end
  end
  p:close()
  return out
end

local Obj = {}
Obj.__index = function(t, k)
  local v = Obj[k]
  if v ~= nil then return v end
  for _, c in ipairs(rawget(t, "kids") or {}) do if rawget(c, "name") == k then return c end end
  return nil
end
function Obj:Children() return self.kids end
function Obj:Count() return #self.kids end
local function obj(name, kids) return setmetatable({ name = name, kids = kids or {} }, Obj) end
local LIVE = { FixtureTypes = obj("FixtureTypes"), Stages = obj("Stages") }
ShowData = function() return { LivePatch = LIVE, Patch = obj("Patch") } end
Patch = function() return LIVE end

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

-- Reference encoders, independent of the bridge's decoder and CRC.
local ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function b64(s)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = (a << 16) | ((b or 0) << 8) | (c or 0)
    local q = { (n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63 }
    out[#out + 1] = ALPHA:sub(q[1] + 1, q[1] + 1) .. ALPHA:sub(q[2] + 1, q[2] + 1) .. (b and ALPHA:sub(q[3] + 1, q[3] + 1) or "=") .. (c and ALPHA:sub(q[4] + 1, q[4] + 1) or "=")
  end
  return table.concat(out)
end
local function crc32(s)
  local crc = 0xffffffff
  for i = 1, #s do
    crc = crc ~ s:byte(i)
    for _ = 1, 8 do crc = (crc & 1) == 1 and (0xEDB88320 ~ (crc >> 1)) or (crc >> 1) end
  end
  return string.format("%08x", crc ~ 0xffffffff)
end

local r = request("ping", {})
check("ping reports bridge 0.38.0", r.ok and r.result.bridgeVersion == "0.38.0", J(r))
check("the CRC reference matches zlib's check value", crc32("123456789") == "cbf43926")

-- Every byte value, in three chunks of uneven length (padding 0, 1 and 2 at the ends).
local blob = {}
for i = 0, 255 do blob[#blob + 1] = string.char(i) end
for i = 1, 40 do blob[#blob + 1] = string.char((i * 37) % 256) end
blob = table.concat(blob) .. "xy"
local FILE = "Acme@Beam 180@2026-10-20.gdtf"
local c1, c2, c3 = blob:sub(1, 99), blob:sub(100, 200), blob:sub(201)
local total, sum = #blob, crc32(blob)

r = request("patch.libraryStat", { file = FILE })
check("libraryStat: a missing file reads exists false", r.ok and r.result.exists == false and r.result.size == nil and #r.result.listedIn == 0 and r.result.path == USER .. "/" .. FILE, J(r))

r = request("patch.libraryAdd", { file = FILE, offset = 0, data = b64(c1), total = total, crc32 = sum })
check("first chunk: received, not final", r.ok and r.result.received == #c1 and r.result.total == total, J(r))
check("nothing is in place before the final chunk", slurp(USER .. "/" .. FILE) == nil and slurp(USER .. "/" .. FILE .. ".gma3mcp-part") == c1)
r = request("patch.library", { sources = { "user" } })
check("the part file is not listed in the library", r.ok and r.result.total == 0, J(r))
r = request("patch.libraryAdd", { file = FILE, offset = 50, data = b64(c2), total = total, crc32 = sum })
check("a chunk at the wrong offset is refused and the part file removed", r.ok == false and r.code == "bad-offset" and slurp(USER .. "/" .. FILE .. ".gma3mcp-part") == nil, J(r))

local function upload(file, data, extra)
  local parts, off = {}, 0
  for i = 1, #data, 100 do parts[#parts + 1] = data:sub(i, i + 99) end
  local res
  for i, p in ipairs(parts) do
    local a = { file = file, offset = off, data = b64(p), total = #data, crc32 = crc32(data), final = i == #parts }
    for k, v in pairs(extra or {}) do a[k] = v end
    res = request("patch.libraryAdd", a)
    if not res.ok then return res end
    off = off + #p
  end
  return res
end
r = upload(FILE, blob)
check("the final chunk moves the file into place with size and CRC", r.ok and r.result.size == total and r.result.crc32 == sum and r.result.replaced == false and r.result.format == "gdtf", J(r))
check("the bytes on disk are the bytes sent", slurp(USER .. "/" .. FILE) == blob and slurp(USER .. "/" .. FILE .. ".gma3mcp-part") == nil)
r = request("patch.libraryStat", { file = FILE })
check("libraryStat reads the file back and lists it under user", r.ok and r.result.exists == true and r.result.size == total and r.result.crc32 == sum and r.result.listedIn[1] == "user" and #r.result.listedIn == 1, J(r))
r = request("patch.library", { file = FILE })
check("patch.library lists the new file under source user", r.ok and r.result.total == 1 and r.result.entries[1].source == "user" and r.result.entries[1].manufacturer == "Acme" and r.result.entries[1].model == "Beam 180", J(r))

r = upload(FILE, "other bytes")
check("an existing file is refused without replace and left alone", r.ok == false and r.code == "exists" and slurp(USER .. "/" .. FILE) == blob, J(r))
r = upload(FILE, "other bytes", { replace = true })
check("replace overwrites it", r.ok and r.result.replaced == true and slurp(USER .. "/" .. FILE) == "other bytes", J(r))

r = request("patch.libraryAdd", { file = "Acme@Wrong Sum.xml", offset = 0, data = b64("<GMA3/>"), total = 7, crc32 = "00000000", final = true })
check("a CRC mismatch is refused, nothing left behind", r.ok == false and r.code == "crc-mismatch" and slurp(USER .. "/Acme@Wrong Sum.xml") == nil and slurp(USER .. "/Acme@Wrong Sum.xml.gma3mcp-part") == nil, J(r))
r = request("patch.libraryAdd", { file = "Acme@Short.xml", offset = 0, data = b64("<GMA3/>"), total = 9, crc32 = crc32("<GMA3/>"), final = true })
check("a size mismatch is refused", r.ok == false and r.code == "size-mismatch" and slurp(USER .. "/Acme@Short.xml") == nil, J(r))
r = request("patch.libraryAdd", { file = "Acme@Long.xml", offset = 0, data = b64("<GMA3/>"), total = 3, crc32 = crc32("<GMA3/>") })
check("chunks longer than total are refused", r.ok == false and r.code == "too-long" and slurp(USER .. "/Acme@Long.xml.gma3mcp-part") == nil, J(r))
r = request("patch.libraryAdd", { file = "Acme@Bad.xml", offset = 0, data = "ab$=", total = 3, crc32 = "00000000" })
check("invalid base64 is refused before anything is written", r.ok == false and r.code == "bad-args" and slurp(USER .. "/Acme@Bad.xml.gma3mcp-part") == nil, J(r))
r = request("patch.libraryAdd", { file = "Acme@Bad.xml", offset = 0, data = "YQ=a", total = 3, crc32 = "00000000" })
check("padding inside the data is refused", r.ok == false and r.code == "bad-args", J(r))
r = request("patch.libraryAdd", { file = "taken@in ma3.xml", offset = 0, data = b64("<GMA3/>"), total = 7, crc32 = crc32("<GMA3/>"), final = true })
check("a name another library has is refused", r.ok == false and r.code == "ambiguous-file" and slurp(USER .. "/taken@in ma3.xml") == nil, J(r))
r = request("patch.libraryAdd", { file = "Acme@Big.gdtf", offset = 0, data = b64("PK"), total = 8 * 1024 * 1024 + 1, crc32 = "00000000" })
check("a total over the size cap is refused", r.ok == false and r.code == "bad-args", J(r))

for _, bad in ipairs({ "../evil@x.gdtf", "a/b@c.gdtf", "nomanufacturer.gdtf", "a@b.txt", "a@b@c@d.gdtf", ".a@b.gdtf", 'a@"b".gdtf', "a@ b.gdtf", "a@@b.gdtf", "a@b\n.gdtf" }) do
  r = request("patch.libraryAdd", { file = bad, offset = 0, data = b64("x"), total = 1, crc32 = crc32("x"), final = true })
  check("bad name refused: " .. bad:gsub("\n", "\\n"), r.ok == false and (r.code == "bad-name" or r.code == "bad-args"), J(r))
end
local p = io.popen('ls -1A "' .. USER .. '"'); local listing = p:read("a"); p:close()
check("only the uploaded files are in the user library", listing == FILE .. "\n", listing)

request("patch.libraryAdd", { file = "Acme@Aborted.gdtf", offset = 0, data = b64("PK"), total = 10, crc32 = "00000000" })
r = request("patch.libraryAdd", { file = "Acme@Aborted.gdtf", abort = true })
check("abort removes the part file", r.ok and r.result.removed == true and r.result.partLeft == false and slurp(USER .. "/Acme@Aborted.gdtf.gma3mcp-part") == nil, J(r))

os.execute('rm -rf "' .. LIBDIR .. '"')
print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then os.exit(1) end
