import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import { registerRecipeTools, axisSelection, parseTarget, parseScope, targetRef, lineRef, coverageOf, verifyCoverage, setReplyMatches } from "../src/tools/recipes.ts";
import { ValidationError } from "../src/validate.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("targets, scopes and line references", () => {
  const p = parseTarget({ preset: "23.5" });
  assert.equal(targetRef(p), "Preset 23.5");
  assert.equal(lineRef(p, 2), "Preset 23.5.2");
  const c = parseTarget({ sequence: 9, cue: 1.5 });
  assert.equal(targetRef(c), "Sequence 9 Cue 1.5 Part 0");
  assert.equal(lineRef(c, 3), "Sequence 9 Cue 1.5 Part 0.3");
  assert.equal(targetRef(parseScope({ sequence: 9 })), "Sequence 9");
  assert.equal(targetRef(parseScope({ sequence: 9, cue: 2 })), "Sequence 9 Cue 2");
  assert.equal(targetRef(parseScope({ sequence: 9, cue: 2, part: 1 })), "Sequence 9 Cue 2 Part 1");
  for (const bad of [{}, { preset: "4" }, { preset: "4.1", sequence: 1 }, { sequence: 0, cue: 1 }, { sequence: 1, cue: 1, part: -1 }]) assert.throws(() => parseTarget(bad), ValidationError, JSON.stringify(bad));
  assert.throws(() => parseScope({ sequence: 1, part: 0 }), ValidationError);
});

test("coverage summarises cooked and uncooked attributes per fixture", () => {
  const c = coverageOf([{ fixture: "401", attribute: "R", cooked: true }, { fixture: "401", attribute: "Dimmer", cooked: false }, { fixture: "402", attribute: "R", cooked: true }] as never);
  assert.deepEqual(c.cooked, [{ fixture: "401", attributes: ["R"] }, { fixture: "402", attributes: ["R"] }]);
  assert.deepEqual(c.uncooked, [{ fixture: "401", attributes: ["Dimmer"] }]);
});

test("coverage verification per cook option", () => {
  const row = (sf: number, attribute: string, cooked: boolean, value = 100) => ({ fixture: String(sf), sfIndex: sf, attribute, value, cooked });
  const expected = { pairs: new Set(["1|R", "2|R"]), touched: new Set([1, 2]), unpredicted: 0, uncertain: new Set<number>(), unknownReach: false };
  const hard = row(3, "Dimmer", false, 70);
  assert.deepEqual(verifyCoverage({ rows: [row(1, "R", true), row(2, "R", true), hard], expected, mode: "merge_low_priority", before: [hard] }), []);
  assert.match(verifyCoverage({ rows: [row(1, "R", true), hard], expected, mode: "merge_low_priority", before: [hard] }).join(), /expected cooked values missing: 2\|R/);
  assert.match(verifyCoverage({ rows: [row(1, "R", true), row(2, "R", true), row(9, "R", true), hard], expected, mode: "merge_low_priority", before: [hard] }).join(), /cooked values on fixtures no line selects: 9/);
  assert.match(verifyCoverage({ rows: [row(1, "R", true), row(2, "R", true)], expected, mode: "merge_low_priority", before: [hard] }).join(), /uncooked 3 Dimmer disappeared/);
  // Merge low priority keeps an uncooked value on the recipe's own pair: not a gap.
  const ownHard = row(1, "R", false, 30);
  assert.deepEqual(verifyCoverage({ rows: [ownHard, row(2, "R", true)], expected, mode: "merge_low_priority", before: [ownHard] }), []);
  // Merge may replace it; overwrite may delete everything uncooked.
  assert.deepEqual(verifyCoverage({ rows: [row(1, "R", true), row(2, "R", true), hard], expected, mode: "merge", before: [ownHard, hard] }), []);
  assert.deepEqual(verifyCoverage({ rows: [row(1, "R", true), row(2, "R", true)], expected, mode: "overwrite", before: [ownHard, hard] }), []);
  assert.match(verifyCoverage({ rows: [row(1, "R", true), hard], expected, mode: "remove", before: [hard] }).join(), /1 cooked value\(s\) remain after Remove/);
  assert.deepEqual(verifyCoverage({ rows: [hard], expected, mode: "remove", before: [row(1, "R", true), hard] }), []);
  // Merge may replace what an unpredicted line reaches (acknowledged before the cook), nothing else.
  const uncertain = { ...expected, uncertain: new Set([3]) };
  assert.deepEqual(verifyCoverage({ rows: [row(1, "R", true), row(2, "R", true), row(3, "Dimmer", true)], expected: { ...uncertain, touched: new Set([1, 2, 3]) }, mode: "merge", before: [hard] }), []);
});

test("uncooked rows that must survive are compared on their full content", () => {
  const cooked = [1, 2].map((sf) => ({ fixture: String(sf), sfIndex: sf, attribute: "R", value: 100, cooked: true }));
  const expected = { pairs: new Set(["1|R", "2|R"]), touched: new Set([1, 2]), unpredicted: 0, uncertain: new Set<number>(), unknownReach: false };
  const hard = { fixture: "3", sfIndex: 3, attribute: "Dimmer", value: 70, cooked: false, relative: 5, stepCount: 2, speed: 1, steps: [{ absolute: 70, relative: 5 }, { absolute: 20, relative: 0 }] };
  const check = (after: Record<string, unknown>) => verifyCoverage({ rows: [...cooked, { ...hard, ...after }], expected, mode: "merge_low_priority", before: [hard] as never }).join();
  assert.equal(check({}), "");
  assert.match(check({ steps: [{ absolute: 70, relative: 9 }, { absolute: 20, relative: 0 }] }), /uncooked 3 Dimmer changed by the cook/);
  assert.match(check({ speed: 2 }), /changed by the cook/);
  assert.match(check({ relative: 0 }), /changed by the cook/);
  assert.match(check({ value: "Open" }), /changed by the cook/);
  assert.match(check({ cooked: true }), /replaced by cooked data/);
  assert.match(verifyCoverage({ rows: cooked, expected, mode: "remove", before: [hard] as never }).join(), /uncooked 3 Dimmer disappeared/);
});

test("set replies are compared per property", () => {
  assert.equal(setReplyMatches("SelectionMode", "Strict", "Normal"), false);
  assert.equal(setReplyMatches("SelectionMode", "Normal", "normal"), true);
  assert.equal(setReplyMatches("Enabled", "Yes", true), true);
  assert.equal(setReplyMatches("Enabled", "No", true), false);
  assert.equal(setReplyMatches("Enabled", "Yes", "Strict"), false);
  assert.equal(setReplyMatches("Name", "a", "b"), false);
  assert.equal(setReplyMatches("Values", "", ""), true);
  assert.equal(setReplyMatches("Values", "", "Preset 4.4"), false);
});

// ---------------------------------------------------------------------------
// Fake console
// ---------------------------------------------------------------------------

interface FLine { cls: string; group: number | null; preset: string | null; matricks: number | null; enabled: boolean; name: string; mode: string; filter?: string; props?: Record<string, string> }
interface FRow { fixture: string; sfIndex: number; attribute: string; value: number; cooked: boolean }
interface FTarget { lines: FLine[]; rows: FRow[] }

