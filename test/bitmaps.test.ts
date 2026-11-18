import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError, SILENT } from "./helpers/fake-bridge.js";
import { registerBitmapTools, checkImage, compareBitmap, fileSizeMatches, imageFileName, type BitmapEntry } from "../src/tools/bitmaps.js";
import { LIBRARY_ADD_CHUNK } from "../src/tools/patchlibrary.js";

/**
 * #143: gma3_image_add, gma3_build_bitmap and gma3_bitmaps against a fake bridge that models the ops the way the
 * bridge implements them (test/lua/bitmap_ops_test.lua covers the Lua side) and the console the way the probe on
 * onPC 2.5.1.1 saw it (comment on #143): Import Image 3.<n> /File names the image "[<file>_png]", Store Bitmap
 * creates BitmapConfig 1 and five default channels.
 */

const hex = (b: Buffer) => crc32(b).toString(16).padStart(8, "0");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(LIBRARY_ADD_CHUNK + 500, 7)]);

const defaultChannels = () => [
  { index: 1, attribute: "Dimmer", source: "Intensity", low: 0, high: 100 },
  { index: 2, attribute: "Dimmer", source: "Const", low: 0, high: 100 },
  { index: 3, attribute: "ColorRGB_R", source: "Red", low: 0, high: 100 },
  { index: 4, attribute: "ColorRGB_G", source: "Green", low: 0, high: 100 },
  { index: 5, attribute: "ColorRGB_B", source: "Blue", low: 0, high: 100 },
];

class Console {
  folder = new Map<string, Buffer>();
  parts = new Map<string, Buffer>();
  images = new Map<number, { no: number; ref: string; name: string; class: string; fileName: string; fileSize: string }>();
  bitmaps = new Map<number, BitmapEntry>();
  groups = new Set([1]);
  presets = new Set<string>();
  /** Refuse these bitmap.set fields (setErrors). */
  refuse = new Set<string>();
  /** The console ignores width (a read-back mismatch). */
  ignoreWidth = false;
  importFeedback = "OK";
  /** Feedback for Store Bitmap; "none" stores nothing. */
  storeFeedback = "OK";
  storeDoes = true;
  /** Feedback for Group <g> At Bitmap <n> (SILENT: no reply) and for Store Preset. */
  applyFeedback: string | typeof SILENT = "OK";
  presetFeedback = "OK";

