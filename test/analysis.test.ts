import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { BridgeReplyError } from "./helpers/fake-bridge.ts";
import { foldLeaks, isSet, parsePresetRef, registerAnalysisTools, renderLines, type CueRead } from "../src/tools/analysis.ts";

/**
 * gma3_preset_usage, gma3_cue_diff and gma3_tracking_leaks against a fake bridge that answers the read ops the
 * plugin has: children (paged like listChildren), cueContents (by ref), preset.read (a preset or a cue part, rows as
 * presetRow builds them) and ping. Every test also checks that nothing but those reads was sent.
 */

type Row = Record<string, unknown>;
type Ref = { valid: boolean; addr?: string; addrNative?: string; name?: string; no?: number; pool?: number };

interface FakePart {
  part: number;
  own?: boolean | null;
  rows?: Row[];
  recipes?: Row[];
  timing?: Row;
  fail?: string;
  truncated?: boolean;
  noTable?: boolean;
}
interface FakeCue {
  no: number;
  name?: string;
  props?: Row;
  parts: FakePart[];
  fail?: string;
}
interface FakeSeq {
  no: number;
  name: string;
  tracking?: string;
  cues: FakeCue[];
}

const READ_OPS = new Set(["ping", "children", "cueContents", "preset.read"]);

const presetRef = (pool: number, no: number, name: string): Ref => ({ valid: true, addr: `14.14.1.4.${pool}.${no}`, addrNative: `ShowData.DataPools.Default.PresetPools.${pool}.${no}`, name, pool, no });
const RED = presetRef(4, 12, "Red");
const BLUE = presetRef(4, 13, "Blue");
const DELETED: Ref = { valid: false };
const row = (fixture: string, attribute: string, value: number, extra: Row = {}): Row => ({ fixture, attribute, value, stepCount: 1, ...extra });

class FakeShow {
  sequences: FakeSeq[] = [];
  presets = new Map<string, { addr: string; addrNative: string; name: string; referencedBy?: number }>();
  bridgeVersion = "0.51.0";
  /** Executors per page: [executor no, assigned sequence no]. */
  pages: Array<{ no: number; execs: Array<[number, number]> }> = [];
  failSequenceListing?: string;
  failPages?: string;

  seqAddr = (n: number) => `14.14.1.7.${n}`;

  install(h: Harness): void {
    h.fake.on("ping", () => ({ bridgeVersion: this.bridgeVersion }));
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 200);
      let kids: Row[];
      if (ref === "DataPool.Sequences") {
        if (this.failSequenceListing) throw new Error(this.failSequenceListing);
        kids = this.sequences.map((s) => ({ name: s.name, class: "Sequence", addr: this.seqAddr(s.no), index: s.no }));
      } else if (ref === "DataPool.Pages") {
        if (this.failPages) throw new Error(this.failPages);
        kids = this.pages.map((p) => ({ name: `Page ${p.no}`, class: "Page", addr: `page${p.no}`, index: p.no, fields: { No: p.no } }));
      } else if (/^page\d+$/.test(ref)) {
        const p = this.pages.find((x) => `page${x.no}` === ref)!;
        kids = p.execs.map(([e, s]) => ({ name: `Exec ${e}`, class: "Exec", index: e % 100, fields: { No: e, Object: { class: "Sequence", addr: this.seqAddr(s), name: `Seq ${s}` } } }));
      } else {
        const m = ref.match(/^Sequence (\d+)$/);
        const s = m && this.sequences.find((x) => x.no === Number(m[1]));
        if (!s) throw new Error(`no object found for '${ref}'`);
        kids = [
          { name: "OffCue", class: "Cue", index: 1, fields: { No: null } },
          { name: "CueZero", class: "Cue", index: 2, fields: { No: 0 } },
          ...s.cues.map((c, i) => ({ name: c.name ?? `Cue ${c.no}`, class: "Cue", index: i + 3, fields: { No: Math.round(c.no * 1000) } })),
        ];
      }
      const items = kids.slice(offset, offset + limit);
      return { total: kids.length, offset, count: items.length, items };
    });
    h.fake.on("cueContents", (args) => {
      const { seq, cue } = this.cueOf(String(args.ref));
      if (cue.fail) throw new Error(cue.fail);
      return {
        ref: args.ref,
        sequence: { name: seq.name, tracking: seq.tracking ?? "Yes", priority: "Normal" },
        cue: { no: String(cue.no), name: cue.name ?? `Cue ${cue.no}`, trigType: "Go", release: "No", break: "", ...(cue.props ?? {}), partCount: cue.parts.length },
        parts: cue.parts.map((p) => ({
          part: p.part,
          name: `Part ${p.part}`,
          timing: { cueFade: "2.00", cueDelay: "0.00", trackingDistance: "", ...(p.timing ?? {}) },
          command: { text: "", delay: "0.00", enabled: true },
          mib: { mode: "Disabled" },
          ...(p.own === null ? {} : { ownDataPresent: p.own ?? (p.rows ?? []).length > 0 }),
          recipes: p.recipes ?? [],
          otherChildren: [],
        })),
        limitations: [],
      };
    });
    h.fake.on("preset.read", (args) => {
      const ref = String(args.ref);
      const pm = ref.match(/^Preset (\d+)\.(\d+)$/);
      if (pm) {
        const p = this.presets.get(`${pm[1]}.${pm[2]}`);
        if (!p) throw new Error(`no object found for '${ref}'`);
        return { ref, class: "Preset", ...p, rows: [], dependencies: [] };
      }
      const m = ref.match(/^(?:DataPool \d+ )?(Sequence \d+ Cue [\d.]+) Part (\d+)$/);
      if (!m) throw new Error(`unexpected preset.read ref ${ref}`);
      const { cue } = this.cueOf(m[1]);
      const part = cue.parts.find((p) => p.part === Number(m[2]))!;
      if (part.fail) throw new BridgeReplyError(part.fail);
      return { ref, class: "Part", rows: part.rows ?? [], dependencies: [], byFixtures: !part.noTable, truncated: part.truncated === true, count: (part.rows ?? []).length };
    });
  }

  cueOf(ref: string): { seq: FakeSeq; cue: FakeCue } {
    ref = ref.replace(/^DataPool \d+ /, "");
    const m = ref.match(/^Sequence (\d+) Cue ([\d.]+)$/);
    const seq = m && this.sequences.find((s) => s.no === Number(m[1]));
    const cue = seq && seq.cues.find((c) => Math.abs(c.no - Number(m![2])) < 1e-9);
    if (!seq || !cue) throw new Error(`no object found for '${ref}'`);
    return { seq, cue };
  }
}