class Console {
  groups = new Map<number, Array<{ fixture: string; sfIndex: number }>>([[908, [{ fixture: "401", sfIndex: 63 }, { fixture: "402", sfIndex: 64 }]], [909, []]]);
  presets = new Map<string, { addr: string; attrs: string[]; value: number }>([["4.4", { addr: "14.14.1.5.4.4", attrs: ["ColorRGB_R"], value: 100 }], ["1.11", { addr: "14.14.1.5.1.11", attrs: ["Dimmer"], value: 100 }]]);
  matricks = new Set([12]);
  targets = new Map<string, FTarget>();
  commands: string[] = [];
  /** An Assign that leaves an extra empty line behind (seen with Assign Shape on 2.5.1). */
  strayLine = false;
  /** A Cook that answers OK and changes nothing. */
  cookNoop = false;
  /** Line properties a set answers for and leaves unchanged; Assign kinds that answer OK and do nothing. */
  ignoreSet = new Set<string>();
  ignoreAssign = new Set<string>();
  /** Presets hold global rows (fixture type T1) instead of universal ones. */
  globalPresets = false;
  /** Incomplete reads: target data (the last row omitted), after the next cook, values presets, groups, line lists, fixture attributes. */
  truncatedData = new Set<FTarget>();
  truncateAfterCook = false;
  truncatedPresets = new Set<string>();
  truncatedGroups = new Set<number>();
  truncatedLines = new Set<FTarget>();
  failAttributes = new Set<string>();
  /** #101: cue objects ("Sequence S Cue C") with the name (Part 0) and note the tools write. */
  cues = new Map<string, { name: string; note: string }>();
  /** Commands the console refuses ("Illegal object"), set requests ("<ref> <Property>") that never get a reply. */
  reject?: RegExp;
  silentSet?: RegExp;
  /** How the console reads a cue's note back (a console that changed it). */
  noteRead?: (note: string) => string;

  /** A cue with its Part 0 (and the cue object's name and note). */
  cue(seq: number, cue: number, part = 0): FTarget {
    const k = `Sequence ${seq} Cue ${cue}`;
    if (!this.cues.has(k)) this.cues.set(k, { name: `Cue ${cue}`, note: "" });
    return this.part(seq, cue, part);
  }

  part(seq: number, cue: number, part = 0): FTarget {
    const k = `Sequence ${seq} Cue ${cue} Part ${part}`;
    if (!this.targets.has(k)) this.targets.set(k, { lines: [], rows: [] });
    return this.targets.get(k)!;
  }

  private presetOf(addr: string | null) {
    return [...this.presets.entries()].find(([, p]) => p.addr === addr);
  }

  /** The cooked output of a target's lines. */
  private output(t: FTarget): FRow[] {
    const out: FRow[] = [];
    for (const l of t.lines) {
      if (!l.enabled || l.group === null || !l.preset || l.cls !== "StandardRecipe") continue;
      const p = this.presetOf(l.preset)?.[1];
      if (!p) continue;
      // #101: the line's X column with XBlock gives values to the n-th block of the group only.
      const x = Number(l.props?.X);
      const block = Number(l.props?.XBlock) || 1;
      const members = (this.groups.get(l.group) ?? []).filter((_, i) => !(x >= 1) || Math.floor(i / block) === x - 1);
      for (const m of members) for (const a of p.attrs) out.push({ fixture: m.fixture, sfIndex: m.sfIndex, attribute: a, value: p.value, cooked: true });
    }
    return out;
  }

  cook(t: FTarget, mode: string): void {
    if (this.truncateAfterCook) this.truncatedData.add(t);
    if (this.cookNoop) return;
    const out = this.output(t);
    const key = (r: FRow) => `${r.sfIndex}|${r.attribute}`;
    const uncooked = t.rows.filter((r) => !r.cooked);
    if (mode === "/Remove") t.rows = uncooked;
    else if (mode === "/Overwrite") t.rows = out;
    else if (mode === "/Merge") { const o = new Set(out.map(key)); t.rows = [...uncooked.filter((r) => !o.has(key(r))), ...out]; }
    else { const u = new Set(uncooked.map(key)); t.rows = [...uncooked, ...out.filter((r) => !u.has(key(r)))]; }
  }

  private find(ref: string): { t: FTarget; line?: number } | null {
    const m = ref.match(/^(.*?)\.(\d+)$/);
    if (this.targets.has(ref)) return { t: this.targets.get(ref)! };
    if (m && this.targets.has(m[1])) return { t: this.targets.get(m[1])!, line: Number(m[2]) };
    // "Preset 23.5.2"
    const pm = ref.match(/^(Preset \d+\.\d+)\.(\d+)$/);
    if (pm && this.targets.has(pm[1])) return { t: this.targets.get(pm[1])!, line: Number(pm[2]) };
    return null;
  }

