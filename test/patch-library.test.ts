import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { LIBRARY_MAX_CHARS, registerPatchTools } from "../src/tools/patch.js";

/**
 * SU-03 tools (gma3_patch_library, gma3_patch_import, gma3_patch_remove_type) against a fake bridge: the copy
 * opens, an import lands and the copy commits on the next poll (a console frame). The bridge ops are covered by
 * test/lua/patch_ops_test.lua; the console behaviour by docs/probes/su-03-import-macos-2.5.1.md.
 */

interface Ty {
  no: number;
  name: string;
  manufacturer: string;
  guid: string;
  modes: Array<{ no: number; name: string; footprint: number }>;
}

const ty = (no: number, name: string, manufacturer: string, guid: string): Ty => ({ no, name, manufacturer, guid, modes: [{ no: 1, name: "Mode 0", footprint: 8 }] });

class LibraryWorld {
  live: Ty[] = [ty(1, "Mega Hex Par", "ADJ", "G-1"), ty(2, "Spare", "Test", "G-2"), ty(3, "Dimmer", "Generic", "G-3")];
  copy: Ty[] | null = null;
  dest = "Root";
  pending: string[] = [];
  usedBy: Record<string, number[]> = { "G-1": [101, 102] };
  /** Fixtures per type number, as a bridge from 0.42.0 counts them (by type object); overrides usedBy when set. */
  usedByNo: Record<number, number[]> | null = null;
  /** What an import of a file creates: [manufacturer, name], or "error" (the console answers with an error). */
  creates: Record<string, Array<[string, string]> | "error"> = {
    "oppsk@36pcs 4in1 led wall washer.pxml": [["Oppsk", "36PCS 4in1 LED Wall Washer"]],
    "adj@mega hex par.pxml": [["ADJ", "Mega Hex Par"]],
    "solo@user only@rev2.gdtf": [["Solo", "User Only"]],
    "solo@user xml.xml": [["Solo", "User Xml"]],
    "broken@file.pxml": "error",
    "two@types.pxml": [["Two", "One"], ["Two", "Two"]],
    "Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf": [["Chauvet DJ", "Sentinel Spot Q60 ILS"]],
    "other@thing.pxml": [["Else", "Different"]],
  };
  lastCommand = "";
  /** The command form of the bridge: Import <no> /File /Path (0.41.0) or Import Library (older bridges). */
  legacy = false;
  /** A dialog the next import opens instead of importing (the overwrite question). */
  opensDialog = false;
  modal: { name: string; class: string } | false = false;
  attributes = 100;
  attributesBefore = 100;
  library = [
    { source: "grandma2", file: "adj@mega hex par.pxml", format: "pxml", manufacturer: "adj", model: "mega hex par", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "oppsk@36pcs 4in1 led wall washer.pxml", format: "pxml", manufacturer: "oppsk", model: "36pcs 4in1 led wall washer", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "broken@file.pxml", format: "pxml", manufacturer: "broken", model: "file", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "two@types.pxml", format: "pxml", manufacturer: "two", model: "types", modesKnown: false, verified: true, set: false },
    { source: "grandma3", file: "acme@spot.xml", format: "xml", manufacturer: "Acme", model: "spot", name: "Spot", modes: ["Standard"], modesKnown: true, verified: true, set: false },
    { source: "user", file: "acme@spot.xml", format: "xml", manufacturer: "Acme", model: "spot", name: "Spot", modes: ["Standard"], modesKnown: true, verified: false, set: false },
    { source: "user", file: "solo@user only@rev2.gdtf", format: "gdtf", manufacturer: "solo", model: "user only", modesKnown: false, verified: true, set: false },
    { source: "user", file: "Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf", format: "gdtf", manufacturer: "Chauvet_DJ", model: "Sentinel_Spot_Q60_ILS", revision: "2026-10-21", modesKnown: false, verified: true, set: false },
    { source: "grandma2", file: "other@thing.pxml", format: "pxml", manufacturer: "other", model: "thing", modesKnown: false, verified: true, set: false },
    { source: "user", file: "solo@user xml.xml", format: "xml", manufacturer: "Solo", model: "user xml", name: "User Xml", modes: ["Mode 0"], modesKnown: true, verified: false, set: false },
  ];