let h: Harness;
let show: FakeShow;

before(async () => {
  h = await startHarness(registerAnalysisTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  h.fake.requests.length = 0;
  show = new FakeShow();
  show.install(h);
  show.presets.set("4.12", { addr: RED.addr!, addrNative: RED.addrNative!, name: "Red", referencedBy: 3 });
  show.presets.set("4.13", { addr: BLUE.addr!, addrNative: BLUE.addrNative!, name: "Blue" });
});

const onlyReads = () => {
  const ops = [...new Set(h.fake.requests.map((r) => r.op))];
  for (const op of ops) assert.ok(READ_OPS.has(op), `only read ops are sent (got ${op})`);
};

/** A small show: Sequence 1 uses Red three ways, Sequence 2 through a recipe line, Sequence 3 not at all. */
function usageShow(): void {
  show.sequences = [
    {
      no: 1,
      name: "Main",
      cues: [
        { no: 1, parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 100, { absPreset: RED }), row("102", "ColorRGB_R", 100, { absPreset: RED }), row("103", "Dimmer", 50)] }] },
        { no: 2, parts: [{ part: 0, rows: [row("101", "Dimmer", 20, { relPreset: RED })] }, { part: 1, own: false }] },
        { no: 2.5, parts: [{ part: 0, rows: [{ fixture: "201", attribute: "ColorRGB_G", stepCount: 2, steps: [{ step: 1, absolute: 0, integrated: BLUE }, { step: 2, absolute: 100, integrated: RED }] }] }] },
      ],
    },
    { no: 2, name: "Recipes", cues: [{ no: 1, parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 100, { cooked: true })], recipes: [{ index: 1, selection: "Group 1", preset: "4.12 Red", presetRef: { name: "Red", addrNative: RED.addrNative, addr: RED.addr, class: "Preset" }, presetResolved: true }] }] }] },
    { no: 3, name: "Other", cues: [{ no: 1, parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 100, { absPreset: BLUE })] }] }] },
  ];
  show.pages = [{ no: 1, execs: [[201, 1], [202, 3]] }, { no: 2, execs: [[101, 1], [102, 2]] }];
}

// ---------------------------------------------------------------------------
// gma3_preset_usage
// ---------------------------------------------------------------------------

test("preset usage: absolute, relative, phaser step and recipe references, with the executors; parts without data are not read", async () => {
  usageShow();
  const { result, isError } = await h.callJson("gma3_preset_usage", { preset: "4.12" });
  assert.equal(isError, false);
  assert.equal(result.complete, true);
  assert.equal(result.usageCount, 4);
  assert.match(result.summary, /Preset 4\.12 is referenced by 4 cue part\(s\) in 2 sequence\(s\)\./);
  const at = (s: number, c: string) => result.usages.find((u: Row) => u.sequence === s && u.cue === c);
  assert.deepEqual(at(1, "1").via, ["absolute"]);
  assert.deepEqual(at(1, "1").fixtures, ["101", "102"]);
  assert.equal(at(1, "1").channels, 2);
  assert.deepEqual(at(1, "2").via, ["relative"]);
  assert.deepEqual(at(1, "2.5").via, ["phaser step"]);
  assert.deepEqual(at(2, "1").via, ["recipe line 1"], "the cooked row has no reference of its own; the recipe line has");
  assert.equal(at(3, "1"), undefined, "Blue is another preset");
  assert.deepEqual(result.executors, [
    { sequence: 1, name: "Main", executors: ["Page 1.201", "Page 2.101"] },
    { sequence: 2, name: "Recipes", executors: ["Page 2.102"] },
  ]);
  assert.equal(result.executorScan.complete, true);
  assert.equal(result.preset.consoleReferenceCount, 3);
  assert.deepEqual(result.coverage.cues, { listed: 5, scanned: 5 });
  assert.equal(result.coverage.cueObjectsInScope, undefined, "the fake listing carries no childCount, so no total is claimed");
  assert.equal(result.coverage.parts.withoutData, 1);
  const partReads = h.fake.requests.filter((r) => r.op === "preset.read").map((r) => r.args.ref);
  assert.ok(!partReads.includes("Sequence 1 Cue 2 Part 1"), "OwnDataPresent No is not read");
  assert.ok(partReads.includes("Sequence 1 Cue 2.5 Part 0"));
  onlyReads();
});