  install(h: Harness): void {
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Sequence (\d+)$/))) {
        const cues = [...new Set([...this.targets.keys()].map((k) => k.match(/^Sequence (\d+) Cue (\d+)/)).filter((x) => x && x[1] === m![1]).map((x) => x![2]))];
        return { items: [{ fields: { No: "" } }, { fields: { No: "0" } }, ...cues.map((c) => ({ fields: { No: c } }))] };
      }
      if ((m = ref.match(/^Sequence (\d+) Cue (\d+)$/))) {
        const parts = [...this.targets.entries()].filter(([k]) => k.startsWith(`${ref} Part `)).map(([k, v]) => ({ childCount: v.lines.length, fields: { Part: k.split(" Part ")[1] } }));
        if (!parts.length) throw new Error(`no object found for '${ref}'`);
        return { items: parts };
      }
      const t = this.targets.get(ref);
      if (!t) throw new Error(`no object found for '${ref}'`);
      // The display-role read of the per-line MAtricks columns (#101).
      if (args.asText !== false) return { items: t.lines.map((l, i) => ({ class: l.cls, index: i + 1, fields: Object.fromEntries(((args.fields as string[]) ?? []).map((k) => [k, l.props?.[k] ?? "None"])) })) };
      return {
        ...(this.truncatedLines.has(t) ? { total: t.lines.length + 1, offset: 0, count: t.lines.length } : {}),
        items: t.lines.map((l, i) => ({
          class: l.cls, index: i + 1, name: l.name,
          fields: {
            Name: l.name, Enabled: l.enabled,
            Selection: l.group !== null ? { name: `Group ${l.group}`, class: "Group", index: l.group, addr: `g.${l.group}` } : "",
            Values: l.preset ? { name: this.presetOf(l.preset)?.[0] ?? "?", class: "Preset", addr: l.preset } : "",
            MAtricks: l.matricks !== null ? { name: `M${l.matricks}`, class: "MAtrick", index: l.matricks } : "",
            Filter: l.filter ? { name: l.filter, class: "Filter" } : "", SelectionMode: l.mode, SelectionFromValue: false, FailedCookedPart: "None", EmptyLastCooking: false,
            X: l.props?.X ?? "None", Y: l.props?.Y ?? "None", Z: l.props?.Z ?? "None",
          },
        })),
      };
    });
    h.fake.on("group.read", (args) => {
      const n = Number(String(args.ref).replace("Group ", ""));
      const g = this.groups.get(n);
      if (!g) throw new Error(`no object found for '${args.ref}'`);
      return { truncated: this.truncatedGroups.has(n), items: g.map((m) => ({ ...m })) };
    });
    h.fake.on("preset.read", (args) => {
      const ref = String(args.ref);
      const t = this.targets.get(ref);
      if (t) {
        const cut = this.truncatedData.has(t);
        return { ref, class: ref.startsWith("Preset") ? "Preset" : "Part", rows: (cut ? t.rows.slice(0, -1) : t.rows).map((r) => ({ ...r })), dependencies: [], ...(cut ? { truncated: true } : {}) };
      }
      const entry = [...this.presets.entries()].find(([k, p]) => ref === `Preset ${k}` || ref === p.addr);
      if (!entry) throw new Error(`no object found for '${ref}'`);
      const [k, p] = entry;
      const [pool, no] = k.split(".").map(Number);
      if (this.truncatedPresets.has(k)) return { ref, class: "Preset", addr: p.addr, pool: { no: pool }, no, rows: [], dependencies: [], types: {}, truncated: true };
      if (this.globalPresets) {
        const typesFor = (args.typesFor as number[] | undefined) ?? [];
        return { ref, class: "Preset", addr: p.addr, pool: { no: pool }, no, rows: p.attrs.map((a) => ({ fixture: "T1", sfIndex: 0, attribute: a, mode: "global", fixtureType: "T1", value: p.value })), dependencies: [], types: Object.fromEntries(typesFor.map((sf) => [String(sf), "T1"])) };
      }
      return { ref, class: "Preset", addr: p.addr, pool: { no: pool }, no, rows: p.attrs.map((a) => ({ fixture: "Generic 1", sfIndex: 0, attribute: a, mode: "universal", value: p.value })), dependencies: [], types: {} };
    });
    h.fake.on("fixtureAttributes", (args) => {
      if (this.failAttributes.has(String(args.ref))) throw new Error("unreadable fixture");
      return { total: 2, offset: 0, count: 2, attributes: [{ attribute: "ColorRGB_R" }, { attribute: "Dimmer" }] };
    });
    h.fake.on("objects", (args) => {
      const c = this.cues.get(String(args.ref));
      if (c) return { items: [{ name: c.name, fields: { Name: c.name, Note: this.noteRead ? this.noteRead(c.note) : c.note } }] };
      if (/^Sequence /.test(String(args.ref))) return { items: [] };
      const n = Number(String(args.ref).replace("MAtricks ", ""));
      if (!this.matricks.has(n)) throw new Error(`no object found for '${args.ref}'`);
      return { items: [{ name: `M${n}` }] };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const prop = String(args.property);
      if (this.silentSet?.test(`${ref} ${prop}`)) return SILENT;
      const cm = ref.match(/^(Sequence \d+ Cue [\d.]+)( Part 0)?$/);
      if (cm) {
        const c = this.cues.get(cm[1]);
        if (!c) throw new Error(`no object found for '${ref}'`);
        if (prop === "Name" && cm[2]) c.name = String(args.value);
        if (prop === "Note" && !cm[2]) c.note = String(args.value);
        return { value: prop === "Name" ? c.name : c.note };
      }
      const f = this.find(ref)!;
      const l = f.t.lines[f.line! - 1];
      // The per-line MAtricks columns (#101) read in the edit role: seconds with two decimals, integers, None.
      const column = !["Name", "Enabled", "SelectionMode", "Values"].includes(prop);
      if (this.ignoreSet.has(prop)) return { value: prop === "Enabled" ? l.enabled : prop === "Name" ? l.name : prop === "SelectionMode" ? l.mode : column ? l.props?.[prop] ?? "None" : "" };
      if (prop === "Name") l.name = String(args.value);
      if (prop === "Enabled") l.enabled = args.value === "Yes";
      if (prop === "SelectionMode") l.mode = String(args.value);
      if (prop === "Values") l.preset = null;
      if (column) (l.props ??= {})[prop] = args.value === "None" ? "None" : /^(Fade|Delay)/.test(prop) ? Number(args.value).toFixed(2) : String(Number(args.value));
      this.cook(f.t, "/MergeLowPriority");
      return { value: prop === "Enabled" ? l.enabled : prop === "Values" ? "" : prop === "Name" ? l.name : column ? l.props![prop] : l.mode };
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      this.commands.push(c);
      if (this.reject?.test(c)) return { feedback: "Illegal object" };
      let m: RegExpMatchArray | null;
      if ((m = c.match(/^Assign (Group|Preset|MAtricks) (\S+) At (.+)$/))) {
        const f = this.find(m[3]);
        if (!f) return { feedback: "Illegal object" };
        let l = f.t.lines[f.line! - 1];
        if (!l) { l = { cls: "StandardRecipe", group: null, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" }; f.t.lines.push(l); if (this.strayLine) f.t.lines.push({ cls: "StandardRecipe", group: null, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" }); }
        if (this.ignoreAssign.has(m[1])) return { feedback: "OK" };
        if (m[1] === "Group") l.group = Number(m[2]);
        if (m[1] === "Preset") l.preset = this.presets.get(m[2])!.addr;
        if (m[1] === "MAtricks") l.matricks = Number(m[2]);
        this.cook(f.t, "/MergeLowPriority");
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Move (.+) At (.+)$/))) {
        const a = this.find(m[1])!;
        const b = this.find(m[2])!;
        const [l] = a.t.lines.splice(a.line! - 1, 1);
        // Insert semantics as on 2.5.1: moving down lands one place short.
        a.t.lines.splice(b.line! > a.line! ? b.line! - 2 : b.line! - 1, 0, l);
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Delete (.+) \/NoConfirmation$/))) {
        const f = this.find(m[1])!;
        f.t.lines.splice(f.line! - 1, 1);
        this.cook(f.t, "/MergeLowPriority");
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Cook (.+) (\/\w+)$/))) {
        for (const [k, t] of this.targets) if (k === m[1] || k.startsWith(`${m[1]} `)) this.cook(t, m[2]);
        return { feedback: "OK" };
      }
      throw new Error(`unexpected command ${c}`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerRecipeTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});
const T = { sequence: 9060, cue: 1 };
const edit = (args: Record<string, unknown>) => h.callJson("gma3_edit_recipe", { target: T, ...args });
const cook = (args: Record<string, unknown>) => h.callJson("gma3_cook_recipes", { target: T, ...args });
const stepError = (r: any, name: string) => r.steps.find((s: { name: string }) => s.name === name)?.error ?? "";

// ---------------------------------------------------------------------------
// gma3_edit_recipe
// ---------------------------------------------------------------------------