  install(h: Harness) {
    h.fake.on("patch.libraryStat", (a) => {
      assert.equal(a.kind, "image");
      const file = String(a.file);
      const b = this.folder.get(file);
      const matches = [...this.folder.keys()].filter((k) => k.toLowerCase() === file.toLowerCase()).map((k) => ({ source: "images", file: k }));
      return { file, kind: "image", path: `/media/images/${file}`, exists: Boolean(b), ...(b ? { size: b.length, crc32: hex(b) } : {}), listedIn: b ? ["images"] : [], matches, maxBytes: 10 * 1024 * 1024 };
    });
    h.fake.on("patch.libraryAdd", (a) => {
      assert.equal(a.kind, "image");
      const file = String(a.file);
      const key = `${file}.${a.upload}`;
      if (a.abort === true) return { aborted: true, removed: this.parts.delete(key), partLeft: false };
      if (this.folder.has(file) && a.replace !== true) throw new BridgeReplyError("[exists] already there", "exists");
      const off = Number(a.offset);
      const part = off === 0 ? Buffer.alloc(0) : this.parts.get(key);
      if (!part || part.length !== off) throw new BridgeReplyError("[bad-offset] wrong offset", "bad-offset");
      const next = Buffer.concat([part, Buffer.from(String(a.data), "base64")]);
      this.parts.set(key, next);
      if (a.final !== true) return { file, received: next.length, total: a.total };
      if (next.length !== a.total || hex(next) !== a.crc32) throw new BridgeReplyError("[crc-mismatch] mismatch", "crc-mismatch");
      this.parts.delete(key);
      const replaced = this.folder.has(file);
      this.folder.set(file, next);
      return { file, kind: "image", path: `/media/images/${file}`, format: "png", size: next.length, crc32: hex(next), replaced };
    });
    h.fake.on("bitmap.list", (a) => {
      const out: Record<string, unknown> = {};
      if (a.bitmap !== undefined) {
        const b = this.bitmaps.get(Number(a.bitmap));
        out.bitmapFound = Boolean(b);
        if (b) out.bitmap = structuredClone(b);
      } else out.bitmaps = [...this.bitmaps.values()];
      if (a.image !== undefined) {
        const i = this.images.get(Number(a.image));
        out.imageFound = Boolean(i);
        if (i) out.image = { ...i };
      }
      if (a.images === true) out.images = [...this.images.values()];
      return out;
    });
    h.fake.on("bitmap.imageName", (a) => {
      const i = this.images.get(Number(a.image));
      if (!i) throw new BridgeReplyError("[no-image] none", "no-image");
      i.name = String(a.name);
      return { image: { ...i } };
    });
    h.fake.on("bitmap.set", (a) => {
      const b = this.bitmaps.get(Number(a.bitmap));
      if (!b) throw new BridgeReplyError("[no-bitmap] none", "no-bitmap");
      const errs: Array<{ field: string; error: string }> = [];
      const cfg = b.configs[0];
      const c = (a.config ?? {}) as Record<string, unknown>;
      if (a.name !== undefined) b.name = String(a.name);
      if (a.speedMaster !== undefined) {
        if (this.refuse.has("speedMaster")) errs.push({ field: "speedMaster", error: "refused" });
        else b.speedMaster = String(a.speedMaster);
      }
      if (c.image !== undefined) {
        const i = this.images.get(Number(c.image));
        if (!i) throw new BridgeReplyError("[no-image] none", "no-image");
        cfg.content = { class: i.class, name: i.name, no: i.no, ref: i.ref };
      }
      for (const k of ["width", "height", "controlX", "controlY", "controlZoom", "controlAspect", "controlRotate"] as const) {
        if (c[k] !== undefined && !(k === "width" && this.ignoreWidth)) (cfg as any)[k] = Number(c[k]);
      }
      if (c.contentMode !== undefined) cfg.contentMode = String(c.contentMode);
      if (c.interpolate !== undefined) cfg.interpolate = c.interpolate ? "Yes" : "No";
      if (c.alpha !== undefined) cfg.alpha = c.alpha ? "Yes" : "No";
      if (Array.isArray(a.channels)) {
        b.channels = (a.channels as Array<Record<string, unknown>>).map((ch, i) => ({ index: i + 1, attribute: String(ch.attribute).replace(/^colorrgb_r$/i, "ColorRGB_R"), source: String(ch.source), low: (ch.low as number) ?? 0, high: (ch.high as number) ?? 100 }));
      }
      return { bitmap: structuredClone(b), setErrors: errs };
    });
    h.fake.on("objects", (a) => {
      const ref = String(a.ref);
      const g = /^Group (\d+)$/.exec(ref);
      if (g) return this.groups.has(Number(g[1])) ? { total: 1, items: [{ name: "Festoon Strands", fields: { Name: "Festoon Strands" } }] } : { total: 0, items: [] };
      const p = /^Preset (\S+)$/.exec(ref);
      if (p) return this.presets.has(p[1]) ? { total: 1, items: [{ name: "Rainbow", fields: { Name: "Rainbow" } }] } : { total: 0, items: [] };
      return { total: 0, items: [] };
    });
    h.fake.on("programmer", () => ({ total: 4, selectionCount: 80, rows: [{ attribute: "ColorRGB_R", absPreset: null }] }));
    h.fake.onCommand((cmd) => {
      let m = /^Import Image 3\.(\d+) \/File "(.+)"$/.exec(cmd);
      if (m) {
        const no = Number(m[1]);
        const bytes = this.folder.get(m[2]);
        if (!bytes || this.images.has(no)) return "Failed";
        if (this.importFeedback === "OK") this.images.set(no, { no, ref: `3.${no}`, name: `[${m[2].replace(".", "_")}]`, class: "UserImage", fileName: m[2], fileSize: `${bytes.length}B` });
        return this.importFeedback;
      }
      m = /^Delete Image 3\.(\d+) \/NoConfirmation$/.exec(cmd);
      if (m) return this.images.delete(Number(m[1])) ? "OK" : "Failed";
      m = /^Store Bitmap (\d+) \/NoConfirmation$/.exec(cmd);
      if (m) {
        const no = Number(m[1]);
        if (!this.storeDoes) return this.storeFeedback;
        this.bitmaps.set(no, { no, name: `Bitmap ${no}`, class: "Bitmap", speedMaster: "None", configs: [{ index: 1, content: null, width: 64, height: 64, contentMode: "None", interpolate: "No", alpha: "No", controlX: 0, controlY: 0, controlZoom: 50, controlAspect: 1, controlRotate: 0 }], channels: defaultChannels() });
        return this.storeFeedback;
      }
      m = /^Delete Bitmap (\d+) \/NoConfirmation$/.exec(cmd);
      if (m) return this.bitmaps.delete(Number(m[1])) ? "OK" : "Failed";
      if (/^Group \d+ At Bitmap \d+$/.test(cmd)) return this.applyFeedback;
      m = /^Store Preset (\S+)( \/Overwrite)? \/NoConfirmation$/.exec(cmd);
      if (m) {
        if (this.presetFeedback !== "OK") return this.presetFeedback;
        this.presets.add(m[1]);
        return "OK";
      }
      return "Syntax Error";
    });
  }
}