test("preset usage: a complete scan without usages says so; an incomplete one says it proves nothing", async () => {
  usageShow();
  const none = await h.callJson("gma3_preset_usage", { preset: "4.12", sequences: [3] });
  assert.equal(none.result.complete, true);
  assert.equal(none.result.usageCount, 0);
  assert.match(none.result.summary, /^no cue part in Sequence\(s\) 3 references Preset 4\.12/);

  show.sequences[2].cues.push({ no: 2, parts: [{ part: 0, own: true, fail: "[not-preset] Sequence 3 Cue 2 Part 0 is a Part, not a preset" }] });
  const old = await h.callJson("gma3_preset_usage", { preset: "4.12", sequences: [3] });
  assert.equal(old.result.complete, false);
  assert.match(old.result.summary, /INCOMPLETE, so this does not show that Preset 4\.12 is unused/);
  assert.match(old.result.unread[0].reason, /needs bridge 0\.24\.0/);
  assert.equal(old.result.coverage.parts.unread, 1);
  onlyReads();
});

test("preset usage: truncated parts, parts without a table, failed cues, unreadable OwnDataPresent and an old bridge leave the scan incomplete", async () => {
  const cases: Array<[string, (s: FakeShow) => void, RegExp]> = [
    ["truncated", (s) => (s.sequences[0].cues[0].parts[0].truncated = true), /only the first 3 were read/],
    ["no table", (s) => (s.sequences[0].cues[0].parts[0].noTable = true), /no per-fixture table/],
    ["cue fails", (s) => (s.sequences[0].cues[1].fail = "request timed out"), /could not be read/],
    ["old bridge", (s) => (s.bridgeVersion = "0.46.2"), /cannot be confirmed complete/],
  ];
  for (const [name, mutate, reason] of cases) {
    show.sequences = [{ no: 1, name: "Main", cues: [{ no: 1, parts: [{ part: 0, rows: [row("101", "Dimmer", 1), row("102", "Dimmer", 1), row("103", "Dimmer", 1)] }] }, { no: 2, parts: [{ part: 0, rows: [] }] }] }];
    show.bridgeVersion = "0.51.0";
    mutate(show);
    const { result, isError } = await h.callJson("gma3_preset_usage", { preset: "4.12" });
    assert.equal(isError, false, name);
    assert.equal(result.complete, false, name);
    assert.match(JSON.stringify(result.reasons) + JSON.stringify(result.unread ?? []), reason, name);
    assert.match(result.summary, /INCOMPLETE/, name);
  }
  // A part whose OwnDataPresent cannot be read is read anyway.
  show.sequences = [{ no: 1, name: "Main", cues: [{ no: 1, parts: [{ part: 0, own: null, rows: [row("101", "Dimmer", 1, { absPreset: RED })] }] }] }];
  const { result } = await h.callJson("gma3_preset_usage", { preset: "4.12" });
  assert.equal(result.usageCount, 1);
});

test("preset usage: a missing preset is an error that points at dangling; neither preset nor dangling is refused", async () => {
  usageShow();
  const missing = await h.callJson("gma3_preset_usage", { preset: "4.99" });
  assert.equal(missing.isError, true);
  assert.match(missing.result.error, /Preset 4\.99 does not exist.*dangling: true/);
  const none = await h.callJson("gma3_preset_usage", {});
  assert.equal(none.isError, true);
  assert.match(JSON.stringify(none.result.validationErrors), /give preset/);
  assert.equal(h.fake.requests.filter((r) => r.op !== "ping" && r.op !== "preset.read").length, 0);
  assert.deepEqual(parsePresetRef("p", "Preset 21.7"), { pool: 21, no: 7, ref: "Preset 21.7" });
  assert.throws(() => parsePresetRef("p", "4.1 Thru 5"), /must be a preset/);
});

test("preset usage: dangling references are invalid handles and unresolved recipe presets, located but not named", async () => {
  show.sequences = [
    {
      no: 5,
      name: "Old",
      cues: [
        { no: 1, parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 100, { absPreset: DELETED }), row("102", "ColorRGB_R", 100, { absPreset: RED })] }] },
        { no: 2, parts: [{ part: 0, rows: [{ fixture: "201", attribute: "Pan", stepCount: 2, steps: [{ step: 1, absolute: 0, integrated: DELETED }, { step: 2, absolute: 10 }] }] }] },
        { no: 3, parts: [{ part: 0, rows: [], own: true, recipes: [{ index: 2, preset: "4.77", presetResolved: false }] }] },
      ],
    },
  ];
  const { result } = await h.callJson("gma3_preset_usage", { dangling: true });
  assert.equal(result.complete, true);
  assert.equal(result.danglingCount, 3);
  assert.deepEqual(result.dangling[0].examples, ["101 ColorRGB_R (absolute)"]);
  assert.deepEqual(result.dangling[1].examples, ["201 Pan (step 1)"]);
  assert.deepEqual(result.dangling[2].recipes, [{ line: 2, preset: "4.77" }]);
  assert.equal(result.preset, undefined);
  assert.equal(result.executors, undefined);
  onlyReads();
});