  inShow(e: { manufacturer?: string; model?: string; name?: string }) {
    const n = (e.name ?? e.model ?? "").toLowerCase();
    return this.live.filter((t) => t.name.toLowerCase() === n && t.manufacturer.toLowerCase() === (e.manufacturer ?? "").toLowerCase()).map((t) => ({ no: t.no, name: t.name, guid: t.guid }));
  }

  frame() {
    for (const cmd of this.pending) {
      if (cmd === "enter") {
        this.copy = this.live.map((t) => ({ ...t }));
        this.dest = "FixtureTypes";
      } else if (cmd === "root") {
        if (this.copy) this.live = this.copy;
        this.copy = null;
        this.dest = "Root";
      } else if (cmd.startsWith("import:")) {
        const [, sent, file] = cmd.split("\n");
        const what = this.creates[file];
        if (this.opensDialog) {
          this.modal = { name: "MsgBox", class: "MessageBox" };
          continue;
        }
        this.lastCommand = sent;
        if (!this.copy || what === "error" || what === undefined) {
          this.lastCommand = `Object not found: ${this.lastCommand}`;
          continue;
        }
        for (const [m, n] of what) this.copy.push(ty(this.copy.length + 1, n, m, `G-new-${n}`));
        this.attributes += 3;
        this.lastCommand = `OK: ${this.lastCommand}`;
      }
    }
    this.pending = [];
  }

  install(h: Harness) {
    const f = h.fake;
    f.on("patch.state", () => {
      this.frame();
      const copyOpen = this.copy !== null;
      return { destination: this.dest, copyOpen, atRoot: this.dest === "Root" && !copyOpen, modal: false, stages: ["Stage 1"] };
    });
    f.on("patch.library", (args) => {
      let rows = this.library;
      if (args.file) rows = rows.filter((e) => e.file === args.file);
      if (Array.isArray(args.sources)) rows = rows.filter((e) => (args.sources as string[]).includes(e.source));
      if (typeof args.query === "string") {
        const words = (args.query as string).toLowerCase().split(/\s+/);
        rows = rows.filter((e) => words.every((w) => `${e.manufacturer} ${e.model} ${e.file}`.toLowerCase().includes(w)));
      }
      const entries = rows.map((e) => ({ ...e, inShow: this.inShow(e) }));
      return { total: entries.length, offset: 0, count: entries.length, entries };
    });
    f.on("patch.enter", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      if (this.copy) throw new BridgeReplyError("[copy-open] open", "copy-open");
      this.pending.push("enter");
      return args.target === "fixturetypes" ? { queued: true, target: "fixturetypes", expectDestination: "FixtureTypes" } : { queued: true, stage: "Stage 1", expectDestination: "FixtureTypes" };
    });
    f.on("patch.import", (args) => {
      if (!this.copy || this.dest !== "FixtureTypes") throw new BridgeReplyError("[wrong-destination] not at FixtureTypes", "wrong-destination");
      const entry = this.library.find((e) => e.file === args.file);
      const command = this.legacy ? `Import Library "${args.file}"` : `Import ${this.copy.length + 1} /File "${args.file}" /Path "/lib/${entry?.source}"`;
      this.pending.push(`import:\n${command}\n${args.file}`);
      this.attributesBefore = this.attributes;
      return { queued: true, command, typesBefore: this.copy.length, attributesBefore: this.attributes };
    });
    f.on("patch.importState", (args) => {
      this.frame();
      if (!this.copy) throw new BridgeReplyError("[copy-closed] not open", "copy-closed");
      const before = args.typesBefore as number;
      return { destination: this.dest, types: this.copy.length, added: this.copy.slice(before), attributes: this.attributes, lastCommand: this.lastCommand, ...(this.legacy ? {} : { modal: this.modal }) };
    });
    f.on("patch.typeInfo", (args) => {
      const t = this.live.find((x) => x.no === args.type || x.name === args.type);
      if (!t) throw new BridgeReplyError(`[no-type] no fixture type ${args.type}`, "no-type");
      const users = this.usedByNo ? this.usedByNo[t.no] ?? [] : this.usedBy[t.guid] ?? [];
      return { type: { ...t, usedBy: users, realUsed: users.length, index: this.live.indexOf(t) + 1 } };
    });
    f.on("patch.removeType", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] not open", "copy-closed");
      const i = this.copy.findIndex((x) => x.no === args.type);
      if (i < 0 || this.copy[i].guid !== args.guid) throw new BridgeReplyError("[guid-mismatch] no", "guid-mismatch");
      const [removed] = this.copy.splice(i, 1);
      const renumbered = this.copy.slice(i).map((x) => ({ name: x.name, from: x.no, to: x.no - 1 }));
      for (const x of this.copy.slice(i)) x.no -= 1;
      return { removed, renumbered, types: this.copy.length };
    });
    f.on("patch.collections", () => ({ copyOpen: this.copy !== null, live: ["AttributeDefinitions", "FixtureTypes"], copy: this.copy ? ["AttributeDefinitions", "FixtureTypes"] : false }));
    f.on("patch.fingerprint", (args) => {
      // FixtureTypes hashed by identity (GUIDs) in order; prefixOfLive limits the copy to the live count,
      // excludeGuids leaves types out of the live side; AttributeDefinitions by count, prefix-limited the same way.
      const side = args.side === "copy" ? this.copy ?? [] : this.live;
      // excludeTypes (bridge 0.42.0) leaves out only the type at that position with that GUID, and replaces excludeGuids.
      const excl = new Set((args.excludeGuids as string[]) ?? []);
      const byPos = args.excludeTypes as Array<{ index: number; guid: string }> | undefined;
      let list = side.filter((x, i) => (byPos ? !byPos.some((e) => e.index === i + 1 && e.guid === x.guid) : !excl.has(x.guid)));
      if (args.prefixOfLive) list = list.slice(0, this.live.length);
      if (args.collection === "FixtureTypes") return { objects: list.length, hash: list.map((x) => x.guid).join(","), complete: true };
      const attrs = args.side === "copy" && !args.prefixOfLive && this.copy ? this.attributes : this.attributesBefore;
      return { objects: attrs, hash: String(attrs), complete: true };
    });
    f.on("patch.commit", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      this.pending.push("root");
      return { queued: true };
    });
    f.on("patch.types", () => ({ count: this.live.length, types: this.live }));
  }
}