async function setup() {
  const h = await startHarness(registerBitmapTools);
  const con = new Console();
  con.install(h);
  return { h, con };
}
const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);
const b64 = PNG.toString("base64");

test("imageFileName, checkImage and fileSizeMatches", () => {
  assert.deepEqual(imageFileName("rainbow.png"), { file: "rainbow.png", format: "png" });
  assert.equal(imageFileName("logo 2.jpeg").format, "jpeg");
  for (const bad of ["x.PNG", "x.gif", "../x.png", "a/b.png", ".x.png", 'a"b.png', "x", ""]) assert.throws(() => imageFileName(bad), undefined, bad);
  checkImage("png", PNG);
  checkImage("jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]));
  assert.throws(() => checkImage("png", Buffer.from([0xff, 0xd8, 0xff, 0xe0])), /JPEG/);
  assert.throws(() => checkImage("jpeg", PNG), /PNG/);
  assert.throws(() => checkImage("png", Buffer.from("hello")), /not a PNG/);
  assert.equal(fileSizeMatches("157B", 157), true);
  assert.equal(fileSizeMatches("157B", 158), false);
  assert.equal(fileSizeMatches("1.2kB", 1229), true); // 1024-based
  assert.equal(fileSizeMatches("1.2 KB", 1200), true); // 1000-based
  assert.equal(fileSizeMatches("1.2kB", 1400), false);
  assert.equal(fileSizeMatches("3MB", 3 * 1024 * 1024), true);
  assert.equal(fileSizeMatches("lots", 1), null);
  assert.equal(fileSizeMatches(undefined, 1), null);
});

test("gma3_image_add: uploads in chunks, imports into Image 3.n, names it, reads it back", async () => {
  const { h, con } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_image_add", { image: 1, file_name: "rainbow.png", content_base64: b64, name: "Rainbow" });
    assert.equal(isError, false, JSON.stringify(result));
    assert.deepEqual(stepNames(result), ["check_content:succeeded", "check_slot:succeeded", "check_folder:succeeded", "write:succeeded", "import:succeeded", "name:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.equal(con.folder.get("rainbow.png")?.equals(PNG), true);
    assert.equal(con.images.get(1)?.name, "Rainbow");
    assert.deepEqual(h.fake.commands, ['Import Image 3.1 /File "rainbow.png"']);
    assert.equal(h.fake.requests.filter((r) => r.op === "patch.libraryAdd").length, 2);
  } finally {
    await h.close();
  }
});

test("gma3_image_add: the same bytes already in the folder are not sent again; a path is read from disk", async () => {
  const { h, con } = await setup();
  const dir = await mkdtemp(join(tmpdir(), "img-"));
  try {
    con.folder.set("rainbow.png", PNG);
    const p = join(dir, "rainbow.png");
    await writeFile(p, PNG);
    const { result, isError } = await h.callJson("gma3_image_add", { image: 2, path: p });
    assert.equal(isError, false, JSON.stringify(result));
    assert.ok(stepNames(result).includes("write:skipped"));
    assert.equal(h.fake.requests.filter((r) => r.op === "patch.libraryAdd").length, 0);
    assert.equal(result.verification.status, "matched");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await h.close();
  }
});

test("gma3_image_add: refused before anything is changed", async () => {
  const { h, con } = await setup();
  try {
    let r = await h.callJson("gma3_image_add", { image: 1, file_name: "rainbow.PNG", content_base64: b64 });
    assert.equal(r.isError, true);
    assert.match(r.result.validationErrors.join(" "), /lower case/);
    r = await h.callJson("gma3_image_add", { image: 1, file_name: "rainbow.jpg", content_base64: b64 });
    assert.match(r.result.steps.at(-1).error, /PNG, but the name ends in \.jpg/);
    con.images.set(1, { no: 1, ref: "3.1", name: "Old", class: "UserImage", fileName: "old.png", fileSize: "10B" });
    r = await h.callJson("gma3_image_add", { image: 1, file_name: "rainbow.png", content_base64: b64 });
    assert.match(r.result.steps.at(-1).error, /Image 3\.1 is taken \(Old/);
    con.folder.set("other.png", Buffer.from("different"));
    r = await h.callJson("gma3_image_add", { image: 2, file_name: "other.png", content_base64: b64 });
    assert.match(r.result.steps.at(-1).error, /already in the images folder with other bytes/);
    r = await h.callJson("gma3_image_add", { image: 2, file_name: "Other.png", content_base64: b64 });
    assert.match(r.result.steps.at(-1).error, /differs only in case from other\.png/);
    assert.deepEqual(h.fake.commands, []);
    assert.equal(h.fake.requests.filter((x) => x.op === "patch.libraryAdd").length, 0);
  } finally {
    await h.close();
  }
});

test("gma3_image_add: overwrite deletes the old image first and warns", async () => {
  const { h, con } = await setup();
  try {
    con.images.set(1, { no: 1, ref: "3.1", name: "Old", class: "UserImage", fileName: "old.png", fileSize: "10B" });
    const { result, isError } = await h.callJson("gma3_image_add", { image: 1, file_name: "rainbow.png", content_base64: b64, overwrite: true });
    assert.equal(isError, false, JSON.stringify(result));
    assert.deepEqual(h.fake.commands, ["Delete Image 3.1 /NoConfirmation", 'Import Image 3.1 /File "rainbow.png"']);
    assert.match(result.warnings.join(" "), /lose it/);
    assert.equal(con.images.get(1)?.fileName, "rainbow.png");
  } finally {
    await h.close();
  }
});

test("gma3_image_add: an import that leaves the slot empty is a mismatch; an old bridge is named", async () => {
  const { h, con } = await setup();
  try {
    con.importFeedback = "OK?";
    let r = await h.callJson("gma3_image_add", { image: 3, file_name: "rainbow.png", content_base64: b64 });
    assert.equal(r.isError, true);
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /empty after the import/);
    h.fake.on("bitmap.list", () => {
      throw new Error("unknown op 'bitmap.list'");
    });
    r = await h.callJson("gma3_image_add", { image: 3, file_name: "rainbow.png", content_base64: b64 });
    assert.match(r.result.steps.at(-1).error, /bridge 0\.57\.0/);
  } finally {
    await h.close();
  }
});

const IMG = { no: 1, ref: "3.1", name: "Rainbow", class: "UserImage", fileName: "rainbow.png", fileSize: "157B" };

test("gma3_build_bitmap: stores, configures and reads back every asked setting", async () => {
  const { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    const args = { bitmap: 5, image: "3.1", name: "Rainbow", width: 40, height: 2, content_mode: "Clip", interpolate: true, control: { zoom: 60 }, channels: [{ attribute: "ColorRGB_R", source: "Red", high: 80 }] };
    const { result, isError } = await h.callJson("gma3_build_bitmap", args);
    assert.equal(isError, false, JSON.stringify(result));
    assert.deepEqual(stepNames(result), ["check:succeeded", "store:succeeded", "configure:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(h.fake.commands, ["Store Bitmap 5 /NoConfirmation"]);
    const set = h.fake.requests.find((r) => r.op === "bitmap.set")!.args as any;
    assert.deepEqual(set.config, { image: 1, width: 40, height: 2, contentMode: "Clip", interpolate: true, controlZoom: 60 });
    assert.equal(con.bitmaps.get(5)?.configs[0].content?.ref, "3.1");
  } finally {
    await h.close();
  }
});

test("gma3_build_bitmap: refused before anything is stored", async () => {
  const { h, con } = await setup();
  try {
    let r = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1 });
    assert.match(r.result.steps.at(-1).error, /Image 3\.1 is empty; import the image first/);
    con.images.set(1, { ...IMG });
    con.bitmaps.set(5, { no: 5, name: "Taken", configs: [], channels: [] });
    r = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1 });
    assert.match(r.result.steps.at(-1).error, /Bitmap 5 is taken \(Taken\)/);
    r = await h.callJson("gma3_build_bitmap", { bitmap: 6, image: 1, apply: { group: 9 } });
    assert.match(r.result.steps.at(-1).error, /Group 9 does not exist/);
    r = await h.callJson("gma3_build_bitmap", { bitmap: 6, image: 1, store: { preset: "4.1" } });
    assert.match(r.result.validationErrors.join(" "), /store needs apply/);
    con.presets.add("4.1");
    r = await h.callJson("gma3_build_bitmap", { bitmap: 6, image: 1, apply: { group: 1 }, store: { preset: "4.1" } });
    assert.match(r.result.steps.at(-1).error, /Preset 4\.1 exists; pass store\.overwrite/);
    r = await h.callJson("gma3_build_bitmap", { bitmap: 6, image: 1, channels: [{ attribute: "Dimmer", source: "Loudness" }] });
    assert.match(r.result.validationErrors.join(" "), /source must be one of/);
    assert.deepEqual(h.fake.commands, []);
  } finally {
    await h.close();
  }
});