test("preset usage: the cue budget stops the scan with a resume point, and resume continues there", async () => {
  show.sequences = [1, 2, 3].map((s) => ({ no: s, name: `S${s}`, cues: [1, 2, 3, 4].map((c) => ({ no: c, parts: [{ part: 0, rows: [row("101", "Dimmer", 1, s === 3 && c === 4 ? { absPreset: RED } : {})] }] })) }));
  const first = await h.callJson("gma3_preset_usage", { preset: "4.12", max_cues: 5 });
  assert.equal(first.result.complete, false);
  assert.deepEqual(first.result.next, { resume: { sequence: 2, cue: "2" } });
  assert.equal(first.result.coverage.cues.scanned, 5);
  assert.match(first.result.summary, /INCOMPLETE/);
  const second = await h.callJson("gma3_preset_usage", { preset: "4.12", resume: first.result.next.resume });
  assert.equal(second.result.complete, true);
  assert.equal(second.result.coverage.cues.scanned, 7);
  assert.equal(second.result.usageCount, 1);
  assert.equal(second.result.usages[0].sequence, 3);
});

test("preset usage: max_seconds is checked before each sequence listing; the next sequence is not listed and resumes from its first cue", async (t) => {
  show.sequences = [1, 2].map((s) => ({ no: s, name: `S${s}`, cues: [1, 2].map((c) => ({ no: c, parts: [{ part: 0, rows: [row("101", "Dimmer", 1, s === 2 && c === 2 ? { absPreset: RED } : {})] }] })) }));
  // The clock jumps past the budget while the last cue of Sequence 1 is read.
  let offset = 0;
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, "now", () => realNow() + offset);
  const contents = h.fake.handlerFor("cueContents")!;
  h.fake.on("cueContents", async (args, req) => {
    if (String(args.ref).endsWith("Sequence 1 Cue 2")) offset += 3_600_000;
    return contents(args, req);
  });
  const first = await h.callJson("gma3_preset_usage", { preset: "4.12", max_seconds: 5 });
  assert.equal(first.result.complete, false);
  assert.deepEqual(first.result.next, { resume: { sequence: 2, cue: "0.001" } });
  assert.match(first.result.reasons.join(" "), /time budget \(max_seconds\) was reached/);
  assert.equal(h.fake.requests.filter((r) => r.op === "children" && r.args.ref === "Sequence 2").length, 0, "Sequence 2 was not listed");
  t.mock.restoreAll();
  h.fake.on("cueContents", contents);
  const second = await h.callJson("gma3_preset_usage", { preset: "4.12", resume: first.result.next.resume });
  assert.equal(second.result.complete, true);
  assert.equal(second.result.coverage.cues.scanned, 2);
  assert.deepEqual(second.result.usages.map((u: Row) => [u.sequence, u.cue]), [[2, "2"]]);
});

test("preset usage: a large show stays bounded (counts complete, rows capped)", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(String(101 + i), "ColorRGB_R", 100, { absPreset: RED }));
  show.sequences = Array.from({ length: 30 }, (_, s) => ({ no: s + 1, name: `Seq ${s + 1}`, cues: Array.from({ length: 40 }, (_, c) => ({ no: c + 1, parts: [{ part: 0, rows }] })) }));
  show.pages = [{ no: 1, execs: Array.from({ length: 30 }, (_, i) => [101 + i, i + 1] as [number, number]) }];
  const { result, text } = await h.callJson("gma3_preset_usage", { preset: "4.12", max_cues: 5000 });
  assert.equal(result.complete, true);
  assert.equal(result.usageCount, 1200);
  assert.equal(result.usages.length, 100);
  assert.ok(text.length < 40000, `reply is ${text.length} bytes`);
  assert.equal(result.usages[0].fixtures.length, 9, "8 fixtures and a count");
});

test("preset usage: an incomplete executor scan makes the result incomplete", async () => {
  usageShow();
  show.failPages = "request timed out";
  const { result } = await h.callJson("gma3_preset_usage", { preset: "4.12" });
  assert.equal(result.usageCount, 4);
  assert.equal(result.complete, false);
  assert.match(result.reasons.join(" "), /executor scan is incomplete/);
  assert.equal(result.executorScan.complete, false);
});

test("OffCue and CueZero are left out even when OffCue's No read fails; a numbered cue whose No fails is not", async () => {
  usageShow();
  const base = h.fake.handlerFor("children")!;
  h.fake.on("children", async (args, req) => {
    const res = (await base(args, req)) as { items: Array<Row> };
    if (args.ref === "Sequence 3") for (const it of res.items) if (it.name === "OffCue") it.fieldErrors = { No: "no such property" };
    return res;
  });
  const ok = await h.callJson("gma3_preset_usage", { preset: "4.12", sequences: [3] });
  assert.equal(ok.result.complete, true);
  h.fake.on("children", async (args, req) => {
    const res = (await base(args, req)) as { items: Array<Row> };
    if (args.ref === "Sequence 3") for (const it of res.items) if (it.name === "Cue 1") it.fieldErrors = { No: "raised" };
    return res;
  });
  const bad = await h.callJson("gma3_preset_usage", { preset: "4.12", sequences: [3] });
  assert.equal(bad.result.complete, false);
  assert.match(bad.result.reasons.join(" "), /without a readable number/);
});

