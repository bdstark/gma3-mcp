import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { registerPatchTools } from "../src/tools/patch.js";
import { LIBRARY_ADD_CHUNK, checkContent, decodeBase64, libraryFileName, parseXml } from "../src/tools/patchlibrary.js";

/**
 * SU-22: gma3_patch_library_add against a fake bridge that models patch.libraryStat / patch.libraryAdd the way the
 * bridge implements them (test/lua/library_add_test.lua covers the Lua side): chunks append to a part file at their
 * offset, the final chunk checks size and CRC-32 and moves the file into place.
 */

/** A minimal zip writer (stored or deflated entries), so the tests build their own GDTF files. */
function zip(entries: Array<[string, string | Buffer, boolean?]>, comment = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content, store] of entries) {
    const data = Buffer.from(content);
    const comp = store ? data : deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

const DESCRIPTION = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<GDTF DataVersion="1.2">
  <FixtureType Name="180W Beam" ShortName="180W Beam" Manufacturer="SHEHDS" Description="a &amp; b">
    <DMXModes>
      <DMXMode Name="15 Channel" Geometry="Base">
      </DMXMode>
    </DMXModes>
  </FixtureType>
</GDTF>
`;
const FILE = "SHEHDS@180W_Beam@2026-10-20.gdtf";
// Incompressible padding, so the file spans several chunks.
const noise = Buffer.alloc(LIBRARY_ADD_CHUNK * 2 + 123);
for (let i = 0, x = 7; i < noise.length; i++) noise[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
const GDTF = zip([["description.xml", DESCRIPTION], ["wheels/noise.png", noise, true]]);
const hex = (b: Buffer) => crc32(b).toString(16).padStart(8, "0");

class Library {
  user = new Map<string, Buffer>();
  parts = new Map<string, Buffer>();
  other: Record<string, string> = { "acme@spot.xml": "grandma3" };
  /** Corrupt the stored bytes after the move (a read-back mismatch). */
  corrupt = false;

  install(h: Harness) {
    h.fake.on("patch.libraryStat", (a) => {
      const file = String(a.file);
      const b = this.user.get(file);
      const listedIn = [...(b ? ["user"] : []), ...(this.other[file] ? [this.other[file]] : [])];
      const lower = file.toLowerCase();
      const matches = [
        ...[...this.user.keys()].filter((k) => k.toLowerCase() === lower).map((k) => ({ source: "user", file: k })),
        ...Object.entries(this.other).filter(([k]) => k.toLowerCase() === lower).map(([k, source]) => ({ source, file: k })),
      ];
      return { file, path: `/lib/${file}`, exists: Boolean(b), ...(b ? { size: b.length, crc32: hex(b) } : {}), listedIn, matches, maxBytes: 8 * 1024 * 1024 };
    });
    h.fake.on("patch.library", (a) => {
      const file = String(a.file);
      const b = this.user.get(file);
      if (!b) return { total: 0, entries: [] };
      const [man, model] = file.replace(/\.\w+$/, "").split("@");
      return { total: 1, entries: [{ source: "user", file, format: "gdtf", manufacturer: man, model, modesKnown: false, verified: false, set: false, inShow: [] }] };
    });
    h.fake.on("patch.libraryAdd", (a) => {
      const file = String(a.file);
      assert.match(String(a.upload), /^[0-9a-f]{16}$/);
      const key = `${file}.${a.upload}`;
      if (a.abort === true) {
        const had = this.parts.delete(key);
        return { aborted: true, removed: had, partLeft: false };
      }
      if (this.user.has(file) && a.replace !== true) throw new BridgeReplyError("[exists] already there", "exists");
      const off = Number(a.offset);
      const piece = Buffer.from(String(a.data), "base64");
      const part = off === 0 ? Buffer.alloc(0) : this.parts.get(key);
      if (!part || part.length !== off) {
        this.parts.delete(key);
        throw new BridgeReplyError("[bad-offset] wrong offset", "bad-offset");
      }
      const next = Buffer.concat([part, piece]);
      this.parts.set(key, next);
      if (a.final !== true) return { file, received: next.length, total: a.total };
      if (next.length !== a.total || hex(next) !== a.crc32) {
        this.parts.delete(key);
        throw new BridgeReplyError("[crc-mismatch] mismatch", "crc-mismatch");
      }
      const replaced = this.user.has(file);
      this.parts.delete(key);
      this.user.set(file, this.corrupt ? Buffer.concat([next, Buffer.from("x")]) : next);
      return { file, path: `/lib/${file}`, format: "gdtf", size: next.length, crc32: hex(next), replaced };
    });
  }
}

async function setup() {
  const h = await startHarness(registerPatchTools);
  const lib = new Library();
  lib.install(h);
  return { h, lib };
}
const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);

test("libraryFileName: manufacturer@model[@revision].gdtf|.xml only", () => {
  assert.deepEqual(libraryFileName(FILE), { file: FILE, format: "gdtf", manufacturer: "SHEHDS", model: "180W_Beam", revision: "2026-10-20" });
  assert.equal(libraryFileName("Acme@Spot.xml").format, "xml");
  for (const bad of ["Acme@Spot:revision.xml", "Acme@Spot<1>.gdtf", "Acme@Spot|2.gdtf", "Acme@Spot?.gdtf", "Acme@Spot*.gdtf", "Acme@Spot.XML", "Acme@Spot.Gdtf", "../x@y.gdtf", "a/b@c.gdtf", "a\\b@c.gdtf", "nomanufacturer.gdtf", "a@b.txt", "a@b@c@d.gdtf", ".a@b.gdtf", 'a@"b".gdtf', "a@ b.gdtf", "a@@b.gdtf", "a@b\n.gdtf", ""]) {
    assert.throws(() => libraryFileName(bad), undefined, bad);
  }
});

test("decodeBase64 is strict, checkContent reads a GDTF's description.xml", () => {
  assert.deepEqual(decodeBase64("aGk=\n"), Buffer.from("hi"));
  for (const bad of ["aGk", "a$k=", "aG=k"]) assert.throws(() => decodeBase64(bad), /not valid base64/, bad);
  const h = checkContent("gdtf", GDTF);
  assert.deepEqual({ ...h }, { manufacturer: "SHEHDS", name: "180W Beam", shortName: "180W Beam", modes: ["15 Channel"], dataVersion: "1.2", files: 2 });
  assert.throws(() => checkContent("gdtf", Buffer.from("not a zip at all, just text")), /not a zip/);
  // A zip comment holding the end-record signature and 22+ more bytes is not taken for the record (review of PR #84).
  const decoy = Buffer.concat([Buffer.from("x PK\u0005\u0006"), Buffer.alloc(30, 0x41)]);
  assert.equal(checkContent("gdtf", zip([["description.xml", DESCRIPTION]], decoy)).name, "180W Beam");
  assert.throws(() => checkContent("gdtf", zip([["other.xml", DESCRIPTION]])), /no description\.xml/);
  assert.throws(() => checkContent("gdtf", zip([["description.xml", "<GDTF DataVersion=\"1.2\"></GDTF>"]])), /no FixtureType/);
  const damaged = Buffer.from(GDTF);
  damaged[50] ^= 0xff; // inside the deflated description.xml
  assert.throws(() => checkContent("gdtf", damaged), /cannot be inflated|CRC/);
  assert.equal(checkContent("xml", Buffer.from('<?xml version="1.0"?><GMA3 DataVersion="1.5"><FixtureType Name="Spot" Manufacturer="Acme"><DMXMode Name="Std"/></FixtureType></GMA3>')).name, "Spot");
  assert.throws(() => checkContent("xml", Buffer.from("PK\u0003\u0004")), /not well-formed XML/);
});

test("checkContent parses the XML: comments, quotes, entities and well-formedness (review of PR #84)", () => {
  const xml = (body: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
  // A FixtureType inside a comment (or CDATA) is not an element.
  assert.throws(() => checkContent("xml", xml('<GMA3><!-- <FixtureType Name="Spot"> --></GMA3>')), /no FixtureType element under <GMA3>/);
  assert.throws(() => checkContent("xml", xml('<GMA3><x><![CDATA[<FixtureType Name="Spot">]]></x></GMA3>')), /no FixtureType element/);
  // Single-quoted attributes and entities are read.
  const h = checkContent("xml", xml(`<GMA3 DataVersion='1.5'><FixtureType Name='Spot &amp; Co' Manufacturer="A&#39;s"><DMXModes><DMXMode Name='Std &lt;8&gt;'/></DMXModes></FixtureType></GMA3>`));
  assert.deepEqual({ ...h }, { manufacturer: "A's", name: "Spot & Co", shortName: undefined, modes: ["Std <8>"], dataVersion: "1.5" });
  // Not well-formed, or not the expected document.
  for (const [bad, why] of [
    ['<GMA3><FixtureType Name="Spot"></GMA3>', /<\/GMA3> closing <FixtureType>/],
    ['<GMA3><FixtureType Name="Spot">', /is not closed/],
    ['<GMA3><FixtureType Name="Spot" Name="Two"/></GMA3>', /twice/],
    ['<GMA3><FixtureType Name=Spot/></GMA3>', /malformed attribute/],
    ['<GMA3><FixtureType Name="a & b"/></GMA3>', /bare &/],
    ['<GMA3><FixtureType Name="&ent;"/></GMA3>', /undefined entity/],
    ['<GMA3><FixtureType Name="&toString;"/></GMA3>', /undefined entity/],
    ['<GMA3><FixtureType Name="Spot&#xD800;"/></GMA3>', /character XML does not allow/],
    ['<GMA3><FixtureType Name="Spot&#1;"/></GMA3>', /character XML does not allow/],
    ['<GMA3><FixtureType Name="Spot&#xFFFE;"/></GMA3>', /character XML does not allow/],
    ['<GMA3><FixtureType Name="Spot"/>]]></GMA3>', /\]\]> outside a CDATA section/],
    ['<GMA3><!--x---><FixtureType Name="Spot"/></GMA3>', /comment ending in -/],
    ['\u00A0<GMA3><FixtureType Name="Spot"/></GMA3>', /text outside the root element/],
    ['<GMA3><FixtureType\u00A0Name="Spot"/></GMA3>', /malformed attribute/],
    ['<GMA3><FixtureType Name="Spot"\u00A0/></GMA3>', /malformed attribute/],
    ['<GMA3><FixtureType Name="Spot"/></GMA3\u00A0>', /malformed end tag/],
    ['<GMA3><FixtureType Name="Spot"/><? x?></GMA3>', /without a target name/],
    ['<GMA3><FixtureType Name="Spot"/><?XML x?></GMA3>', /not at the start/],
    ['<GMA3><FixtureType Name="Spot\u0001"/></GMA3>', /U\+0001/],
    ['<GMA3><FixtureType Name="&__proto__;"/></GMA3>', /undefined entity/],
    ['<GMA3><FixtureType Name="&constructor;"/></GMA3>', /undefined entity/],
    ['<GMA3><FixtureType __proto__="x" __proto__="y" Name="S"/></GMA3>', /twice/],
    ['<!DOCTYPE GMA3 [<!ENTITY x SYSTEM "file:///etc/passwd">]><GMA3><FixtureType Name="&x;"/></GMA3>', /DOCTYPE/],
    ['<GMA3><FixtureType Name="Spot"/></GMA3><GMA3/>', /second root/],
    ['<GMA3><Other><FixtureType Name="Spot"/></Other></GMA3>', /no FixtureType element under <GMA3>/],
    ['<GDTF><FixtureType Name="Spot"/></GDTF>', /root element is <GDTF>, not <GMA3>/],
    ['<GMA3><FixtureType Manufacturer="A"/></GMA3>', /has no Name/],
  ] as const) {
    assert.throws(() => checkContent("xml", xml(bad)), why, bad);
  }
  assert.throws(() => checkContent("gdtf", zip([["description.xml", '<GDTF><FixtureType Name="x"></GDTF>']])), /its description\.xml: it is not well-formed XML/);
  // The XML declaration: malformed, another encoding, or not at the start is refused; a valid one and other PIs pass.
  for (const [decl, why] of [
    ["<?xml garbage?>", /malformed XML declaration/],
    ["<?xml?>", /malformed XML declaration/],
    ['<?xml version="2.0"?>', /malformed XML declaration/],
    ['<?xml encoding="UTF-8" version="1.0"?>', /malformed XML declaration/],
    ['<?XML version="1.0"?>', /malformed XML declaration/],
    ['<?xml version="1.0" encoding="ISO-8859-1"?>', /encoding ISO-8859-1/],
    [' <?xml version="1.0"?>', /not at the start/],
  ] as const) {
    assert.throws(() => checkContent("xml", Buffer.from(`${decl}<GMA3><FixtureType Name="Spot"/></GMA3>`)), why, decl);
  }
  assert.equal(checkContent("xml", Buffer.from(`<?xml version='1.0' encoding='utf-8' standalone="no" ?><?ma3 hint x?><GMA3><FixtureType Name="Spot"/></GMA3>`)).name, "Spot");
  // References decode in one pass, as the bridge's header reader does: &#38;amp; is "&amp;".
  assert.equal(checkContent("xml", xml('<GMA3><FixtureType Name="Spot &#38;amp; Co &amp;lt;x&#x3E;"/></GMA3>')).name, "Spot &amp; Co &lt;x>");
  // An unpaired surrogate cannot come out of strict UTF-8 decoding, but parseXml refuses it in a string too.
  assert.throws(() => parseXml('<GMA3><FixtureType Name="Spot\uD800"/></GMA3>'), /U\+D800/);
  // Allowed: tab, newline, CR, astral characters (a valid surrogate pair) and their references.
  assert.equal(checkContent("xml", xml('<GMA3>\t\r\n<FixtureType Name="Spot &#x1F4A1; \u{1F4A1} &#9;"/></GMA3>')).name, "Spot \u{1F4A1} \u{1F4A1} \t");
  assert.throws(() => checkContent("xml", Buffer.concat([xml('<GMA3><FixtureType Name="'), Buffer.from([0xff, 0xfe]), Buffer.from('"/></GMA3>')])), /not valid UTF-8/);
  assert.throws(() => checkContent("gdtf", zip([["description.xml", '<GDTF><!-- <FixtureType Name="x"/> --></GDTF>']])), /its description\.xml: it has no FixtureType/);
});

test("gma3_patch_library_add: a GDTF in three chunks, moved into place and read back", async () => {
  const { h, lib } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: GDTF.toString("base64") });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.deepEqual(stepNames(result), ["check_content:succeeded", "check_library:succeeded", "write:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(result.verification.actual, { size: GDTF.length, crc32: hex(GDTF), source: "user" });
    assert.deepEqual(lib.user.get(FILE), GDTF);
    assert.equal(lib.parts.size, 0);
    const adds = h.fake.requests.filter((r) => r.op === "patch.libraryAdd");
    assert.equal(adds.length, Math.ceil(GDTF.length / LIBRARY_ADD_CHUNK));
    assert.ok(adds.length >= 3);
    assert.deepEqual(adds.map((r) => r.args.offset), adds.map((_, i) => i * LIBRARY_ADD_CHUNK));
    assert.deepEqual(adds.map((r) => r.args.final), adds.map((_, i) => i === adds.length - 1));
    assert.equal(new Set(adds.map((r) => r.args.upload)).size, 1, "one upload id for every chunk");
    assert.ok(adds.every((r) => String(r.args.data).length <= (LIBRARY_ADD_CHUNK / 3) * 4));
    assert.equal(result.fixtureType.name, "180W Beam");
    assert.deepEqual(result.fixtureType.modes, ["15 Channel"]);
    assert.deepEqual(result.next, { tool: "gma3_patch_import", args: { file: FILE, source: "user", exclusive: true } });
    assert.equal(result.warnings, undefined, "the manufacturer matches the file name: no claim warning");
    assert.match(result.summary, /Wrote SHEHDS@180W_Beam@2026-10-20\.gdtf to the user library/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_library_add: path reads a file on the server's host, file_name defaults to its name", async () => {
  const { h, lib } = await setup();
  const dir = await mkdtemp(join(tmpdir(), "su22-"));
  try {
    const p = join(dir, FILE);
    await writeFile(p, GDTF);
    const { result, isError } = await h.callJson("gma3_patch_library_add", { path: p });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.steps[0].name, "read_file");
    assert.deepEqual(lib.user.get(FILE), GDTF);
    const missing = await h.callJson("gma3_patch_library_add", { path: join(dir, "Nope@Nothing.gdtf") });
    assert.equal(missing.isError, true);
    assert.match(missing.result.steps[0].error, /cannot be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await h.close();
  }
});

test("gma3_patch_library_add: refused before anything is written", async () => {
  const { h, lib } = await setup();
  try {
    const b64 = GDTF.toString("base64");
    let r = await h.callJson("gma3_patch_library_add", { file_name: "bad name.gdtf", content_base64: b64 });
    assert.match(r.result.summary, /manufacturer@model/);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE });
    assert.match(r.result.summary, /exactly one of content_base64/);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: b64, path: "/x" });
    assert.match(r.result.summary, /exactly one of content_base64/);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: "not base64!" });
    assert.match(r.result.summary, /not valid base64/);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: Buffer.from("plain text").toString("base64") });
    assert.match(r.result.steps[0].error, /not a usable GDTF file: it is not a zip/);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: "" });
    assert.match(r.result.steps[0].error, /empty/);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: "A".repeat(12 * 1024 * 1024) });
    assert.match(r.result.summary, /larger than 8388608 bytes/);
    // An 8 MiB file in base64 wrapped at 76 columns is within the cap: whitespace is not counted (review of PR #84).
    const wrapped = (Buffer.alloc(8 * 1024 * 1024, 0x50).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: wrapped });
    assert.doesNotMatch(r.result.summary, /larger than/);
    assert.match(r.result.steps[0].error, /not a usable GDTF file/);
    r = await h.callJson("gma3_patch_library_add", { file_name: "acme@spot.xml", content_base64: Buffer.from('<?xml version="1.0"?><GMA3><FixtureType Name="Spot" Manufacturer="Acme"></FixtureType></GMA3>').toString("base64") });
    assert.match(r.result.steps.at(-1).error, /already in the grandma3 library/);
    r = await h.callJson("gma3_patch_library_add", { file_name: "Acme@Spot.xml", content_base64: Buffer.from('<?xml version="1.0"?><GMA3><FixtureType Name="Spot" Manufacturer="Acme"></FixtureType></GMA3>').toString("base64") });
    assert.match(r.result.steps.at(-1).error, /differs only in case from acme@spot\.xml \(grandma3\)/);
    r = await h.callJson("gma3_patch_library_add", { file_name: "Acme@Inherited.xml", content_base64: Buffer.from('<GMA3><FixtureType Name="&toString;" Manufacturer="Acme"/></GMA3>').toString("base64") });
    assert.match(r.result.steps[0].error, /undefined entity/);
    assert.equal(h.fake.requests.filter((x) => x.op === "patch.libraryAdd").length, 0);
    assert.equal(lib.user.size, 0);
  } finally {
    await h.close();
  }
});

test("gma3_patch_library_add: an existing file is refused unless replace", async () => {
  const { h, lib } = await setup();
  try {
    lib.user.set(FILE, GDTF);
    let r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: GDTF.toString("base64") });
    assert.equal(r.isError, true);
    assert.match(r.result.steps.at(-1).error, /already in the user library .*the same bytes.*replace: true/);
    assert.equal(h.fake.requests.filter((x) => x.op === "patch.libraryAdd").length, 0);
    const other = zip([["description.xml", DESCRIPTION.replace("15 Channel", "16 Channel")]]);
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: other.toString("base64"), replace: true });
    assert.equal(r.isError, false, JSON.stringify(r.result, null, 2));
    assert.equal(r.result.replaced, true);
    assert.deepEqual(lib.user.get(FILE), other);
  } finally {
    await h.close();
  }
});

test("gma3_patch_library_add: a refused chunk is cleaned up; a read-back mismatch is reported", async () => {
  const { h, lib } = await setup();
  try {
    h.fake.on("patch.libraryAdd", (a) => {
      if (a.abort === true) return { aborted: true, removed: false, partLeft: false };
      throw new BridgeReplyError("[write-failed] disk full", "write-failed");
    });
    let r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: GDTF.toString("base64") });
    assert.equal(r.isError, true);
    assert.deepEqual(stepNames(r.result), ["check_content:succeeded", "check_library:succeeded", "write:failed", "clean_up:succeeded"]);
    assert.equal(r.result.verification.status, "unavailable");

    lib.install(h);
    lib.corrupt = true;
    r = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: GDTF.toString("base64") });
    assert.equal(r.isError, true);
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /differs from the bytes sent/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_library_add: a type whose name and manufacturer differ from the file name is warned about", async () => {
  const { h } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_library_add", { file_name: "Other@Name.gdtf", content_base64: GDTF.toString("base64") });
    assert.equal(isError, false);
    assert.match(result.warnings[0], /gma3_patch_import claims a new type only when its name or manufacturer matches/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_library_add: an older bridge is named", async () => {
  const h = await startHarness(registerPatchTools);
  try {
    const { result } = await h.callJson("gma3_patch_library_add", { file_name: FILE, content_base64: GDTF.toString("base64") });
    assert.match(result.steps.at(-1).error, /bridge 0\.38\.0|unknown op/);
  } finally {
    await h.close();
  }
});