test("gma3_build_bitmap: a setting the console ignores is a mismatch; a refused Set fails the configure step", async () => {
  const { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    con.ignoreWidth = true;
    con.refuse.add("speedMaster");
    const { result, isError } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, width: 40, speed_master: "Speed 3" });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /width reads 64, not 40/);
    assert.match(result.verification.detail, /speed master reads None, not Speed 3/);
    assert.equal(result.steps.find((s: any) => s.name === "configure").status, "failed");
  } finally {
    await h.close();
  }
});

test("gma3_build_bitmap: overwrite deletes the old bitmap; apply and store report what they read, unverified", async () => {
  const { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    con.bitmaps.set(5, { no: 5, name: "Old", configs: [], channels: [] });
    con.presets.add("4.1");
    const { result, isError } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, width: 40, height: 2, overwrite: true, apply: { group: 1 }, store: { preset: "4.1", overwrite: true } });
    assert.equal(isError, false, JSON.stringify(result));
    assert.deepEqual(h.fake.commands, ["Delete Bitmap 5 /NoConfirmation", "Store Bitmap 5 /NoConfirmation", "Group 1 At Bitmap 5", "Store Preset 4.1 /Overwrite /NoConfirmation"]);
    const prog = result.steps.find((s: any) => s.name === "read_programmer");
    assert.equal(prog.detail.verification, "unverified");
    assert.equal(prog.detail.selectionCount, 80);
    assert.equal(result.steps.find((s: any) => s.name === "read_store").detail.verification, "unverified");
    assert.match(result.warnings.join(" "), /apply is unverified/);
    assert.match(result.warnings.join(" "), /store is unverified/);
    assert.match(result.summary, /programmer content unverified\).*content unverified\)/);
    assert.equal(result.verification.status, "matched");
    assert.match(result.verification.checked, /apply and store are not part of this check/);
  } finally {
    await h.close();
  }
});