test("data_pool: cue and part reads are scoped to DataPool n", async () => {
  usageShow();
  const { result } = await h.callJson("gma3_cue_diff", { data_pool: 2, a: { sequence: 1, cue: 1 }, b: { cue: 2 } });
  assert.equal(result.dataPool, 2);
  const refs = h.fake.requests.filter((r) => r.op === "cueContents" || r.op === "preset.read").map((r) => String(r.args.ref));
  assert.deepEqual(refs, ["DataPool 2 Sequence 1 Cue 1", "DataPool 2 Sequence 1 Cue 1 Part 0", "DataPool 2 Sequence 1 Cue 2", "DataPool 2 Sequence 1 Cue 2 Part 0"]);
});

test("preset usage: an unreadable sequence pool is an error, never 'no usages'", async () => {
  show.failSequenceListing = "request timed out";
  const { isError, result } = await h.callJson("gma3_preset_usage", { preset: "4.12" });
  assert.equal(isError, true);
  assert.match(result.error, /sequence pool could not be read/);
});

// ---------------------------------------------------------------------------
// gma3_cue_diff
// ---------------------------------------------------------------------------

test("cue diff: values added, removed and changed per fixture and attribute; cue, part and preset differences", async () => {
  show.sequences = [
    {
      no: 1,
      name: "Main",
      cues: [
        { no: 1, name: "Open", parts: [{ part: 0, rows: [row("101", "Dimmer", 100), row("101", "ColorRGB_R", 100, { absPreset: RED }), row("102", "Dimmer", 50, { fade: 2 })] }] },
        { no: 2, name: "Blue", props: { trigType: "Follow" }, parts: [{ part: 0, timing: { cueFade: "3.00" }, rows: [row("101", "Dimmer", 100), row("101", "ColorRGB_R", 100, { absPreset: BLUE }), row("103", "Dimmer", 10)] }] },
      ],
    },
  ];
  const { result } = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: 2 } });
  assert.equal(result.complete, true);
  assert.equal(result.identical, false);
  assert.deepEqual(result.counts, { aValues: 3, bValues: 3, added: 1, removed: 1, changed: 1, same: 1 });
  const v = (f: string, a: string) => result.values.find((x: Row) => x.fixture === f && x.attribute === a);
  assert.deepEqual(v("101", "ColorRGB_R").fields, ["preset"]);
  assert.equal(v("101", "ColorRGB_R").a.preset, 'Preset 4.12 "Red"');
  assert.equal(v("102", "Dimmer").change, "removed");
  assert.equal(v("103", "Dimmer").change, "added");
  assert.deepEqual(result.cue.find((c: Row) => c.field === "trigType"), { field: "trigType", a: "Go", b: "Follow" });
  assert.ok(result.cue.some((c: Row) => c.field === "name"));
  assert.deepEqual(result.parts, [{ part: 0, changes: [{ field: "timing.cueFade", a: "2.00", b: "3.00" }] }]);
  assert.deepEqual(result.presets, { onlyA: ['Preset 4.12 "Red"'], onlyB: ['Preset 4.13 "Blue"'], both: 0 });
  assert.match(result.compared, /STORED data only/);
  onlyReads();
});

test("cue diff: paging, identical cues, an incomplete read and a missing cue", async () => {
  const many = Array.from({ length: 30 }, (_, i) => row(String(101 + i), "Dimmer", i));
  show.sequences = [
    { no: 1, name: "A", cues: [{ no: 1, parts: [{ part: 0, rows: many }] }, { no: 2, parts: [{ part: 0, rows: [] }] }, { no: 3, name: "Cue 1", parts: [{ part: 0, rows: many }] }] },
    { no: 2, name: "B", cues: [{ no: 1, parts: [{ part: 0, rows: many }] }, { no: 2, parts: [{ part: 0, rows: many, fail: "request timed out" }] }] },
  ];
  const page = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { sequence: 1, cue: 2 }, limit: 10 });
  assert.equal(page.result.total, 30);
  assert.equal(page.result.count, 10);
  assert.equal(page.result.truncated, true);
  const same = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { sequence: 2, cue: 1 } });
  assert.equal(same.result.identical, true);
  assert.match(same.result.summary, /store the same data/);
  const partial = await h.callJson("gma3_cue_diff", { a: { sequence: 2, cue: 1 }, b: { sequence: 2, cue: 2 } });
  assert.equal(partial.result.complete, false);
  assert.equal(partial.result.identical, null);
  const missing = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { sequence: 1, cue: 9 } });
  assert.equal(missing.isError, true);
  const self = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: "1" } });
  assert.equal(self.isError, true);
  onlyReads();
});

// ---------------------------------------------------------------------------
// gma3_tracking_leaks
// ---------------------------------------------------------------------------

/**
 * Cue 1: 101 Gobo1 30, 101 Dimmer 100, 102 Dimmer 100. Cues 2-4 work on 101 (colour, dimmer) without Gobo1; 102 is
 * never touched again. Cue 5 restates Gobo1.
 */