async function setup() {
  const h = await startHarness(registerPatchTools);
  const w = new LibraryWorld();
  w.install(h);
  return { h, w, ops: () => h.fake.requests.map((r) => r.op) };
}

const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);

test("gma3_patch_library passes the search through, include_sets as includeSets", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_library", { query: "oppsk wall", sources: ["grandma2"], include_sets: true, limit: 5 });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].file, "oppsk@36pcs 4in1 led wall washer.pxml");
    const req = h.fake.requests.find((r) => r.op === "patch.library")!;
    assert.deepEqual(req.args, { query: "oppsk wall", sources: ["grandma2"], includeSets: true, limit: 5 });
  } finally {
    await h.close();
  }
});

test("gma3_patch_library compact: file names per library, inShow and notVerified only where they apply, 500 by default", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_library", { query: "acme", compact: true });
    assert.equal(result.compact, true);
    assert.deepEqual(result.files, { grandma3: ["acme@spot.xml"], user: ["acme@spot.xml"] });
    assert.deepEqual(result.notVerified, { user: ["acme@spot.xml"] }, "per library: the grandMA3 copy of the same name is verified");
    assert.equal(result.entries, undefined);
    assert.equal(h.fake.requests.find((r) => r.op === "patch.library")!.args.limit, 500);
    assert.equal(h.fake.requests.find((r) => r.op === "patch.library")!.args.headers, false, "compact asks the bridge for no .xml header data");
    const adj = await h.callJson("gma3_patch_library", { query: "mega hex", compact: true });
    assert.deepEqual(adj.result.inShow, { grandma2: { "adj@mega hex par.pxml": [{ no: 1, name: "Mega Hex Par" }] } });
  } finally {
    await h.close();
  }
});

test("gma3_patch_library: a broad page is cut to fit the client, with the offset to ask for next (live 2026-10-22: 95-145 KB)", async () => {
  const { h, w } = await setup();
  for (let i = 0; i < 500; i++) w.library.push({ source: "grandma2", file: `adj@fixture model number ${i}.pxml`, format: "pxml", manufacturer: "adj", model: `fixture model number ${i}`, modesKnown: false, verified: true, set: false });
  try {
    const full = await h.callJson("gma3_patch_library", { query: "adj", limit: 500 });
    assert.ok(full.text.length <= LIBRARY_MAX_CHARS, `${full.text.length} characters`);
    assert.ok(full.result.count < 501 && full.result.count > 50, String(full.result.count));
    assert.equal(full.result.nextOffset, full.result.count);
    assert.match(full.result.truncated, /compact: true/);
    const compact = await h.callJson("gma3_patch_library", { query: "adj", compact: true });
    assert.ok(compact.text.length <= LIBRARY_MAX_CHARS);
    assert.equal(compact.result.count, 501, "file names alone fit");
    assert.equal(compact.result.truncated, undefined);
  } finally {
    await h.close();
  }
});