test("compareBitmap: content, channels and name", () => {
  const b: BitmapEntry = { no: 1, name: "X", configs: [{ index: 1, content: { class: "UserImage", no: 2, ref: "3.2" }, width: 40 }], channels: defaultChannels() };
  assert.match(compareBitmap(b, { bitmap: 1, image: 1 }, 1).mismatches.join(";"), /content is UserImage 3\.2, not Image 3\.1/);
  const c = compareBitmap(b, { bitmap: 1, image: 2, name: "Y", channels: [{ attribute: "Tilt", source: "Red" }] }, 2);
  assert.match(c.mismatches.join(";"), /name reads X, not Y/);
  assert.match(c.mismatches.join(";"), /5 channels, not 1/);
  assert.match(c.mismatches.join(";"), /channel 1 attribute reads Dimmer, not Tilt/);
  assert.deepEqual(compareBitmap(undefined, { bitmap: 1, image: 1 }, 1).mismatches, ["the bitmap is missing"]);
});

test("gma3_bitmaps lists bitmaps and images; an old bridge is named", async () => {
  const { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    con.bitmaps.set(5, { no: 5, name: "Rainbow", configs: [], channels: defaultChannels() });
    const r = await h.callJson("gma3_bitmaps", { images: true });
    assert.equal(r.isError, false);
    assert.equal(r.result.bitmaps[0].name, "Rainbow");
    assert.equal(r.result.images[0].ref, "3.1");
    h.fake.on("bitmap.list", () => {
      throw new Error("unknown op 'bitmap.list'");
    });
    const old = await h.call("gma3_bitmaps", {});
    assert.equal(old.isError, true);
    assert.match(old.content[0].text, /bridge 0\.57\.0/);
  } finally {
    await h.close();
  }
});