function leakShow(extra: (cues: FakeCue[]) => void = () => {}): void {
  const cues: FakeCue[] = [
    { no: 1, parts: [{ part: 0, rows: [row("101", "Gobo1", 30), row("101", "Dimmer", 100), row("102", "Dimmer", 100)] }] },
    { no: 2, parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 100)] }] },
    { no: 3, parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 0)] }] },
    { no: 4, parts: [{ part: 0, rows: [row("101", "Dimmer", 50)] }] },
    { no: 5, parts: [{ part: 0, rows: [row("101", "Gobo1", 0), row("101", "Dimmer", 50), row("101", "ColorRGB_R", 0)] }] },
  ];
  extra(cues);
  show.sequences = [{ no: 7, name: "Show", cues }];
}

test("tracking leaks: a value left to track through cues that revisit the fixture is a candidate; an untouched fixture is not", async () => {
  leakShow();
  const { result } = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(result.complete, true);
  assert.equal(result.tracking, true);
  const gobo = result.candidates.find((c: Row) => c.attribute === "Gobo1");
  assert.deepEqual(
    { storedIn: gobo.storedIn, trackedThrough: gobo.trackedThrough, lastEffective: gobo.lastEffective, revisitedIn: gobo.revisitedIn, endedBy: gobo.endedBy, value: gobo.value },
    { storedIn: "1", trackedThrough: 3, lastEffective: "4", revisitedIn: ["2", "3", "4"], endedBy: "restated in cue 5", value: { value: 30 } },
  );
  const dim101 = result.candidates.find((c: Row) => c.fixture === "101" && c.attribute === "Dimmer" && c.storedIn === "1");
  assert.equal(dim101.trackedThrough, 2, "restated in cue 4");
  assert.equal(result.candidates.find((c: Row) => c.fixture === "102"), undefined, "102 is never revisited");
  assert.match(result.heuristic, /CANDIDATE when it tracks through at least min_cues/);
  const all = await h.callJson("gma3_tracking_leaks", { sequence: 7, require_revisit: false, min_cues: 4 });
  assert.deepEqual(all.result.candidates.map((c: Row) => `${c.fixture} ${c.attribute} ${c.endedBy}`), ["102 Dimmer end of the sequence (still on until OffCue or another release)"]);
  onlyReads();
});

test("tracking leaks: Release ends runs, a Break is counted up to the cue before and reported, a TrackingDistance excludes", async () => {
  leakShow((cues) => (cues[2].props = { release: "Yes" }));
  const rel = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(rel.result.candidates.find((c: Row) => c.attribute === "Gobo1"), undefined, "released at cue 3 after one cue");
  assert.deepEqual(rel.result.releaseCues, ["3"]);

  leakShow((cues) => (cues[3].props = { break: "Filter 3 'Only Dimmer'" }));
  const brk = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  const gobo = brk.result.candidates.find((c: Row) => c.attribute === "Gobo1");
  assert.equal(gobo.trackedThrough, 2);
  assert.match(gobo.endedBy, /cue 4 has a Break .* not evaluated/);
  assert.match(brk.result.uncertain[0], /cue\(s\) 4 have a Break \(read as "Filter 3 'Only Dimmer'"\) whose filter was not evaluated: \d+ run\(s\)/);

  // Nothing found, but runs were cut at a Break: the summary must not read as a clean negative.
  leakShow((cues) => (cues[1].props = { break: "World 2" }));
  const cut = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(cut.result.candidateCount, 0);
  assert.match(cut.result.summary, /run\(s\) cut at a Break .* were NOT evaluated/);
  assert.ok(cut.result.notEvaluated.cutByBreak > 0);

  leakShow((cues) => (cues[0].parts[0].timing = { trackingDistance: "3" }));
  const dist = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(dist.result.candidates.find((c: Row) => c.storedIn === "1"), undefined);
  assert.match(dist.result.uncertain.join(" "), /3 value run\(s\) stored in parts with a TrackingDistance \(read as "3"\) were excluded/);
});

test("tracking leaks: Tracking off means no leaks; unread cues and the budget leave the result incomplete", async () => {
  leakShow();
  show.sequences[0].tracking = "No";
  const off = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(off.result.complete, true);
  assert.match(off.result.summary, /Tracking off/);
  assert.equal(h.fake.requests.filter((r) => r.op === "cueContents").length, 1, "one cue is enough to know");

  leakShow((cues) => (cues[1].parts[0].fail = "request timed out"));
  const bad = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(bad.result.complete, false);
  assert.equal(bad.result.coverage.cuesUnread, 1);
  assert.equal(bad.result.candidates?.find((c: Row) => c.storedIn === "1"), undefined, "runs end as unknown at the unread cue");

  leakShow((cues) => {
    for (const c of cues) c.parts[0].rows = [row("101", "ColorRGB_R", c.no)];
    cues[0].parts[0].rows!.push(row("101", "Gobo1", 30));
  });
  const capped = await h.callJson("gma3_tracking_leaks", { sequence: 7, max_cues: 3 });
  assert.equal(capped.result.complete, false);
  assert.match(capped.result.reasons.join(" "), /cue budget.*after 3 of 5 cues/);
  assert.equal(capped.result.candidates[0].endedBy, "end of the scanned range");

  leakShow(() => {});
  show.sequences[0].cues = [];
  const empty = await h.callJson("gma3_tracking_leaks", { sequence: 7, from: 2 });
  assert.equal(empty.result.candidateCount, 0);
  onlyReads();
});