test("gma3_patch_library: an entry over the budget on its own is listed without its modes and description, and the next page moves on (review of PR #87)", async () => {
  const { h, w } = await setup();
  const modes = Array.from({ length: 3000 }, (_, i) => `Mode number ${i} with a long name`);
  w.library = [
    { source: "user", file: "huge@header.xml", format: "xml", manufacturer: "Huge", model: "header", name: "Header", modes, description: "x".repeat(5000), modesKnown: true, verified: false, set: false } as any,
    { source: "user", file: "huge@second.xml", format: "xml", manufacturer: "Huge", model: "second", name: "Second", modes: ["A"], modesKnown: true, verified: false, set: false },
  ];
  try {
    const { result, text } = await h.callJson("gma3_patch_library", { query: "huge" });
    assert.ok(text.length <= LIBRARY_MAX_CHARS, `${text.length} characters`);
    assert.equal(result.count, 1);
    assert.equal(result.entries[0].file, "huge@header.xml");
    assert.equal(result.entries[0].modes, undefined);
    assert.equal(result.entries[0].description, undefined);
    assert.match(result.entries[0].oversized, /3000/);
    assert.equal(result.nextOffset, 1, "the next page starts after the oversized entry");
    // Still too large without its modes (a long inShow list): a bounded form, with the count of the types left out.
    w.live = Array.from({ length: 400 }, (_, i) => ty(i + 1, `Header ${"y".repeat(150)}`, "Huge", `G-h${i}`));
    w.library[0] = { source: "user", file: "huge@header.xml", format: "xml", manufacturer: "Huge", model: "header", name: `Header ${"y".repeat(150)}`, modes, modesKnown: true, verified: false, set: false };
    w.inShow = () => w.live.map((t) => ({ no: t.no, name: t.name, guid: t.guid }));
    const big = await h.callJson("gma3_patch_library", { query: "huge" });
    assert.ok(big.text.length <= LIBRARY_MAX_CHARS, `${big.text.length} characters`);
    assert.equal(big.result.count, 1);
    assert.equal(big.result.entries[0].inShow.length, 5);
    assert.equal(big.result.entries[0].inShowCount, 400);
    assert.equal(big.result.nextOffset, 1);
    assert.match(big.result.truncated, /offset 1/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: the whole session, committed and read back with the new type's modes", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_import", { file: "oppsk@36pcs 4in1 led wall washer.pxml", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(stepNames(result), ["check_state:succeeded", "check_library:succeeded", "enter:succeeded", "wait_copy:succeeded", "import:succeeded", "wait_import:succeeded", "isolation_check:succeeded", "commit:succeeded", "wait_commit:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.equal(result.type.name, "36PCS 4in1 LED Wall Washer");
    assert.equal(result.type.no, 4);
    assert.equal(result.type.modes[0].footprint, 8);
    assert.equal(result.attributesAdded, 3);
    assert.equal(result.committed, true);
    assert.equal(result.warning, undefined, "a verified library gives no warning");
    const enter = h.fake.requests.find((r) => r.op === "patch.enter")!;
    assert.equal(enter.args.target, "fixturetypes");
    const imp = h.fake.requests.find((r) => r.op === "patch.import")!;
    assert.deepEqual(imp.args, { exclusive: true, file: "oppsk@36pcs 4in1 led wall washer.pxml" });
    const fps = h.fake.requests.filter((r) => r.op === "patch.fingerprint");
    const copyFps = fps.filter((r) => r.args.side === "copy");
    assert.ok(copyFps.every((r) => r.args.prefixOfLive === (r.args.collection === "FixtureTypes" || r.args.collection === "AttributeDefinitions")), "prefixOfLive only where an import appends");
    assert.ok(fps.filter((r) => r.args.side === "live").every((r) => r.args.excludeGuids === undefined));
    assert.equal(w.live.length, 4);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: refused before anything is sent for a duplicate, an ambiguous or an unknown file, or without exclusive", async () => {
  const { h, ops } = await setup();
  try {
    let r = await h.callJson("gma3_patch_import", { file: "adj@mega hex par.pxml", exclusive: true });
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /already has type 1 "Mega Hex Par".*allow_duplicate/);
    assert.ok(!ops().includes("patch.enter"));
    r = await h.callJson("gma3_patch_import", { file: "acme@spot.xml", exclusive: true });
    assert.match(r.result.summary, /more than one library \(grandma3, user\)/);
    r = await h.callJson("gma3_patch_import", { file: "acme@spot.xml", source: "grandma3", exclusive: true });
    assert.match(r.result.summary, /more than one library/, "naming the source does not help: Import Library names the file only");
    r = await h.callJson("gma3_patch_import", { file: "nobody@nothing.pxml", exclusive: true });
    assert.match(r.result.summary, /is not in the fixture-type library/);
    assert.ok(!ops().includes("patch.enter"));
    r = await h.callJson("gma3_patch_import", { file: "x.pxml" });
    assert.match(r.result.validationErrors.join(" "), /exclusive must be true/);
    r = await h.callJson("gma3_patch_import", { file: 'bad"name.pxml', exclusive: true });
    assert.match(r.result.validationErrors.join(" "), /quote/);
    r = await h.callJson("gma3_patch_import", { file: "x.pxml", source: "elsewhere", exclusive: true });
    assert.equal(r.isError, true, "an unknown source is rejected by the input schema");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: allow_duplicate imports a second type with the same name", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "adj@mega hex par.pxml", allow_duplicate: true, exclusive: true });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result, null, 2));
    assert.equal(w.live.filter((t) => t.name === "Mega Hex Par").length, 2);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: an import the console refuses closes the unchanged copy", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "broken@file.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /answered "Object not found: Import 4 \/File "broken@file\.pxml" \/Path "\/lib\/grandma2""/);
    assert.equal(result.copyLeftOpen, false);
    assert.equal(result.committed, false);
    assert.equal(w.copy, null);
    assert.equal(w.live.length, 3);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: an older bridge's Import Library answer is still recognised (bridge 0.41.0 names the command)", async () => {
  const { h, w } = await setup();
  w.legacy = true;
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "broken@file.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /answered "Object not found: Import Library "broken@file\.pxml""/);
    assert.equal(w.copy, null);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a dialog the import opens fails the wait at once and says to cancel it", async () => {
  const { h, w } = await setup();
  w.opensDialog = true;
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "oppsk@36pcs 4in1 led wall washer.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    const step = result.steps.find((s: { name: string }) => s.name === "wait_import");
    assert.equal(step.status, "failed");
    assert.match(step.error, /dialog \(MsgBox\) is open .* Press Cancel there/);
    assert.equal(w.live.length, 3, "nothing was imported");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: two new types are not claimed and the copy is left open", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "two@types.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /2 types appeared instead of one/);
    assert.equal(result.copyLeftOpen, true);
    assert.equal(w.live.length, 3, "nothing was committed");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a file name's underscores match the spaces in the type it creates (live 2026-10-21)", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf", exclusive: true });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result, null, 2));
    assert.equal(w.live.filter((t) => t.name === "Sentinel Spot Q60 ILS").length, 1);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a type matching neither name nor manufacturer is not claimed, and the operator is told how to leave the patch", async () => {
  const { h, w } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "other@thing.pxml", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /matches neither the name nor the manufacturer/);
    assert.equal(result.copyLeftOpen, true);
    assert.match(result.summary, /no Patch window is open/);
    assert.match(result.summary, /type ChangeDestination Root at the console/);
    assert.doesNotMatch(result.summary, /Menu > Patch, then/);
    assert.equal(w.live.length, 3, "nothing was committed");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a user-library .xml imports with a warning, a user-library .gdtf without (SU-22)", async () => {
  const { h } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "solo@user xml.xml", exclusive: true });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result, null, 2));
    assert.equal(result.library.verified, false);
    assert.match(result.warning, /not verified on the console/);
    const gdtf = await h.callJson("gma3_patch_import", { file: "solo@user only@rev2.gdtf", exclusive: true });
    assert.equal(gdtf.result.outcome, "succeeded", JSON.stringify(gdtf.result, null, 2));
    assert.equal(gdtf.result.library.verified, true);
    assert.equal(gdtf.result.warning, undefined);
  } finally {
    await h.close();
  }
});