test("gma3_build_bitmap (#157 review): no apply or store unless the configuration succeeded and read back matched", async () => {
  // A configuration the console ignores (width stays 64).
  let { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    con.ignoreWidth = true;
    const { result, isError } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, width: 40, apply: { group: 1 }, store: { preset: "4.9" } });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.deepEqual(h.fake.commands, ["Store Bitmap 5 /NoConfirmation"]);
    assert.ok(stepNames(result).includes("apply:skipped") && stepNames(result).includes("store_look:skipped"), stepNames(result).join(" "));
    assert.equal(con.presets.has("4.9"), false);
  } finally {
    await h.close();
  }
  // bitmap.set gets no reply (dispatched timeout): read-back shows empty content; nothing is applied or stored.
  ({ h, con } = await setup());
  try {
    con.images.set(1, { ...IMG });
    h.fake.on("bitmap.set", () => SILENT);
    const { result, isError } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, apply: { group: 1 }, store: { preset: "4.9" } });
    assert.equal(isError, true);
    assert.equal(result.steps.find((x: any) => x.name === "configure").status, "unknown");
    assert.deepEqual(h.fake.commands, ["Store Bitmap 5 /NoConfirmation"]);
    assert.ok(stepNames(result).includes("apply:skipped"));
  } finally {
    await h.close();
  }
  // A configure step with setErrors but every asked setting read back: still not applied.
  ({ h, con } = await setup());
  try {
    con.images.set(1, { ...IMG });
    con.refuse.add("speedMaster");
    const { result } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, speed_master: "Speed 3", apply: { group: 1 } });
    assert.equal(result.steps.find((x: any) => x.name === "configure").status, "failed");
    assert.deepEqual(h.fake.commands, ["Store Bitmap 5 /NoConfirmation"]);
  } finally {
    await h.close();
  }
});