test("tracking leaks: the fold is a pure function of the cues read", () => {
  const cue = (no: string, rows: Row[], props: Row = {}): CueRead => ({ sequence: 1, cue: no, ref: `Sequence 1 Cue ${no}`, name: null, props, tracking: true, parts: [{ part: 0, name: null, timing: {}, command: {}, mib: {}, ownDataPresent: true, recipes: [], rows: rows as never }] });
  const fold = foldLeaks([cue("1", [row("1", "Pan", 10), row("1", "Tilt", 10)]), cue("2", [row("1", "Pan", 20)]), cue("3", [row("1", "Pan", 30)])], { minCues: 2, requireRevisit: true }, false);
  assert.deepEqual(fold.candidates.map((c) => [c.attribute, c.trackedThrough, c.endedBy]), [["Tilt", 2, "end of the scanned range"]]);
  assert.equal(isSet(""), false);
  assert.equal(isSet("None"), false);
  assert.equal(isSet("Filter 3"), true);
  assert.equal(renderLines({ a: 1, rows: [1, 2] }, ["rows"]), '{"a":1,\n"rows":[\n1,\n2\n]}');
  assert.deepEqual(JSON.parse(renderLines({ a: 1, rows: [{ x: 1 }], other: [] }, ["rows", "other"])), { a: 1, rows: [{ x: 1 }], other: [] });
});

// Review of #129: equality must cover every stored layer, recipe properties, per-part TrackingDistance and the
// console's unset Break text.

test("cue diff: phaser steps that differ only in a relative value, a timing layer or which step holds a preset are not identical", async () => {
  const steps = (rel: number, width: number, presets: [Ref | null, Ref | null]) => ({
    stepCount: 2,
    steps: [
      { step: 1, absolute: 50, relative: rel, width, integrated: presets[0] },
      { step: 2, absolute: 50, relative: rel, integrated: presets[1] },
    ],
  });
  const cue = (no: number, extra: Row) => ({ no, name: "Look", parts: [{ part: 0, rows: [row("101", "Pan", 50, extra)] }] });
  show.sequences = [{ no: 1, name: "A", cues: [cue(1, steps(0, 100, [RED, BLUE])), cue(2, steps(20, 100, [RED, BLUE])), cue(3, steps(0, 50, [RED, BLUE])), cue(4, steps(0, 100, [BLUE, RED])), cue(5, steps(0, 100, [RED, BLUE]))] }];
  for (const [b, field] of [[2, "stepRelative"], [3, "stepWidth"], [4, "stepPresets"]] as const) {
    const { result } = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: b } });
    assert.equal(result.identical, false, `cue ${b}`);
    assert.deepEqual(result.values.find((x: Row) => x.attribute === "Pan").fields, [field], `cue ${b}`);
  }
  const same = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: 5 } });
  assert.equal(same.result.identical, true);
  onlyReads();
});

test("cue diff: recipe lines that differ only in FadeX, SpeedX, MAtricks or filter are a part difference", async () => {
  const line: Row = { index: 1, enabled: false, selection: "Group 1", preset: "4.12", fadeX: "None", delayX: "None", speedX: "None", phaseX: "None", matricks: "None", filter: "None" };
  const cue = (no: number, extra: Row) => ({ no, name: "Look", parts: [{ part: 0, rows: [], recipes: [{ ...line, ...extra }] }] });
  show.sequences = [{ no: 1, name: "A", cues: [cue(1, {}), cue(2, { fadeX: "2" }), cue(3, { matricks: "MAtricks 3" }), cue(4, {})] }];
  for (const b of [2, 3]) {
    const { result } = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: b } });
    assert.equal(result.identical, false, `cue ${b}`);
    assert.equal(result.parts[0].changes[0].field, "recipes");
  }
  assert.equal((await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: 4 } })).result.identical, true);
  onlyReads();
});

test("tracking leaks: a TrackingDistance excludes only its own part's values; the console's unset Break text is no Break", async () => {
  const cue = (no: string, parts: Array<{ part: number; rows: Row[]; distance?: string }>, props: Row = {}): CueRead => ({
    sequence: 1, cue: no, ref: `Sequence 1 Cue ${no}`, name: null, props, tracking: true,
    parts: parts.map((p) => ({ part: p.part, name: null, timing: { trackingDistance: p.distance ?? "" }, command: {}, mib: {}, ownDataPresent: true, recipes: [], rows: p.rows as never })),
  });
  const opts = { minCues: 2, requireRevisit: true };
  // Part 0 stores the Dimmer; an empty Part 1 has a TrackingDistance: the Dimmer is still a candidate.
  const later = [cue("2", [{ part: 0, rows: [row("1", "Pan", 1)] }]), cue("3", [{ part: 0, rows: [row("1", "Pan", 2)] }])];
  const fold = foldLeaks([cue("1", [{ part: 0, rows: [row("1", "Dimmer", 100)] }, { part: 1, rows: [], distance: "2" }]), ...later], opts, false);
  assert.deepEqual(fold.candidates.map((c) => c.attribute), ["Dimmer"]);
  assert.equal(fold.excluded.trackingDistance, 0);
  // The same Dimmer stored in the part with the TrackingDistance is excluded.
  const own = foldLeaks([cue("1", [{ part: 0, rows: [] }, { part: 1, rows: [row("1", "Dimmer", 100)], distance: "2" }]), ...later], opts, false);
  assert.deepEqual(own.candidates, []);
  assert.equal(own.excluded.trackingDistance, 1);
  // onPC 2.5.1 reads a cue without a Break as "#FFFFFFFFFFFFFFFF": runs go on through it.
  assert.equal(isSet("#FFFFFFFFFFFFFFFF"), false);
  assert.equal(isSet("#ffffffffffffffff"), false);
  const sentinel = foldLeaks([cue("1", [{ part: 0, rows: [row("1", "Dimmer", 100)] }], { break: "#FFFFFFFFFFFFFFFF" }), ...later.map((c) => ({ ...c, props: { break: "#FFFFFFFFFFFFFFFF" } }))], opts, false);
  assert.deepEqual(sentinel.candidates.map((c) => c.attribute), ["Dimmer"]);
  assert.equal(sentinel.cutByBreak, 0);
  assert.deepEqual(sentinel.breaks, []);
});

