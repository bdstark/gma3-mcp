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
local dirLists = 0
DirList = function(path, filter)
  dirLists = dirLists + 1
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

-- Every upload carries the client's id; the bridge keeps its bytes in "<file>.<id>.gma3mcp-part".
local ID = "0123456789abcdef"
local PART = "." .. ID .. ".gma3mcp-part"
local function add(a) a.upload = a.upload or ID; return request("patch.libraryAdd", a) end

local r = request("ping", {})
check("ping reports bridge 0.38.1", r.ok and r.result.bridgeVersion == "0.45.0", J(r))
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

r = add({ file = FILE, offset = 0, data = b64(c1), total = total, crc32 = sum })
check("first chunk: received, not final", r.ok and r.result.received == #c1 and r.result.total == total, J(r))
check("nothing is in place before the final chunk", slurp(USER .. "/" .. FILE) == nil and slurp(USER .. "/" .. FILE .. PART) == c1)
r = request("patch.library", { sources = { "user" } })
check("the part file is not listed in the library", r.ok and r.result.total == 0, J(r))
r = add({ file = FILE, offset = 50, data = b64(c2), total = total, crc32 = sum })
check("a chunk at the wrong offset is refused and the part file removed", r.ok == false and r.code == "bad-offset" and slurp(USER .. "/" .. FILE .. PART) == nil, J(r))

local function upload(file, data, extra)
  local parts, off = {}, 0
  for i = 1, #data, 100 do parts[#parts + 1] = data:sub(i, i + 99) end
  local res
  for i, p in ipairs(parts) do
    local a = { file = file, offset = off, data = b64(p), total = #data, crc32 = crc32(data), final = i == #parts }
    for k, v in pairs(extra or {}) do a[k] = v end
    res = add(a)
    if not res.ok then return res end
    off = off + #p
  end
  return res
end
r = upload(FILE, blob)
check("the final chunk moves the file into place with size and CRC", r.ok and r.result.size == total and r.result.crc32 == sum and r.result.replaced == false and r.result.format == "gdtf", J(r))
check("the bytes on disk are the bytes sent", slurp(USER .. "/" .. FILE) == blob and slurp(USER .. "/" .. FILE .. PART) == nil)
r = request("patch.libraryStat", { file = FILE })
check("libraryStat reads the file back and lists it under user", r.ok and r.result.exists == true and r.result.size == total and r.result.crc32 == sum and r.result.listedIn[1] == "user" and #r.result.listedIn == 1, J(r))
r = request("patch.library", { file = FILE })
check("patch.library lists the new file under source user", r.ok and r.result.total == 1 and r.result.entries[1].source == "user" and r.result.entries[1].manufacturer == "Acme" and r.result.entries[1].model == "Beam 180", J(r))

r = upload(FILE, "other bytes")
check("an existing file is refused without replace and left alone", r.ok == false and r.code == "exists" and slurp(USER .. "/" .. FILE) == blob, J(r))
-- A platform whose rename does not replace an existing file (Windows): the old file goes aside and comes back on failure.
local realRename = os.rename
local function noReplaceRename(failMoveIn)
  return function(from, to)
    if slurp(to) ~= nil then return nil, "file exists" end
    if failMoveIn and from:sub(-#".gma3mcp-part") == ".gma3mcp-part" then return nil, "injected failure" end
    return realRename(from, to)
  end
end
os.rename = noReplaceRename(true)
r = upload(FILE, "other bytes", { replace = true })
os.rename = realRename
check("a replace whose move fails keeps the existing file", r.ok == false and r.code == "write-failed" and tostring(r.error):find("unchanged") and slurp(USER .. "/" .. FILE) == blob
  and slurp(USER .. "/" .. FILE .. "." .. ID .. ".gma3mcp-old") == nil and slurp(USER .. "/" .. FILE .. PART) == nil, J(r))
os.rename = noReplaceRename(false)
r = upload(FILE, "other bytes", { replace = true })
os.rename = realRename
check("replace works where rename does not overwrite, leaving no backup", r.ok and r.result.replaced == true and slurp(USER .. "/" .. FILE) == "other bytes" and slurp(USER .. "/" .. FILE .. "." .. ID .. ".gma3mcp-old") == nil, J(r))
r = upload(FILE, "third bytes", { replace = true })
check("replace overwrites it", r.ok and r.result.replaced == true and slurp(USER .. "/" .. FILE) == "third bytes", J(r))

r = add({ file = "Acme@Wrong Sum.xml", offset = 0, data = b64("<GMA3/>"), total = 7, crc32 = "00000000", final = true })
check("a CRC mismatch is refused, nothing left behind", r.ok == false and r.code == "crc-mismatch" and slurp(USER .. "/Acme@Wrong Sum.xml") == nil and slurp(USER .. "/Acme@Wrong Sum.xml" .. PART) == nil, J(r))
r = add({ file = "Acme@Short.xml", offset = 0, data = b64("<GMA3/>"), total = 9, crc32 = crc32("<GMA3/>"), final = true })
check("a size mismatch is refused", r.ok == false and r.code == "size-mismatch" and slurp(USER .. "/Acme@Short.xml") == nil, J(r))
r = add({ file = "Acme@Long.xml", offset = 0, data = b64("<GMA3/>"), total = 3, crc32 = crc32("<GMA3/>") })
check("chunks longer than total are refused", r.ok == false and r.code == "too-long" and slurp(USER .. "/Acme@Long.xml" .. PART) == nil, J(r))
r = add({ file = "Acme@Bad.xml", offset = 0, data = "ab$=", total = 3, crc32 = "00000000" })
check("invalid base64 is refused before anything is written", r.ok == false and r.code == "bad-args" and slurp(USER .. "/Acme@Bad.xml" .. PART) == nil, J(r))
r = add({ file = "Acme@Bad.xml", offset = 0, data = "YQ=a", total = 3, crc32 = "00000000" })
check("padding inside the data is refused", r.ok == false and r.code == "bad-args", J(r))
r = add({ file = "taken@in ma3.xml", offset = 0, data = b64("<GMA3/>"), total = 7, crc32 = crc32("<GMA3/>"), final = true })
check("a name another library has is refused", r.ok == false and r.code == "ambiguous-file" and slurp(USER .. "/taken@in ma3.xml") == nil, J(r))
r = add({ file = "Taken@In MA3.xml", offset = 0, data = b64("<GMA3/>"), total = 7, crc32 = crc32("<GMA3/>"), final = true })
check("a name another library has in other case is refused (review of PR #84)", r.ok == false and r.code == "ambiguous-file" and r.detail.collidesWith == "taken@in ma3.xml" and slurp(USER .. "/Taken@In MA3.xml") == nil, J(r))
r = request("patch.libraryStat", { file = "Taken@In MA3.xml" })
check("libraryStat lists a case-only match in matches, not in listedIn", r.ok and #r.result.listedIn == 0 and #r.result.matches == 1 and r.result.matches[1].file == "taken@in ma3.xml" and r.result.matches[1].source == "grandma3", J(r))
upload("acme@case.gdtf", "lower")
r = upload("Acme@Case.gdtf", "upper", { replace = true })
check("a user-library name in other case is refused even with replace", r.ok == false and r.code == "ambiguous-file" and r.detail.collidesWith == "acme@case.gdtf" and slurp(USER .. "/acme@case.gdtf") == "lower", J(r))
os.remove(USER .. "/acme@case.gdtf")
r = add({ file = "Acme@Big.gdtf", offset = 0, data = b64("PK"), total = 8 * 1024 * 1024 + 1, crc32 = "00000000" })
check("a total over the size cap is refused", r.ok == false and r.code == "bad-args", J(r))

for _, bad in ipairs({ "Acme@Spot:revision.xml", "Acme@Spot<1>.gdtf", "Acme@Spot>1.gdtf", "Acme@Spot|2.gdtf", "Acme@Spot?.gdtf", "Acme@Spot*.gdtf", "Acme@Upper.XML", "Acme@Upper.Gdtf", "../evil@x.gdtf", "a/b@c.gdtf", "nomanufacturer.gdtf", "a@b.txt", "a@b@c@d.gdtf", ".a@b.gdtf", 'a@"b".gdtf', "a@ b.gdtf", "a@@b.gdtf", "a@b\n.gdtf" }) do
  r = add({ file = bad, offset = 0, data = b64("x"), total = 1, crc32 = crc32("x"), final = true })
  check("bad name refused: " .. bad:gsub("\n", "\\n"), r.ok == false and (r.code == "bad-name" or r.code == "bad-args"), J(r))
end
r = add({ file = "Acme@NoId.gdtf", upload = "short", offset = 0, data = b64("x"), total = 1, crc32 = crc32("x") })
check("an upload without a 16-hex-digit id is refused", r.ok == false and r.code == "bad-args", J(r))

-- Review of PR #84: two clients sending the same name keep their own part files; the first to finish wins.
local IDB = "fedcba9876543210"
local PARTB = "." .. IDB .. ".gma3mcp-part"
local TWO = "Acme@Two Clients.gdtf"
add({ file = TWO, offset = 0, data = b64("aaaa"), total = 8, crc32 = crc32("aaaaAAAA") })
add({ file = TWO, upload = IDB, offset = 0, data = b64("bbbb"), total = 8, crc32 = crc32("bbbbBBBB") })
check("two uploads of one name write separate part files", slurp(USER .. "/" .. TWO .. PART) == "aaaa" and slurp(USER .. "/" .. TWO .. PARTB) == "bbbb")
r = add({ file = TWO, upload = IDB, abort = true })
check("one client's abort leaves the other's part file", r.ok and r.result.removed == true and slurp(USER .. "/" .. TWO .. PART) == "aaaa" and slurp(USER .. "/" .. TWO .. PARTB) == nil, J(r))
r = add({ file = TWO, upload = IDB, offset = 4, data = b64("BBBB"), total = 8, crc32 = crc32("bbbbBBBB"), final = true })
check("a chunk of an aborted upload is refused (start again)", r.ok == false and r.code == "bad-offset" and slurp(USER .. "/" .. TWO .. PART) == "aaaa", J(r))
add({ file = TWO, upload = IDB, offset = 0, data = b64("bbbb"), total = 8, crc32 = crc32("bbbbBBBB") })
r = add({ file = TWO, offset = 4, data = b64("AAAA"), total = 8, crc32 = crc32("aaaaAAAA"), final = true })
check("the first upload to finish is moved into place", r.ok and slurp(USER .. "/" .. TWO) == "aaaaAAAA" and slurp(USER .. "/" .. TWO .. PARTB) == "bbbb", J(r))
r = add({ file = TWO, upload = IDB, offset = 4, data = b64("BBBB"), total = 8, crc32 = crc32("bbbbBBBB"), final = true })
check("the second is refused as existing, its part file removed, the first's file kept", r.ok == false and r.code == "exists" and slurp(USER .. "/" .. TWO) == "aaaaAAAA" and slurp(USER .. "/" .. TWO .. PARTB) == nil, J(r))
os.remove(USER .. "/" .. TWO)

-- Review of PR #84: the library is scanned at the first and the last chunk only.
local SCAN = "Acme@Scan.gdtf"
local data5 = string.rep("s", 500)
local seen = {}
for i = 0, 4 do
  local before = dirLists
  r = add({ file = SCAN, offset = i * 100, data = b64(data5:sub(i * 100 + 1, i * 100 + 100)), total = 500, crc32 = crc32(data5), final = i == 4 })
  seen[#seen + 1] = dirLists - before
end
check("only the first and the last chunk scan the libraries", r.ok and seen[1] > 0 and seen[2] == 0 and seen[3] == 0 and seen[4] == 0 and seen[5] > 0, table.concat(seen, ","))
os.remove(USER .. "/" .. SCAN)

-- Review of PR #84: a replaced .xml with the same size (and DirList time) is read anew, not from the header cache.
local XML_A = '<GMA3><FixtureType Name="AAAA" Manufacturer="Acme"></FixtureType></GMA3>'
local XML_B = '<GMA3><FixtureType Name="BBBB" Manufacturer="Acme"></FixtureType></GMA3>'
upload("Acme@Cached.xml", XML_A)
r = request("patch.library", { query = "acme cached" })
check("(the first header is read)", r.ok and r.result.entries[1] and r.result.entries[1].name == "AAAA", J(r))
upload("Acme@Cached.xml", XML_B, { replace = true })
r = request("patch.library", { query = "acme cached" })
check("a replaced .xml of the same size reads its new header", r.ok and r.result.entries[1] and r.result.entries[1].name == "BBBB", J(r))
os.remove(USER .. "/Acme@Cached.xml")

-- Review of PR #84: the library header reader takes what the upload accepts: either quote, a comment or CDATA with an
-- element in it, a '>' or an entity inside a value.
upload("Acme@Alias.xml", "<?xml version='1.0'?>\n<GMA3><!-- <FixtureType Name=\"Old\" Manufacturer=\"Gone\"> --><![CDATA[<FixtureType Name=\"Cdata\">]]>"
  .. "<FixtureType Name='Spot' Manufacturer='Acme' Description='a > b &#x26; &#233;'><DMXModes><!-- <DMXMode Name=\"Hidden\"/> --><DMXMode Name='Std'/><DMXMode Geometry=\"B\" Name=\"Ext &amp; 16\"></DMXMode></DMXModes></FixtureType></GMA3>")
r = request("patch.library", { file = "Acme@Alias.xml" })
local alias = r.ok and r.result.entries[1] or {}
check("an .xml header is read from the real element, with either quote", alias.name == "Spot" and alias.manufacturer == "Acme" and alias.description == "a > b & \u{e9}"
  and alias.modes and #alias.modes == 2 and alias.modes[1] == "Std" and alias.modes[2] == "Ext & 16", J(r))
os.remove(USER .. "/Acme@Alias.xml")
upload("Acme@Pi.xml", '<?xml version="1.0"?><?note <FixtureType Name="Fake" Manufacturer="Pi"> ?><GMA3><FixtureType Name="Real" Manufacturer="Acme"></FixtureType></GMA3>')
r = request("patch.library", { file = "Acme@Pi.xml" })
upload("Acme@Refs.xml", '<GMA3><FixtureType Name="Spot &#38;amp; Co &amp;lt;x&#x3E;" Manufacturer="Acme"></FixtureType></GMA3>')
local refs = request("patch.library", { file = "Acme@Refs.xml" })
check("references decode in one pass: &#38;amp; is &amp; (review of PR #84)", refs.ok and refs.result.entries[1].name == "Spot &amp; Co &lt;x>", J(refs))
os.remove(USER .. "/Acme@Refs.xml")
check("a FixtureType inside a processing instruction is not the header (review of PR #84)", r.ok and r.result.entries[1] and r.result.entries[1].name == "Real" and r.result.entries[1].manufacturer == "Acme", J(r))
os.remove(USER .. "/Acme@Pi.xml")

upload("Acme@Order.xml", '<GMA3><![CDATA[<!--]]><FixtureType Name="Spot" Manufacturer="Acme"/><!-- end --></GMA3>')
r = request("patch.library", { file = "Acme@Order.xml" })
check("a comment opener inside CDATA is text: the header after it is read (review of PR #84)", r.ok and r.result.entries[1] and r.result.entries[1].name == "Spot", J(r))
os.remove(USER .. "/Acme@Order.xml")

-- Review of PR #84: a library that cannot be listed is not taken for empty: nothing is written.
local realDirList = DirList
DirList = function(path, filter) if path == LIBPATHS[3] then error("disk error") end return realDirList(path, filter) end
r = add({ file = "Acme@Blind.gdtf", offset = 0, data = b64("PK"), total = 2, crc32 = crc32("PK"), final = true })
local stat = request("patch.libraryStat", { file = "Acme@Blind.gdtf" })
DirList = realDirList
check("an unreadable library refuses the upload", r.ok == false and r.code == "scan-incomplete" and tostring(r.error):find("grandma2") and slurp(USER .. "/Acme@Blind.gdtf") == nil and slurp(USER .. "/Acme@Blind.gdtf" .. PART) == nil, J(r))
check("and libraryStat says so", stat.ok == false and stat.code == "scan-incomplete", J(stat))
local realGetPath = GetPath
GetPath = function(pt) if pt == 5 then error("no path") end return realGetPath(pt) end
r = add({ file = "Acme@Blind.gdtf", offset = 0, data = b64("PK"), total = 2, crc32 = crc32("PK"), final = true })
GetPath = realGetPath
check("a library whose folder cannot be read refuses it too", r.ok == false and r.code == "scan-incomplete" and tostring(r.error):find("worldserver"), J(r))

-- Review of PR #84: a part file no upload knows (left by a bridge restart) is removed when an upload starts; a part
-- file of a running upload and a kept ".gma3mcp-old" file are not.
put(USER .. "/Acme@Orphan.gdtf.aaaaaaaaaaaaaaaa.gma3mcp-part", "orphan")
put(USER .. "/Acme@Kept.gdtf.bbbbbbbbbbbbbbbb.gma3mcp-old", "kept original")
add({ file = "Acme@Running.gdtf", upload = "cccccccccccccccc", offset = 0, data = b64("run"), total = 6, crc32 = crc32("runrun") })
add({ file = "Acme@Start.gdtf", offset = 0, data = b64("st"), total = 4, crc32 = crc32("stst") })
check("an orphaned part file is removed when an upload starts", slurp(USER .. "/Acme@Orphan.gdtf.aaaaaaaaaaaaaaaa.gma3mcp-part") == nil)
check("a running upload's part file and a kept original are left", slurp(USER .. "/Acme@Running.gdtf.cccccccccccccccc.gma3mcp-part") == "run" and slurp(USER .. "/Acme@Start.gdtf" .. PART) == "st"
  and slurp(USER .. "/Acme@Kept.gdtf.bbbbbbbbbbbbbbbb.gma3mcp-old") == "kept original")
add({ file = "Acme@Running.gdtf", upload = "cccccccccccccccc", abort = true })
add({ file = "Acme@Start.gdtf", abort = true })
os.remove(USER .. "/Acme@Kept.gdtf.bbbbbbbbbbbbbbbb.gma3mcp-old")

local p = io.popen('ls -1A "' .. USER .. '"'); local listing = p:read("a"); p:close()
check("only the uploaded files are in the user library", listing == FILE .. "\n", listing)

add({ file = "Acme@Aborted.gdtf", offset = 0, data = b64("PK"), total = 10, crc32 = "00000000" })
r = add({ file = "Acme@Aborted.gdtf", abort = true })
check("abort removes the part file", r.ok and r.result.removed == true and r.result.partLeft == false and slurp(USER .. "/Acme@Aborted.gdtf" .. PART) == nil, J(r))

os.execute('rm -rf "' .. LIBDIR .. '"')
print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then os.exit(1) end