test("gma3_build_bitmap (#157 review): an unanswered Store Bitmap is resolved by a read before anything is configured", async () => {
  let { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    con.storeFeedback = "Hmm";
    const { result, isError } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, width: 40 });
    assert.equal(isError, false, JSON.stringify(result));
    assert.deepEqual(stepNames(result).slice(0, 3), ["check:succeeded", "store:succeeded", "resolve_store:succeeded"]);
    assert.match(result.steps[1].detail.unclearFeedback, /Hmm/);
    assert.equal(result.verification.status, "matched");
  } finally {
    await h.close();
  }
  ({ h, con } = await setup());
  try {
    con.images.set(1, { ...IMG });
    con.storeFeedback = "Hmm";
    con.storeDoes = false;
    const { result, isError } = await h.callJson("gma3_build_bitmap", { bitmap: 5, image: 1, width: 40, apply: { group: 1 } });
    assert.equal(isError, true);
    assert.match(result.steps.at(-1).error, /got no clear answer and Bitmap 5 is not there; nothing was configured/);
    assert.equal(h.fake.requests.filter((x) => x.op === "bitmap.set").length, 0);
    assert.deepEqual(h.fake.commands, ["Store Bitmap 5 /NoConfirmation"]);
  } finally {
    await h.close();
  }
});

test("gma3_build_bitmap (#157 late finding): the summary says what apply and store actually did", async () => {
  const args = { bitmap: 5, image: 1, width: 40, apply: { group: 1 }, store: { preset: "4.9" } };
  // Apply refused: no store is attempted, and the summary says so.
  let { h, con } = await setup();
  try {
    con.images.set(1, { ...IMG });
    con.applyFeedback = "Syntax Error";
    const { result } = await h.callJson("gma3_build_bitmap", args);
    assert.deepEqual(h.fake.commands, ["Store Bitmap 5 /NoConfirmation", "Group 1 At Bitmap 5"]);
    assert.ok(stepNames(result).includes("apply:failed") && stepNames(result).includes("store_look:skipped"), stepNames(result).join(" "));
    assert.match(result.summary, /applying to Group 1 FAILED/);
    assert.match(result.summary, /not stored into Preset 4\.9 \(skipped: the apply step was failed/);
    assert.doesNotMatch(result.summary, /applied to Group 1 \(|stored into Preset 4\.9 \(command/);
    assert.equal(con.presets.has("4.9"), false);
  } finally {
    await h.close();
  }
  // Apply timed out (no reply): unknown, no store.
  ({ h, con } = await setup());
  try {
    con.images.set(1, { ...IMG });
    con.applyFeedback = SILENT;
    const { result } = await h.callJson("gma3_build_bitmap", args);
    assert.ok(stepNames(result).includes("apply:unknown") && stepNames(result).includes("store_look:skipped"), stepNames(result).join(" "));
    assert.match(result.summary, /applying to Group 1 got no clear answer/);
    assert.match(result.summary, /not stored into Preset 4\.9/);
    assert.equal(h.fake.commands.some((c) => c.startsWith("Store Preset")), false);
  } finally {
    await h.close();
  }
  // Store refused: applied, but the summary says the store failed and no "store is unverified" warning is given.
  ({ h, con } = await setup());
  try {
    con.images.set(1, { ...IMG });
    con.presetFeedback = "Error #72: Command not executed";
    const { result } = await h.callJson("gma3_build_bitmap", args);
    assert.ok(stepNames(result).includes("store_look:failed"), stepNames(result).join(" "));
    assert.match(result.summary, /applied to Group 1 \(command accepted; programmer content unverified\)/);
    assert.match(result.summary, /storing into Preset 4\.9 FAILED/);
    assert.doesNotMatch(result.warnings.join(" "), /store is unverified/);
  } finally {
    await h.close();
  }
  // Both accepted: the summary says sent, content unverified.
  ({ h, con } = await setup());
  try {
    con.images.set(1, { ...IMG });
    const { result } = await h.callJson("gma3_build_bitmap", args);
    assert.match(result.summary, /applied to Group 1 \(command accepted; programmer content unverified\); stored into Preset 4\.9 \(command accepted, Preset 4\.9 exists; content unverified\)\./);
  } finally {
    await h.close();
  }
});