// Review of #129, round 2: phaser measure and speed master are part of a stored value; a cue's number decides before
// its name.

test("cue diff: phasers that differ only in measure or speed master are not identical", async () => {
  const ph = (measure: number | null, speedMaster: number | null) => ({
    stepCount: 2,
    steps: [{ step: 1, absolute: 0 }, { step: 2, absolute: 100 }],
    speed: 1,
    phase: 0,
    ...(measure === null ? {} : { measure }),
    ...(speedMaster === null ? {} : { speedMaster }),
  });
  const cue = (no: number, extra: Row) => ({ no, name: "Look", parts: [{ part: 0, rows: [row("101", "Dimmer", 0, extra)] }] });
  show.sequences = [{ no: 1, name: "A", cues: [cue(1, ph(100, null)), cue(2, ph(200, null)), cue(3, ph(100, 2)), cue(4, ph(100, null))] }];
  for (const [b, field] of [[2, "measure"], [3, "speedMaster"]] as const) {
    const { result } = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: b } });
    assert.equal(result.identical, false, `cue ${b}`);
    assert.deepEqual(result.values.find((x: Row) => x.attribute === "Dimmer").fields, [field], `cue ${b}`);
  }
  assert.equal((await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: 4 } })).result.identical, true);
  onlyReads();
});

test("a numbered cue named OffCue or CueZero is scanned by preset usage and tracking leaks; the real ones are still left out", async () => {
  usageShow();
  show.sequences[0].cues[0].name = "OffCue";
  show.sequences[0].cues[1].name = "CueZero";
  const usage = await h.callJson("gma3_preset_usage", { preset: "4.12", sequences: [1] });
  assert.equal(usage.result.complete, true);
  const cuesFound = usage.result.usages.filter((u: Row) => u.sequence === 1).map((u: Row) => u.cue);
  assert.deepEqual(cuesFound, ["1", "2", "2.5"], "cues 1 and 2 are scanned under their special names");
  leakShow();
  show.sequences[0].cues[0].name = "OffCue";
  const { result } = await h.callJson("gma3_tracking_leaks", { sequence: 7 });
  assert.equal(result.complete, true);
  assert.equal(result.candidates.find((c: Row) => c.attribute === "Gobo1")?.storedIn, "1", "the value stored in cue 1 (named OffCue) is a candidate");
  onlyReads();
});

test("cue diff: Preset 4.12 \"Red\" of DataPool 1 and of DataPool 2 are different presets, in values, steps and the preset lists", async () => {
  const RED2: Ref = { ...RED, addr: "14.14.2.4.4.12", addrNative: "ShowData.DataPools.Two.PresetPools.4.12" };
  const cue = (no: number, ref: Ref) => ({
    no,
    name: "Look",
    parts: [{ part: 0, rows: [row("101", "ColorRGB_R", 100, { absPreset: ref }), { fixture: "201", attribute: "ColorRGB_G", stepCount: 2, steps: [{ step: 1, absolute: 0, integrated: ref }, { step: 2, absolute: 100, integrated: BLUE }] }] }],
  });
  show.sequences = [{ no: 1, name: "A", cues: [cue(1, RED), cue(2, RED2), cue(3, RED)] }];
  const { result } = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: 2 } });
  assert.equal(result.identical, false);
  assert.deepEqual(result.values.find((x: Row) => x.attribute === "ColorRGB_R").fields, ["presetAddr"]);
  assert.deepEqual(result.values.find((x: Row) => x.attribute === "ColorRGB_G").fields, ["stepPresetAddrs"]);
  assert.equal(result.values.find((x: Row) => x.attribute === "ColorRGB_R").a.preset, 'Preset 4.12 "Red"', "labels stay short");
  assert.deepEqual(result.presets.onlyA, ['Preset 4.12 "Red" @ ShowData.DataPools.Default.PresetPools.4.12']);
  assert.deepEqual(result.presets.onlyB, ['Preset 4.12 "Red" @ ShowData.DataPools.Two.PresetPools.4.12']);
  const same = await h.callJson("gma3_cue_diff", { a: { sequence: 1, cue: 1 }, b: { cue: 3 } });
  assert.equal(same.result.identical, true);
  assert.deepEqual(same.result.presets.onlyA, []);
  onlyReads();
});
