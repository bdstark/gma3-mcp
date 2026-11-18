-- Regression harness for the bridge's bitmap ops (#143, bridge 0.57.0) under stock Lua (5.4 or newer): bitmap.list,
-- bitmap.set, bitmap.imageName, and kind "image" on patch.libraryStat / patch.libraryAdd.
--
-- The object model follows the probe on onPC 2.5.1.1 (2026-11-17, comment on gma3-mcp#143): Bitmap with BitmapConfigs
-- (BitmapConfig 1) and BitmapChannels (five defaults); UserImage in ShowData.MediaPools.Images. How the real console
-- answers Acquire / Delete on BitmapChannels is not known; the model appends and removes.
--
-- Run from the repository root:   lua test/lua/bitmap_ops_test.lua

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
local GL = LIBDIR .. "/gma3_library"
os.execute('mkdir -p "' .. LIBDIR .. '/ma3" "' .. LIBDIR .. '/ma2" "' .. GL .. '/fixturetypes" "' .. GL .. '/media/images" "' .. LIBDIR .. '/ws"')
local LIBPATHS = { [2] = LIBDIR .. "/ma3", [3] = LIBDIR .. "/ma2", [4] = GL .. "/fixturetypes", [5] = LIBDIR .. "/ws" }
local IMAGES = GL .. "/media/images"
local function put(path, bytes) local f = assert(io.open(path, "wb")); f:write(bytes); f:close() end
local function slurp(path) local f = io.open(path, "rb"); if not f then return nil end local s = f:read("a"); f:close(); return s end
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

-- A small console object model: name lookup of children, Get (raw or display), Set with optional refusals.
local Obj = {}
Obj.__index = function(t, k)
  local v = Obj[k]
  if v ~= nil then return v end
  for _, c in ipairs(rawget(t, "kids") or {}) do if rawget(c, "name") == k then return c end end
  return nil
end
local function obj(class, name, props, kids)
  return setmetatable({ class = class, name = name, props = props or {}, kids = kids or {}, refuse = {} }, Obj)
end
function Obj:Children() local out = {}; for i, c in ipairs(self.kids) do out[i] = c end; return out end
function Obj:Count() return #self.kids end
function Obj:GetClass() return self.class end
function Obj:Get(k, role)
  local key = k:lower()
  if key == "name" then return self.name end
  local v = self.props[key]
  if role == Enums.Roles.Display then
    if v == nil then return nil end
    if type(v) == "table" then return v.name end
    if type(v) == "number" then return (key == "width" or key == "height") and tostring(math.floor(v)) or string.format("%.2f", v) end
    return tostring(v)
  end
  return v
end
function Obj:Set(k, v)
  local key = k:lower()
  if self.refuse[key] then error("refused: " .. key, 0) end
  if key == "name" then self.name = v; return end
  if type(v) == "string" and tonumber(v) and key ~= "source" then v = tonumber(v) end
  if key == "attribute" and type(v) == "string" then v = nil end -- the model takes a handle only
  self.props[key] = v
end
function Obj:Acquire(class)
  local c = obj(class, class .. " " .. (#self.kids + 1), { source = "Const", valuelow = 0, valuehigh = 100 })
  self.kids[#self.kids + 1] = c
  return c
end
function Obj:Delete(i) table.remove(self.kids, i) end

local ATTRS = {}
for _, n in ipairs({ "Dimmer", "ColorRGB_R", "ColorRGB_G", "ColorRGB_B", "Tilt" }) do ATTRS[#ATTRS + 1] = obj("Attribute", n) end
local A = {}
for _, a in ipairs(ATTRS) do A[a.name] = a end
local LIVE = { FixtureTypes = obj("FixtureTypes", "FixtureTypes"), Stages = obj("Stages", "Stages"), AttributeDefinitions = obj("AttributeDefinitions", "AttributeDefinitions", {}, { obj("Attributes", "Attributes", {}, ATTRS) }) }
local IMAGES_POOL = obj("Images", "Images")
local BITMAPS = obj("Bitmaps", "Bitmaps")
local GENTYPES = obj("GeneratorTypes", "GeneratorTypes", {}, { BITMAPS, obj("Generators", "Generators") })
local MEDIA = obj("MediaPools", "MediaPools", {}, { obj("GoboImages", "Gobos"), obj("Symbols", "Symbols"), IMAGES_POOL })
ShowData = function() return { LivePatch = LIVE, Patch = obj("Patch", "Patch"), MediaPools = MEDIA } end
Patch = function() return LIVE end
local DP = obj("DataPool", "Default", {}, { GENTYPES })
DataPool = function() return DP end

local function addImage(no, file, size)
  local img = obj("UserImage", "[" .. file:gsub("%.", "_") .. "]", { filename = file, filesize = size .. "B", width = 0, height = 0 })
  img.no = no
  IMAGES_POOL.kids[#IMAGES_POOL.kids + 1] = img
  return img
end
local function newBitmap(no)
  local cfg = obj("BitmapConfig", "BitmapConfig 1", { width = 64, height = 64, contentmode = "None", interpolate = "No", alpha = "No", controlx = 0, controly = 0, controlzoom = 50, controlaspect = 1, controlrotate = 0 })
  local function ch(a, src) return obj("BitmapChannel", "BitmapChannel", { attribute = A[a], source = src, valuelow = 0, valuehigh = 100 }) end
  local b = obj("Bitmap", "Bitmap " .. no, { speedmaster = "None" }, {
    obj("BitmapConfigs", "BitmapConfigs", {}, { cfg }),
    obj("BitmapChannels", "BitmapChannels", {}, { ch("Dimmer", "Intensity"), ch("Dimmer", "Const"), ch("ColorRGB_R", "Red"), ch("ColorRGB_G", "Green"), ch("ColorRGB_B", "Blue") }),
  })
  b.no = no
  BITMAPS.kids[#BITMAPS.kids + 1] = b
  return b, cfg
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
check("ping reports bridge 0.57.0", r.ok and r.result.bridgeVersion == "0.61.0", J(r))

-- Image uploads go to gma3_library/media/images, next to the user fixture library.
local PNG = "\137PNG\r\n\26\n" .. string.rep("x", 150)
local ID = "fedcba9876543210"
r = request("patch.libraryStat", { file = "rainbow.png", kind = "image" })
check("libraryStat kind image: the folder is gma3_library/media/images, derived from the fixture library", r.ok and r.result.kind == "image" and r.result.folder == IMAGES and r.result.folderFrom == "derived" and r.result.exists == false and r.result.maxBytes == 10 * 1024 * 1024, J(r))
r = request("patch.libraryStat", { file = "rainbow.PNG", kind = "image" })
check("an upper-case extension is refused", r.ok == false and r.code == "bad-name", J(r))
r = request("patch.libraryStat", { file = "Acme@Spot.gdtf", kind = "image" })
check("a fixture file name is not an image name", r.ok == false and r.code == "bad-name", J(r))
r = request("patch.libraryStat", { file = "../x.png", kind = "image" })
check("a path in the name is refused", r.ok == false and r.code == "bad-name", J(r))
r = request("patch.libraryStat", { file = "x.png", kind = "video" })
check("an unknown kind is refused", r.ok == false and r.code == "bad-args", J(r))

r = request("patch.libraryAdd", { file = "rainbow.png", kind = "image", upload = ID, offset = 0, data = b64(PNG:sub(1, 80)), total = #PNG, crc32 = crc32(PNG) })
check("first image chunk: received", r.ok and r.result.received == 80, J(r))
check("nothing is in place before the final chunk", slurp(IMAGES .. "/rainbow.png") == nil and slurp(IMAGES .. "/rainbow.png." .. ID .. ".gma3mcp-part") == PNG:sub(1, 80))
r = request("patch.libraryAdd", { file = "rainbow.png", kind = "image", upload = ID, offset = 80, data = b64(PNG:sub(81)), total = #PNG, crc32 = crc32(PNG), final = true })
check("final image chunk: moved into the images folder with size and CRC", r.ok and r.result.kind == "image" and r.result.format == "png" and r.result.size == #PNG and r.result.crc32 == crc32(PNG) and slurp(IMAGES .. "/rainbow.png") == PNG and slurp(LIBPATHS[4] .. "/rainbow.png") == nil, J(r))
r = request("patch.libraryAdd", { file = "rainbow.png", kind = "image", upload = ID, offset = 0, data = b64(PNG), total = #PNG, crc32 = crc32(PNG), final = true })
check("an existing image file is refused without replace", r.ok == false and r.code == "exists" and tostring(r.error):find("images folder", 1, true) ~= nil, J(r))
-- With replace (on a case-insensitive file system the name already "exists" without it), a name differing only in case
-- is still refused: it would overwrite the other file under another name.
r = request("patch.libraryAdd", { file = "Rainbow.png", kind = "image", upload = ID, offset = 0, data = b64(PNG), total = #PNG, crc32 = crc32(PNG), final = true, replace = true })
check("a name differing only in case is refused as ambiguous, even with replace", r.ok == false and r.code == "ambiguous-file" and r.detail.collidesWith == "rainbow.png" and slurp(IMAGES .. "/rainbow.png") == PNG, J(r))
r = request("patch.libraryAdd", { file = "big.png", kind = "image", upload = ID, offset = 0, data = b64("x"), total = 10 * 1024 * 1024 + 1, crc32 = "00000000" })
check("an image over 10 MiB is refused", r.ok == false and r.code == "bad-args", J(r))
r = request("patch.libraryStat", { file = "rainbow.png", kind = "image" })
check("libraryStat reads the image back", r.ok and r.result.exists == true and r.result.size == #PNG and r.result.crc32 == crc32(PNG) and r.result.listedIn[1] == "images", J(r))
r = request("patch.libraryStat", { file = "Acme@Spot.gdtf" })
check("kind defaults to fixture: the user fixture library", r.ok and r.result.path == LIBPATHS[4] .. "/Acme@Spot.gdtf" and r.result.kind == nil, J(r))

-- bitmap.list
r = request("bitmap.list", { bitmap = 1, image = 1 })
check("bitmap.list: empty slots read found false", r.ok and r.result.bitmapFound == false and r.result.imageFound == false and r.result.bitmap == nil, J(r))
local img = addImage(1, "rainbow.png", #PNG)
local bm, cfg = newBitmap(1)
r = request("bitmap.list", { bitmap = 1, image = 1 })
check("bitmap.list: the image entry", r.ok and r.result.imageFound and r.result.image.ref == "3.1" and r.result.image.class == "UserImage" and r.result.image.fileName == "rainbow.png" and r.result.image.fileSize == #PNG .. "B", J(r))
local e = r.ok and r.result.bitmap
check("bitmap.list: the bitmap's config defaults", e and e.no == 1 and #e.configs == 1 and e.configs[1].width == 64 and e.configs[1].controlZoom == 50 and e.configs[1].contentMode == "None" and e.configs[1].content == nil, J(r))
check("bitmap.list: the five default channels with attribute names", e and #e.channels == 5 and e.channels[1].attribute == "Dimmer" and e.channels[1].source == "Intensity" and e.channels[3].attribute == "ColorRGB_R" and e.channels[5].source == "Blue" and e.channels[3].high == 100, J(r))
r = request("bitmap.list", { images = true })
check("bitmap.list without bitmap lists every bitmap and the images", r.ok and #r.result.bitmaps == 1 and #r.result.images == 1, J(r))

-- bitmap.set
r = request("bitmap.set", { bitmap = 2, config = {} })
check("bitmap.set refuses a missing bitmap", r.ok == false and r.code == "no-bitmap", J(r))
r = request("bitmap.set", { bitmap = 1, config = { image = 7 } })
check("bitmap.set refuses a missing image before setting anything", r.ok == false and r.code == "no-image" and cfg.props.content == nil, J(r))
r = request("bitmap.set", { bitmap = 1, config = { width = 40 }, channels = { { attribute = "Pan", source = "Red" } } })
check("an unknown attribute is refused before anything is set", r.ok == false and r.code == "no-attribute" and cfg.props.width == 64, J(r))
r = request("bitmap.set", { bitmap = 1, config = { width = "wide" } })
check("a non-number width is refused", r.ok == false and r.code == "bad-args", J(r))
r = request("bitmap.set", { bitmap = 1, channels = { { attribute = "Dimmer", source = "Loudness" } } })
check("an unknown source is refused", r.ok == false and r.code == "bad-args", J(r))

r = request("bitmap.set", { bitmap = 1, name = "Rainbow", config = { image = 1, width = 40, height = 2, contentMode = "Clip", interpolate = true, alpha = false, controlZoom = 60 } })
e = r.ok and r.result.bitmap
check("bitmap.set: content, size, mode, flags and name read back", e and e.name == "Rainbow" and e.configs[1].content.ref == "3.1" and e.configs[1].content.class == "UserImage" and e.configs[1].width == 40 and e.configs[1].height == 2 and e.configs[1].contentMode == "Clip" and e.configs[1].interpolate == "Yes" and e.configs[1].alpha == "No" and e.configs[1].controlZoom == 60 and #r.result.setErrors == 0, J(r))
check("bitmap.set left the channels alone", e and #e.channels == 5, J(r))

r = request("bitmap.set", { bitmap = 1, channels = { { attribute = "colorrgb_r", source = "Red", low = 0, high = 80 }, { attribute = "Tilt", source = "Intensity", low = 10, high = 90 } } })
e = r.ok and r.result.bitmap
check("bitmap.set: channels replaced (surplus removed), attribute matched ignoring case", e and #e.channels == 2 and e.channels[1].attribute == "ColorRGB_R" and e.channels[1].high == 80 and e.channels[2].attribute == "Tilt" and e.channels[2].source == "Intensity" and e.channels[2].low == 10, J(r))
r = request("bitmap.set", { bitmap = 1, channels = { { attribute = "Dimmer", source = "Intensity" }, { attribute = "ColorRGB_R", source = "Red" }, { attribute = "ColorRGB_G", source = "Green" } } })
e = r.ok and r.result.bitmap
check("bitmap.set: channels grown with Acquire", e and #e.channels == 3 and e.channels[3].attribute == "ColorRGB_G" and e.channels[3].source == "Green", J(r))

bm.refuse.speedmaster = true
r = request("bitmap.set", { bitmap = 1, speedMaster = "Speed 3", config = { height = 4 } })
check("a refused Set is reported in setErrors and the rest still applies", r.ok and #r.result.setErrors == 1 and r.result.setErrors[1].field == "speedMaster" and r.result.bitmap.configs[1].height == 4, J(r))

-- bitmap.imageName
r = request("bitmap.imageName", { image = 1, name = "Rainbow" })
check("bitmap.imageName names the image", r.ok and r.result.image.name == "Rainbow" and img.name == "Rainbow" and r.result.setError == nil, J(r))
r = request("bitmap.imageName", { image = 2, name = "x" })
check("bitmap.imageName refuses a missing image", r.ok == false and r.code == "no-image", J(r))
r = request("bitmap.imageName", { image = 1, name = 'a"b' })
check("bitmap.imageName refuses quotes", r.ok == false and r.code == "bad-args", J(r))

-- Show-object writes go through input admission like cmd and set; reads and file uploads do not.
do
  local savedRunning, savedControl, savedEnabled = state.running, state.modules.control, state.control.enabled
  state.running, state.control.enabled = true, true
  state.modules.control = { instance = { admission = function() return { description = "a surface gesture of conn-9", reason = "gesture", owner = "conn-9" } end } }
  local heightBefore = cfg.props.height
  r = request("bitmap.set", { bitmap = 1, config = { height = 9 } })
  check("bitmap.set is refused as busy while input ownership is active, before any Set", r.ok == false and r.code == "busy" and cfg.props.height == heightBefore, J(r))
  r = request("bitmap.imageName", { image = 1, name = "Other" })
  check("bitmap.imageName is refused as busy too", r.ok == false and r.code == "busy" and img.name == "Rainbow", J(r))
  r = request("bitmap.list", { bitmap = 1 })
  check("bitmap.list stays available", r.ok and r.result.bitmapFound == true, J(r))
  state.running, state.modules.control, state.control.enabled = savedRunning, savedControl, savedEnabled
end

os.execute('rm -rf "' .. LIBDIR .. '"')
print(string.format("%d passed, %d failed", passes, failures))
if failures == 0 then print("ALL PASSED") end
os.exit(failures == 0 and 0 or 1)