test("add assigns group then values, verifies the lines and reports the console's own cook", async () => {
  con.part(9060, 1);
  const { result, isError } = await edit({ action: "add", selection: 908, values: "4.4", name: "Red" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, ["Assign Group 908 At Sequence 9060 Cue 1 Part 0.1", "Assign Preset 4.4 At Sequence 9060 Cue 1 Part 0.1"]);
  assert.equal(result.autoCooked, true);
  assert.deepEqual(result.coverage.after.cooked.map((c: { fixture: string }) => c.fixture), ["401", "402"]);
  assert.equal(con.part(9060, 1).lines[0].name, "Red");
});

test("enabled: false switches a new line off before its values, so it never cooks", async () => {
  con.part(9060, 1);
  const { result } = await edit({ action: "add", selection: 908, values: "4.4", enabled: false });
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(result.autoCooked, false);
  assert.equal(con.part(9060, 1).rows.length, 0);
  assert.deepEqual(h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args.property}=${r.args.value}`), ["Enabled=No"]);
});

test("references, lines and targets are checked before anything is sent", async () => {
  con.part(9060, 1);
  for (const [args, step, re] of [
    [{ action: "add", selection: 999, values: "4.4" }, "check_references", /not in the show: Group 999/],
    [{ action: "add", selection: 908, values: "4.99" }, "check_references", /Preset 4\.99/],
    [{ action: "add", selection: 908, values: "4.4", matricks: 77 }, "check_references", /MAtricks 77/],
    [{ action: "set", line: 3, name: "x" }, "read_lines", /has no recipe line 3/],
  ] as const) {
    const { result } = await edit(args as Record<string, unknown>);
    assert.match(stepError(result, step), re, JSON.stringify(result));
  }
  const missing = await h.callJson("gma3_edit_recipe", { target: { sequence: 1, cue: 9 }, action: "add", selection: 908, values: "4.4" });
  assert.match(stepError(missing.result, "read_lines"), /does not exist/);
  for (const [args, re] of [[{ action: "add", selection: 908 }, /add needs selection .* and values/], [{ action: "set", line: 1 }, /set needs at least one/], [{ action: "move", line: 1 }, /move needs to/], [{ action: "remove", line: 1, name: "x" }, /remove takes no line fields/]] as const) {
    const { result } = await edit(args as Record<string, unknown>);
    assert.match(result.validationErrors.join(), re);
  }
  assert.equal(con.commands.length, 0);
});

test("a stray line left behind by an Assign is a mismatch", async () => {
  con.part(9060, 1);
  con.strayLine = true;
  const { result, isError } = await edit({ action: "add", selection: 908, values: "4.4" });
  assert.equal(isError, true);
  assert.match(result.verification.detail, /2 line\(s\) after adding to 0/);
});

test("move uses only upward moves and lands where asked; set and remove verify the rest", async () => {
  const t = con.part(9060, 1);
  const mk = (preset: string): FLine => ({ cls: "StandardRecipe", group: 908, preset: con.presets.get(preset)!.addr, matricks: null, enabled: true, name: preset, mode: "Strict" });
  con.presets.set("4.6", { addr: "14.14.1.5.4.6", attrs: ["ColorRGB_G"], value: 50 });
  t.lines = [mk("4.4"), mk("1.11"), mk("4.6")];
  const down = await edit({ action: "move", line: 1, to: 3 });
  assert.equal(down.result.verification.status, "matched", JSON.stringify(down.result.verification));
  assert.deepEqual(con.commands, ["Move Sequence 9060 Cue 1 Part 0.2 At Sequence 9060 Cue 1 Part 0.1", "Move Sequence 9060 Cue 1 Part 0.3 At Sequence 9060 Cue 1 Part 0.2"]);
  assert.deepEqual(t.lines.map((l) => l.name), ["1.11", "4.6", "4.4"]);
  const up = await edit({ action: "move", line: 3, to: 1 });
  assert.equal(up.result.verification.status, "matched");
  assert.deepEqual(t.lines.map((l) => l.name), ["4.4", "1.11", "4.6"]);
  const set = await edit({ action: "set", line: 2, matricks: 12, selection_mode: "normal" });
  assert.equal(set.result.verification.status, "matched", JSON.stringify(set.result.verification));
  const rm = await edit({ action: "remove", line: 2 });
  assert.equal(rm.result.verification.status, "matched", JSON.stringify(rm.result.verification));
  assert.deepEqual(t.lines.map((l) => l.name), ["4.4", "4.6"]);
});

// ---------------------------------------------------------------------------
// gma3_cook_recipes and gma3_recipes
// ---------------------------------------------------------------------------

function seeded(): FTarget {
  const t = con.part(9060, 1);
  t.lines = [{ cls: "StandardRecipe", group: 908, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict" }];
  t.rows = [{ fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", value: 100, cooked: true }, { fixture: "402", sfIndex: 64, attribute: "ColorRGB_R", value: 100, cooked: true }];
  return t;
}

test("a group change is cooked with merge_low_priority and the new coverage is verified; uncooked data stays", async () => {
  const t = seeded();
  t.rows.push({ fixture: "404", sfIndex: 66, attribute: "Dimmer", value: 70, cooked: false });
  con.groups.set(908, [{ fixture: "401", sfIndex: 63 }, { fixture: "402", sfIndex: 64 }, { fixture: "403", sfIndex: 65 }]);
  const pv = await cook({ mode: "merge_low_priority", preview: true });
  assert.equal(pv.isError, false, JSON.stringify(pv.result));
  assert.equal(pv.result.affected[0].lines[0].members.length, 3);
  assert.equal(pv.result.affected[0].expectedCooked, 3);
  assert.equal(con.commands.length, 0);
  const { result, isError } = await cook({ mode: "merge_low_priority" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, ["Cook Sequence 9060 Cue 1 /MergeLowPriority"], "a cue without a part cooks all its parts");
  assert.ok(t.rows.some((r) => r.fixture === "403" && r.cooked));
  assert.ok(t.rows.some((r) => r.fixture === "404" && !r.cooked));
});

test("a cook that changed nothing is a mismatch", async () => {
  seeded();
  con.groups.set(908, [{ fixture: "401", sfIndex: 63 }]);
  con.cookNoop = true;
  const { result, isError } = await cook({ mode: "merge_low_priority" });
  assert.equal(isError, true);
  assert.match(result.verification.detail, /cooked values on fixtures no line selects: 402/);
});

test("merge and overwrite are refused while they would replace or delete uncooked data", async () => {
  const t = seeded();
  t.rows.push({ fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", value: 30, cooked: false });
  t.rows = t.rows.filter((r) => !(r.fixture === "401" && r.cooked));
  t.rows.push({ fixture: "404", sfIndex: 66, attribute: "Dimmer", value: 70, cooked: false });
  const merge = await cook({ mode: "merge" });
  assert.match(stepError(merge.result, "check_uncooked"), /merge would replace uncooked values in .*401 ColorRGB_R/);
  const over = await cook({ mode: "overwrite" });
  assert.match(stepError(over.result, "check_uncooked"), /overwrite would delete uncooked values/);
  assert.equal(con.commands.length, 0);
  const ok = await cook({ mode: "merge", replace_uncooked: true });
  assert.equal(ok.result.verification.status, "matched", JSON.stringify(ok.result.verification));
  assert.ok(t.rows.some((r) => r.fixture === "401" && r.cooked && r.value === 100));
  assert.ok(t.rows.some((r) => r.fixture === "404" && !r.cooked), "merge keeps uncooked data elsewhere");
});

test("a sequence scope lists every cue part with recipes; problems are named", async () => {
  seeded();
  const t2 = con.part(9060, 2);
  t2.lines = [
    { cls: "StandardRecipe", group: 909, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict" },
    { cls: "StandardRecipe", group: null, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict" },
    { cls: "StandardRecipe", group: 908, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" },
    { cls: "PhaserRecipe", group: 908, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" },
  ];
  const { result } = await h.callJson("gma3_cook_recipes", { target: { sequence: 9060 }, mode: "merge_low_priority", preview: true });
  assert.deepEqual(result.affected.map((a: { target: string }) => a.target), ["Sequence 9060 Cue 1 Part 0", "Sequence 9060 Cue 2 Part 0"]);
  const w = result.warnings.join(" | ");
  assert.match(w, /Cue 2 Part 0 line 1: Group 909 is empty/);
  assert.match(w, /line 2: no selection/);
  assert.match(w, /line 3: no values/);
  assert.match(w, /line 4: PhaserRecipe lines are listed and kept, not modelled/);
  const read = await h.callJson("gma3_recipes", { target: { sequence: 9060, cue: 2 } });
  assert.equal(read.result.lines.length, 4);
  assert.equal(read.result.unpredictedLines, 1);
  const none = await h.callJson("gma3_cook_recipes", { target: { sequence: 9060, cue: 3, part: 0 }, mode: "merge_low_priority" });
  assert.match(stepError(none.result, "find_targets"), /does not exist|no recipe lines/);
});

test("a cook without a mode is refused before anything is sent", async () => {
  const { result } = await h.callJson("gma3_cook_recipes", { target: T });
  assert.match(String(result.validationErrors?.join() ?? result), /mode|Invalid/);
  assert.equal(h.fake.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Review 1 regressions
// ---------------------------------------------------------------------------

test("ignored edits are mismatches: a SelectionMode set the console keeps, an add whose MAtricks did not land", async () => {
  const t = seeded();
  t.lines[0].mode = "Strict";
  con.ignoreSet.add("SelectionMode");
  const set = await edit({ action: "set", line: 1, selection_mode: "normal" });
  assert.equal(set.isError, true, JSON.stringify(set.result));
  assert.notEqual(set.result.verification.status, "matched");
  con.ignoreAssign.add("MAtricks");
  const add = await edit({ action: "add", selection: 908, values: "1.11", matricks: 12 });
  assert.equal(add.isError, true, JSON.stringify(add.result));
  assert.match(add.result.verification.detail, /line 2 MAtricks reads none/);
});

test("a cook scope with more targets than are inspected is refused", async () => {
  for (let c = 1; c <= 201; c++) con.part(9061, c).lines = [{ cls: "StandardRecipe", group: 908, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict" }];
  con.part(9061, 201).rows = [{ fixture: "404", sfIndex: 66, attribute: "Dimmer", value: 70, cooked: false }];
  const { result, isError } = await h.callJson("gma3_cook_recipes", { target: { sequence: 9061 }, mode: "overwrite", replace_uncooked: true });
  assert.equal(isError, true);
  assert.match(stepError(result, "check_complete"), /inspection is incomplete.*more cue parts with recipes than the 200 inspected/);
  assert.equal(con.commands.length, 0);
  assert.ok(con.part(9061, 201).rows.length === 1);
  const pv = await h.callJson("gma3_cook_recipes", { target: { sequence: 9061 }, mode: "merge_low_priority", preview: true });
  assert.match(pv.result.truncated, /only the first 200/);
});

test("lines with unpredicted coverage make what they reach a possible merge conflict", async () => {
  const t = seeded();
  t.lines = [
    { cls: "StandardRecipe", group: 908, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict", filter: "Color" },
    { cls: "PhaserRecipe", group: 909, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" },
  ];
  t.rows.push({ fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", value: 30, cooked: false });
  t.rows = t.rows.filter((r) => !(r.fixture === "401" && r.cooked));
  t.rows.push({ fixture: "404", sfIndex: 66, attribute: "Dimmer", value: 70, cooked: false });
  const merge = await cook({ mode: "merge" });
  assert.match(stepError(merge.result, "check_uncooked"), /401 ColorRGB_R \(possibly/);
  assert.doesNotMatch(stepError(merge.result, "check_uncooked"), /404/);
  assert.equal(con.commands.length, 0);
  const ok = await cook({ mode: "merge", replace_uncooked: true });
  assert.equal(ok.result.verification.status, "matched", JSON.stringify(ok.result.verification));
  // A line without a known reach (no group) makes every uncooked value a possible conflict.
  t.lines.push({ cls: "PhaserRecipe", group: null, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" });
  con.commands = [];
  const all = await cook({ mode: "merge" });
  assert.match(stepError(all.result, "check_uncooked"), /404 Dimmer \(possibly/);
  assert.equal(con.commands.length, 0);
});

test("global preset rows are predicted for the members of every group that uses the preset", async () => {
  con.globalPresets = true;
  seeded();
  const t2 = con.part(9060, 2);
  con.groups.set(909, [{ fixture: "403", sfIndex: 65 }]);
  t2.lines = [{ cls: "StandardRecipe", group: 909, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict" }];
  t2.rows = [{ fixture: "403", sfIndex: 65, attribute: "ColorRGB_R", value: 30, cooked: false }];
  const merge = await h.callJson("gma3_cook_recipes", { target: { sequence: 9060 }, mode: "merge", preview: true });
  assert.equal(merge.result.affected[1].expectedCooked, 1, JSON.stringify(merge.result.affected));
  const real = await h.callJson("gma3_cook_recipes", { target: { sequence: 9060 }, mode: "merge" });
  assert.match(stepError(real.result, "check_uncooked"), /Cue 2 Part 0 \(403 ColorRGB_R\)/);
  assert.equal(con.commands.length, 0);
});

// ---------------------------------------------------------------------------
// Review 2 regressions: incomplete reads
// ---------------------------------------------------------------------------

/** Cue 1: the line cooks 401/402 R; 401 R is stored uncooked (30) and 404 Dimmer (70) is the last row. */
function withHardValues(): FTarget {
  const t = seeded();
  t.rows = t.rows.filter((r) => !(r.fixture === "401" && r.cooked));
  t.rows.push({ fixture: "401", sfIndex: 63, attribute: "ColorRGB_R", value: 30, cooked: false }, { fixture: "404", sfIndex: 66, attribute: "Dimmer", value: 70, cooked: false });
  return t;
}

test("incomplete target data refuses the cook, even with replace_uncooked", async () => {
  const t = withHardValues();
  con.truncatedData.add(t);
  for (const mode of ["overwrite", "merge", "merge_low_priority"]) {
    const { result, isError } = await cook({ mode, replace_uncooked: true });
    assert.equal(isError, true, mode);
    assert.match(stepError(result, "check_complete"), /data of Sequence 9060 Cue 1 Part 0 was not read completely/, mode);
  }
  assert.equal(con.commands.length, 0);
  assert.ok(t.rows.some((r) => r.fixture === "404"), "the unseen uncooked value is still there");
  const pv = await cook({ mode: "merge_low_priority", preview: true });
  assert.equal(pv.isError, false, JSON.stringify(pv.result));
  assert.match(pv.result.incomplete.join(), /not read completely/);
});

test("a line list read only in part refuses the cook and the edit", async () => {
  const t = seeded();
  con.truncatedLines.add(t);
  const c = await cook({ mode: "merge_low_priority" });
  assert.match(stepError(c.result, "check_complete"), /has 2 children; only 1 were read/);
  const e = await edit({ action: "add", selection: 908, values: "1.11" });
  assert.match(stepError(e.result, "read_lines"), /only 1 were read/);
  assert.equal(con.commands.length, 0);
});

test("a truncated read-back is not a match", async () => {
  seeded();
  con.truncateAfterCook = true;
  const { result, isError } = await cook({ mode: "merge_low_priority" });
  assert.equal(isError, true);
  assert.match(result.verification.detail, /read-back was truncated/);
});

test("a failed attribute read makes the fixture uncertain, so merge needs replace_uncooked", async () => {
  withHardValues();
  con.failAttributes.add("Fixture 401");
  const merge = await cook({ mode: "merge" });
  assert.match(stepError(merge.result, "check_uncooked"), /401 ColorRGB_R \(possibly/);
  assert.doesNotMatch(stepError(merge.result, "check_uncooked"), /404/);
  assert.equal(con.commands.length, 0);
  assert.match(merge.result.warnings.join(), /attributes of 401 could not be read/);
  const ok = await cook({ mode: "merge", replace_uncooked: true });
  assert.equal(ok.result.verification.status, "matched", JSON.stringify(ok.result.verification));
});

test("an incompletely read group or values preset is never proof of safety", async () => {
  withHardValues();
  con.truncatedPresets.add("4.4");
  const p = await cook({ mode: "merge" });
  assert.match(stepError(p.result, "check_uncooked"), /401 ColorRGB_R \(possibly/);
  con.truncatedPresets.clear();
  con.truncatedGroups.add(908);
  const g = await cook({ mode: "merge" });
  assert.match(stepError(g.result, "check_uncooked"), /404 Dimmer \(possibly/, "an unknown reach puts every uncooked value at risk");
  assert.equal(con.commands.length, 0);
});

test("global rows without a fixture type for a member make it uncertain", async () => {
  con.globalPresets = true;
  withHardValues();
  h.fake.on("preset.read", (args) => {
    if (String(args.ref).startsWith("Sequence")) return { ref: args.ref, class: "Part", rows: con.part(9060, 1).rows.map((r) => ({ ...r })), dependencies: [] };
    return { ref: args.ref, class: "Preset", addr: "14.14.1.5.4.4", pool: { no: 4 }, no: 4, rows: [{ fixture: "T1", sfIndex: 0, attribute: "ColorRGB_R", mode: "global", fixtureType: "T1", value: 100 }], dependencies: [], types: { "64": "T1" } };
  });
  const merge = await cook({ mode: "merge" });
  assert.match(stepError(merge.result, "check_uncooked"), /401 ColorRGB_R \(possibly/);
  assert.match(merge.result.warnings.join(), /fixture type of 401 could not be read/);
});

// ---------------------------------------------------------------------------
// gma3_store_recipe_cues (#101)
// ---------------------------------------------------------------------------

const store = (args: Record<string, unknown>) => h.callJson("gma3_store_recipe_cues", { sequence: 9060, ...args });
const line = (group: number, values: string, extra: Record<string, unknown> = {}) => ({ selection: group, values, ...extra });
const sets = () => h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args.ref} ${r.args.property}=${r.args.value}`);

test("replace over several cues: the old lines are deleted from the last, the new ones written, and the result is one compact line per cue", async () => {
  con.groups.set(910, [{ fixture: "403", sfIndex: 65 }]);
  const c1 = con.cue(9060, 1);
  const c2 = con.cue(9060, 2);
  c1.lines.push({ cls: "StandardRecipe", group: 909, preset: "14.14.1.5.1.11", matricks: null, enabled: true, name: "old a", mode: "Strict" }, { cls: "StandardRecipe", group: 909, preset: "14.14.1.5.1.11", matricks: null, enabled: true, name: "old b", mode: "Strict" });
  c2.lines.push({ cls: "StandardRecipe", group: 909, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "old", mode: "Strict" });
  const { result, isError } = await store({ mode: "replace", cues: [{ cue: 1, lines: [line(908, "4.4"), line(910, "1.11", { matricks: 12 })] }, { cue: 2, lines: [line(908, "1.11")] }] });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, [
    "Delete Sequence 9060 Cue 1 Part 0.2 /NoConfirmation",
    "Delete Sequence 9060 Cue 1 Part 0.1 /NoConfirmation",
    "Assign Group 908 At Sequence 9060 Cue 1 Part 0.1",
    "Assign Preset 4.4 At Sequence 9060 Cue 1 Part 0.1",
    "Assign Group 910 At Sequence 9060 Cue 1 Part 0.2",
    "Assign Preset 1.11 At Sequence 9060 Cue 1 Part 0.2",
    "Assign MAtricks 12 At Sequence 9060 Cue 1 Part 0.2",
    "Delete Sequence 9060 Cue 2 Part 0.1 /NoConfirmation",
    "Assign Group 908 At Sequence 9060 Cue 2 Part 0.1",
    "Assign Preset 1.11 At Sequence 9060 Cue 2 Part 0.1",
  ]);
  assert.deepEqual(c1.lines.map((l) => [l.group, l.preset, l.matricks]), [[908, "14.14.1.5.4.4", null], [910, "14.14.1.5.1.11", 12]]);
  assert.deepEqual(c2.lines.map((l) => l.group), [908]);
  // Compact: one line per cue with its count, no per-step dump.
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].summary, /Sequence 9060 Cue 1 Part 0: 2 line\(s\) written in place of 2; 2 line\(s\) read back, matched/);
  assert.equal(result.items[0].result, undefined);
  assert.deepEqual(result.steps.map((s: { name: string }) => s.name), ["read_cues", "check_references", "item 1: Sequence 9060 Cue 1 Part 0", "item 2: Sequence 9060 Cue 2 Part 0"]);
  assert.equal(result.linesSent, 3);
  // The references were read once for the whole call: Group 908 and Preset 1.11 are used twice.
  assert.equal(h.fake.requests.filter((r) => r.op === "group.read" && r.args.ref === "Group 908").length, 1);
  assert.equal(h.fake.requests.filter((r) => r.op === "preset.read" && r.args.ref === "Preset 1.11").length, 1);
});