test("gma3_patch_remove_type: removes an unused type by GUID, reports the renumbering, leaves the live side's type out of the check", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_remove_type", { type: "Spare", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.deepEqual(stepNames(result), ["check_state:succeeded", "check_type:succeeded", "enter:succeeded", "wait_copy:succeeded", "remove_type:succeeded", "isolation_check:succeeded", "commit:succeeded", "wait_commit:succeeded", "read_back:succeeded"]);
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(result.renumbered, [{ name: "Dimmer", from: 3, to: 2 }]);
    assert.match(result.note, /Attributes the type brought into the show stay/);
    const rm = h.fake.requests.find((r) => r.op === "patch.removeType")!;
    assert.deepEqual(rm.args, { exclusive: true, type: 2, guid: "G-2" });
    const fps = h.fake.requests.filter((r) => r.op === "patch.fingerprint" && r.args.side === "live");
    assert.ok(fps.every((r) => JSON.stringify(r.args.excludeGuids) === '["G-2"]'));
    assert.deepEqual(w.live.map((t) => `${t.no}:${t.name}`), ["1:Mega Hex Par", "2:Dimmer"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a rebuilt GDTF imported again (same GUID) is read back by its number, not the older type's GUID (live 2026-10-22)", async () => {
  const { h, w } = await setup();
  // The older import of the same file: the console gives the new one the same GUID.
  w.live.push(ty(4, "Sentinel Spot Q60 ILS", "Chauvet DJ", "G-new-Sentinel Spot Q60 ILS"));
  try {
    const { result, isError } = await h.callJson("gma3_patch_import", { file: "Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf", allow_duplicate: true, exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.equal(result.type.no, 5);
    assert.deepEqual(w.live.filter((t) => t.guid === "G-new-Sentinel Spot Q60 ILS").map((t) => t.no), [4, 5]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import: a type a GDTF already imported is a duplicate even when the bridge's inShow misses the underscores (bridge before 0.38.1)", async () => {
  const { h, w, ops } = await setup();
  // The fake's inShow compares names exactly, like bridge 0.38.0: "180W_Beam" never equals "180W Beam".
  w.library.push({ source: "user", file: "SHEHDS@180W_Beam@2026-10-22.gdtf", format: "gdtf", manufacturer: "SHEHDS", model: "180W_Beam", revision: "2026-10-22", modesKnown: false, verified: true, set: false });
  w.live.push(ty(4, "180W Beam", "SHEHDS", "G-beam"));
  try {
    const { result } = await h.callJson("gma3_patch_import", { file: "SHEHDS@180W_Beam@2026-10-22.gdtf", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /already has type 4 "180W Beam".*allow_duplicate/);
    assert.ok(!ops().includes("patch.enter"));
  } finally {
    await h.close();
  }
});

test("gma3_patch_remove_type: an unused import is removed although a newer import of the same GDTF (same GUID) is in use (live 2026-10-22)", async () => {
  const { h, w } = await setup();
  w.live.push(ty(4, "Spare", "Test", "G-2"));
  w.usedByNo = { 1: [101, 102], 4: [201, 202] };
  try {
    const { result, isError } = await h.callJson("gma3_patch_remove_type", { type: 2, exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    const fps = h.fake.requests.filter((r) => r.op === "patch.fingerprint" && r.args.side === "live");
    assert.ok(fps.every((r) => JSON.stringify(r.args.excludeTypes) === '[{"index":2,"guid":"G-2"}]'));
    assert.deepEqual(w.live.map((t) => `${t.no}:${t.name}:${t.guid}`), ["1:Mega Hex Par:G-1", "2:Dimmer:G-3", "3:Spare:G-2"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_remove_type: a type fixtures use is refused before anything is sent", async () => {
  const { h, ops } = await setup();
  try {
    const { result } = await h.callJson("gma3_patch_remove_type", { type: 1, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /used by 2 fixture\(s\) \(101, 102\)/);
    assert.ok(!ops().includes("patch.enter"));
    const r = await h.callJson("gma3_patch_remove_type", { type: "Spare" });
    assert.match(r.result.validationErrors.join(" "), /exclusive must be true/);
  } finally {
    await h.close();
  }
});