test("append adds after the existing lines and checks they are unchanged", async () => {
  const c1 = con.cue(9060, 1);
  c1.lines.push({ cls: "StandardRecipe", group: 908, preset: "14.14.1.5.1.11", matricks: null, enabled: true, name: "keep", mode: "Strict" });
  const c3 = con.cue(9060, 3, 1);
  const { result, isError } = await store({ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4", { name: "Red", selection_mode: "normal", enabled: false })] }, { cue: 3, part: 1, lines: [line(908, "1.11")] }] });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.commands, ["Assign Group 908 At Sequence 9060 Cue 1 Part 0.2", "Assign Preset 4.4 At Sequence 9060 Cue 1 Part 0.2", "Assign Group 908 At Sequence 9060 Cue 3 Part 1.1", "Assign Preset 1.11 At Sequence 9060 Cue 3 Part 1.1"]);
  // Disabled before its values (as gma3_edit_recipe adds a line), then the other fields.
  assert.deepEqual(sets(), ["Sequence 9060 Cue 1 Part 0.2 Enabled=No", "Sequence 9060 Cue 1 Part 0.2 SelectionMode=Normal", "Sequence 9060 Cue 1 Part 0.2 Name=Red"]);
  assert.deepEqual(c1.lines.map((l) => l.name), ["keep", "Red"]);
  assert.equal(c3.lines.length, 1);
  assert.match(result.items[0].summary, /1 line\(s\) appended after 1; 2 line\(s\) read back, matched/);
});

test("the per-line MAtricks and fade columns are written and read back", async () => {
  con.cue(9060, 1);
  const { result, isError } = await store({ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4", { x: { blocks: 3, select: 2, wings: 2, groups: 4, fade: { from: 16, to: 16 } } }), line(908, "1.11", { x: { select: null }, y: { delay: { from: 0, to: 1.5 } } })] }] });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(sets(), [
    "Sequence 9060 Cue 1 Part 0.1 XWings=2",
    "Sequence 9060 Cue 1 Part 0.1 XBlock=3",
    "Sequence 9060 Cue 1 Part 0.1 XGroup=4",
    "Sequence 9060 Cue 1 Part 0.1 FadeFromX=16",
    "Sequence 9060 Cue 1 Part 0.1 FadeToX=16",
    "Sequence 9060 Cue 1 Part 0.1 X=2",
    "Sequence 9060 Cue 1 Part 0.2 X=None",
    "Sequence 9060 Cue 1 Part 0.2 DelayFromY=0",
    "Sequence 9060 Cue 1 Part 0.2 DelayToY=1.5",
  ]);
  assert.deepEqual(con.part(9060, 1).lines[0].props, { XWings: "2", XBlock: "3", XGroup: "4", FadeFromX: "16.00", FadeToX: "16.00", X: "2" });
  // The columns are read back in the display role, once per cue part.
  assert.equal(h.fake.requests.filter((r) => r.op === "children" && r.args.asText !== false).length, 1);
});

test("a column the console keeps is a failed step; one that reads back otherwise is a mismatch", async () => {
  con.cue(9060, 1);
  con.ignoreSet.add("XBlock");
  const kept = await store({ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4", { x: { blocks: 3 } })] }] });
  assert.equal(kept.isError, true);
  assert.equal(kept.result.outcome, "partial");
  assert.match(kept.result.items[0].summary, /stopped at step 'line_1_XBlock' \(failed: XBlock reads "None" after the write\)/);
  con.ignoreSet.clear();
  con.strayLine = true;
  const stray = await store({ mode: "append", cues: [{ cue: 1, lines: [line(908, "1.11")] }] });
  assert.equal(stray.result.verification.status, "mismatched");
  assert.match(stray.result.items[0].summary, /mismatched: 3 line\(s\), 2 expected/);
});

test("missing groups, presets, MAtricks and cues are refused before anything is sent", async () => {
  con.cue(9060, 1);
  const { result, isError } = await store({ mode: "append", cues: [{ cue: 1, lines: [line(999, "4.4"), line(908, "4.99"), line(908, "4.4", { matricks: 77 }), line(999, "1.11")] }] });
  assert.equal(isError, true);
  assert.match(stepError(result, "check_references"), /not in the show: Group 999 \(first used by cues\[0\]\.lines\[0\]\), Preset 4\.99 \(first used by cues\[0\]\.lines\[1\]\), MAtricks 77/);
  assert.equal(h.fake.requests.filter((r) => r.op === "group.read" && r.args.ref === "Group 999").length, 1, "each reference is checked once");
  const missing = await store({ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4")] }, { cue: 5, lines: [line(908, "4.4")] }] });
  assert.match(stepError(missing.result, "read_cues"), /not in the show: Sequence 9060 Cue 5 Part 0 \(store the cues first with gma3_store_cues/);
  // replace would delete a phaser line the tool cannot write back.
  con.part(9060, 1).lines.push({ cls: "PhaserRecipe", group: null, preset: null, matricks: null, enabled: true, name: "", mode: "Strict" });
  const phaser = await store({ mode: "replace", cues: [{ cue: 1, lines: [line(908, "4.4")] }] });
  assert.match(stepError(phaser.result, "read_cues"), /replace would delete lines this tool does not write: Sequence 9060 Cue 1 Part 0 \(line 1 PhaserRecipe\)/);
  assert.deepEqual(con.commands, []);
  assert.deepEqual(sets(), []);
});

test("cue names and notes are written and read back exactly", async () => {
  con.cue(9060, 1);
  con.cue(9060, 2);
  const note = 'genres ABC | ch 1,2,3 | motif "gears" | bank A';
  const { result, isError } = await store({ mode: "append", cues: [{ cue: 1, name: "Gears Turn", note, lines: [line(908, "4.4")] }, { cue: 2, note: "", lines: [line(908, "4.4")] }] });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.cues.get("Sequence 9060 Cue 1"), { name: "Gears Turn", note });
  assert.ok(sets().includes("Sequence 9060 Cue 1 Part 0 Name=Gears Turn"), "the name goes on Part 0");
  assert.ok(sets().includes(`Sequence 9060 Cue 1 Note=${note}`), "the note on the cue object");
  // A console that changes the note (here: its case) is a mismatch, not a match.
  con.noteRead = (n) => n.toUpperCase();
  const changed = await store({ mode: "append", cues: [{ cue: 1, note: "bank b", lines: [line(908, "4.4")] }] });
  assert.equal(changed.result.verification.status, "mismatched");
  assert.match(changed.result.items[0].summary, /the cue's note reads "BANK B"/);
});

test("a failure mid-batch reports what was written; an unanswered request stops the rest; nothing is retried or cooked", async () => {
  for (const c of [1, 2, 3]) con.cue(9060, c);
  con.reject = /^Assign Preset 1\.11 At Sequence 9060 Cue 2 Part 0\.2$/;
  const cues = [1, 2, 3].map((c) => ({ cue: c, lines: [line(908, "4.4"), line(908, "1.11")] }));
  const { result, isError } = await store({ mode: "append", cues, cook: "merge_low_priority" });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.items.map((i: { outcome: string }) => i.outcome), ["succeeded", "partial", "succeeded"], "cue 3 is independent of cue 2");
  assert.match(result.items[1].summary, /stopped at step 'line_2_values' \(failed: console rejected the command: Illegal object\); 3 step\(s\) before it were sent and stay \(nothing is undone or retried\); 2 line\(s\) read back/);
  assert.equal(con.part(9060, 2).lines.length, 2, "the line whose values failed stays (no clean-up)");
  assert.equal(con.commands.filter((c) => c === "Assign Preset 1.11 At Sequence 9060 Cue 2 Part 0.2").length, 1, "never retried");
  assert.ok(!con.commands.some((c) => c.startsWith("Cook")), "no cook after a failed cue part");
  assert.match(result.summary, /Not cooked: not every cue part was written and read back as asked/);

  // An unanswered request: the rest of the call is not attempted.
  h.fake.requests.length = 0;
  con.commands = [];
  con.reject = undefined;
  con.silentSet = /^Sequence 9060 Cue 2 Part 0\.3 Name$/;
  const silent = await store({ mode: "append", cues: cues.map((c) => ({ ...c, lines: [line(908, "4.4", { name: "n" })] })) });
  assert.equal(silent.result.outcome, "partial");
  assert.deepEqual(silent.result.items.map((i: { outcome: string }) => i.outcome), ["succeeded", "partial", "not_attempted"]);
  assert.match(silent.result.items[2].summary, /not attempted: item 2 .* has a step without a reply/);
  assert.ok(!con.commands.some((c) => c.includes("Cue 3")), "nothing sent for cue 3");
});

test("cook: every written cue part is cooked with gma3_cook_recipes afterwards", async () => {
  con.cue(9060, 1);
  con.cue(9060, 2);
  const { result, isError } = await store({ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4")] }, { cue: 2, lines: [line(908, "1.11")] }], cook: "merge_low_priority" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(con.commands.filter((c) => c.startsWith("Cook")), ["Cook Sequence 9060 Cue 1 Part 0 /MergeLowPriority", "Cook Sequence 9060 Cue 2 Part 0 /MergeLowPriority"]);
  assert.deepEqual(result.cook.map((c: { target: string; outcome: string; verification: string }) => `${c.target} ${c.outcome} ${c.verification}`), ["Sequence 9060 Cue 1 Part 0 succeeded matched", "Sequence 9060 Cue 2 Part 0 succeeded matched"]);
  assert.match(result.summary, /Cook \(merge_low_priority\): 2 of 2 cue part\(s\) cooked\./);
  // overwrite over uncooked data is refused per part unless replace_uncooked: the writes stay, the call is partial.
  con.part(9060, 1).rows.push({ fixture: "404", sfIndex: 66, attribute: "Dimmer", value: 70, cooked: false });
  con.commands = [];
  const refused = await store({ mode: "replace", cues: [{ cue: 1, lines: [line(908, "4.4")] }], cook: "overwrite" });
  assert.equal(refused.result.outcome, "partial");
  assert.match(refused.result.cook[0].summary, /overwrite would delete uncooked values/);
  assert.ok(!con.commands.some((c) => c.startsWith("Cook")));
  const allowed = await store({ mode: "replace", cues: [{ cue: 1, lines: [line(908, "4.4")] }], cook: "overwrite", replace_uncooked: true, verify_cook: false });
  assert.equal(allowed.result.outcome, "succeeded", JSON.stringify(allowed.result.summary));
  assert.ok(con.commands.includes("Cook Sequence 9060 Cue 1 Part 0 /Overwrite"));
});

test("preview checks and plans without sending; detail lists every request", async () => {
  con.cue(9060, 1).lines.push({ cls: "StandardRecipe", group: 908, preset: "14.14.1.5.4.4", matricks: null, enabled: true, name: "", mode: "Strict" });
  const { result } = await store({ mode: "replace", preview: true, detail: true, cues: [{ cue: 1, note: "n", lines: [line(908, "1.11", { x: { blocks: 2 } })] }] });
  assert.equal(result.preview, true);
  assert.deepEqual(result.plan[0].sends, ["Delete Sequence 9060 Cue 1 Part 0.1 /NoConfirmation", "Assign Group 908 At Sequence 9060 Cue 1 Part 0.1", "Assign Preset 1.11 At Sequence 9060 Cue 1 Part 0.1", 'set Sequence 9060 Cue 1 Part 0.1 XBlock="2"', 'set Sequence 9060 Cue 1 Note="n"']);
  assert.match(result.summary, /Preview only; nothing was sent\. 1 cue part\(s\), 1 line\(s\) to write in place of the existing ones, 5 request\(s\)/);
  assert.deepEqual(con.commands, []);
  assert.deepEqual(sets(), []);
});

test("the call is validated as a whole before anything is read", async () => {
  for (const [args, re] of [
    [{ mode: "append", cues: [{ cue: 1, lines: [{ selection: 908, values: "4.4", xblock: 2 }] }] }, /cues\[0\]\.lines\[0\]: xblock is not a line field .*x: \{blocks: 3/],
    [{ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4", { x: { block: 2 } })] }] }, /cues\[0\]\.lines\[0\]\.x\.block is not a MAtricks axis setting \(wings, .*, select\)/],
    [{ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4", { x: { blocks: 1.5 } })] }] }, /cues\[0\]\.lines\[0\]\.x\.blocks must be an integer/],
    [{ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4", { y: { select: -1 } })] }] }, /cues\[0\]\.lines\[0\]\.y\.select must be/],
    [{ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4")] }, { cue: 1, lines: [line(908, "4.4")] }] }, /Sequence 9060 Cue 1 Part 0 is listed more than once/],
    [{ mode: "append", cues: [{ cue: 1, lines: [] }] }, /cues\[0\]\.lines must be a non-empty list/],
    [{ mode: "append", cues: [{ cue: 1, lines: [line(908, "4.4")] }], replace_uncooked: true }, /replace_uncooked and verify_cook go with cook/],
    [{ mode: "append", cues: [{ cue: 1, note: "a\nb", lines: [line(908, "4.4")] }] }, /cues\[0\]\.note must be one line/],
    [{ mode: "append", cues: Array.from({ length: 3 }, (_, i) => ({ cue: i + 1, lines: Array.from({ length: 200 }, () => line(908, "4.4")) })) }, /at most 500 recipe lines per call \(got 600\)/],
  ] as const) {
    const { result, isError } = await store(args as Record<string, unknown>);
    assert.equal(isError, true);
    assert.match(result.validationErrors?.join(" | ") ?? JSON.stringify(result), re);
  }
  assert.equal(h.fake.requests.length, 0);
});

test("values: a number or a quoted string is refused with the plain string form it should be", async () => {
  con.part(9060, 1);
  const num = await edit({ action: "add", selection: 908, values: 4.2 });
  assert.match(num.result.validationErrors.join(), /values must be the plain string "4\.2" \("<pool>\.<number>"\), not a number: as numbers 4\.20 and 4\.2 are the same/);
  const int = await edit({ action: "add", selection: 908, values: 4 });
  assert.match(int.result.validationErrors.join(), /values must be the plain string "<pool>\.<number>" such as "4\.2", not a number/);
  const quoted = await edit({ action: "add", selection: 908, values: '"4.2"' });
  assert.match(quoted.result.validationErrors.join(), /values must be the plain string "4\.2", without quotes inside it \(got "\\"4\.2\\""\)/);
  const inBatch = await store({ mode: "append", cues: [{ cue: 1, lines: [{ selection: 908, values: 4.2 }] }] });
  assert.match(inBatch.result.validationErrors.join(), /cues\[0\]\.lines\[0\]\.values must be the plain string "4\.2"/);
  assert.equal(h.fake.requests.length, 0);
});

test("a line whose X column selects one block is not predicted, so the cook is not a false mismatch; an ordinary line still is", async () => {
  con.groups.set(912, [401, 402, 403, 404].map((f, i) => ({ fixture: String(f), sfIndex: 63 + i })));
  con.cue(9060, 1);
  con.cue(9060, 2);
  const { result, isError } = await store({ mode: "append", cook: "merge_low_priority", cues: [{ cue: 1, lines: [line(912, "4.4", { x: { blocks: 2, select: 1 } })] }, { cue: 2, lines: [line(912, "4.4")] }] });
  assert.equal(isError, false, JSON.stringify(result.verification));
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(result.cook.map((c: { verification: string }) => c.verification), ["matched", "matched"]);
  assert.deepEqual(con.part(9060, 1).rows.map((r) => r.fixture), ["401", "402"], "the console cooked the first block only");
  assert.ok(result.warnings.some((w: string) => /Cue 1 Part 0 line 1: the line's MAtricks selects part of its group \(X 1\); coverage not predicted/.test(w)), JSON.stringify(result.warnings));
  // gma3_recipes and gma3_cook_recipes flag it the same way; the ordinary line is predicted and verified.
  const read1 = await h.callJson("gma3_recipes", { target: { sequence: 9060, cue: 1 } });
  assert.equal(read1.result.lines[0].axisSelect, "X 1");
  assert.match(read1.result.lines[0].notPredicted, /selects part of its group \(X 1\); coverage not predicted/);
  assert.equal(read1.result.expectedPairs, 0);
  assert.equal(read1.result.unpredictedLines, 1);
  const read2 = await h.callJson("gma3_recipes", { target: { sequence: 9060, cue: 2 } });
  assert.equal(read2.result.lines[0].notPredicted, undefined);
  assert.equal(read2.result.expectedPairs, 4);
  const c1 = await h.callJson("gma3_cook_recipes", { target: { sequence: 9060, cue: 1 }, mode: "merge_low_priority" });
  assert.equal(c1.result.verification.status, "matched", JSON.stringify(c1.result.verification));
  assert.match(c1.result.affected[0].lines[0].notPredicted, /X 1/);
  assert.match(c1.result.verification.checked, /1 line\(s\) not predicted/);
  // A cook that loses the ordinary line's output is still caught.
  con.cookNoop = true;
  con.part(9060, 2).rows = [];
  const c2 = await h.callJson("gma3_cook_recipes", { target: { sequence: 9060, cue: 2 }, mode: "merge_low_priority" });
  assert.equal(c2.result.verification.status, "mismatched");
  assert.match(c2.result.verification.detail, /expected cooked values missing/);
});

test("axisSelection: a set X / Y / Z column, None and 0 select nothing, an inherited one counts", () => {
  assert.equal(axisSelection({ X: "None", Y: "", Z: 0 }), undefined);
  assert.equal(axisSelection({}), undefined);
  assert.equal(axisSelection({ X: 2 }), "X 2");
  assert.equal(axisSelection({ X: "<3>", Z: "1" }), "X 3, Z 1");
});
