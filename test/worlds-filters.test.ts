import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import { decodeAttributes, encodeAttributes, objectRef, parseColor, parseTargetObject, setTaken, registerWorldFilterTools, resolveAttributes, type AttributeCatalog } from "../src/tools/worldsfilters.ts";

/** Attribute definitions as in a small show: index (1-based), name, feature. */
const ATTRS: Array<[number, string, string]> = [
  [1, "Dimmer", "Dimmer"],
  [2, "Pan", "Position"],
  [3, "Tilt", "Position"],
  [4, "ColorRGB_R", "RGB"],
  [5, "ColorRGB_G", "RGB"],
  [6, "ColorRGB_B", "RGB"],
  [7, "Gobo1", "Gobo1"],
];
const GROUPS: Record<string, string[]> = { Dimmer: ["Dimmer"], Position: ["Position"], Color: ["RGB"], Gobo: ["Gobo1"] };

interface Obj {
  class: string;
  name: string;
  lock?: string;
  fields: Record<string, unknown>;
}

/**
 * A console with filters, appearances, an image, groups and views. Store Filter takes the At Filter (every attribute,
 * every layer; optionally dynamic rules), Store Appearance makes an empty appearance, Assign Image sets an
 * appearance's image, Assign Appearance sets an object's appearance; set writes a property as text.
 */
class Console {
  objects = new Map<string, Obj>();
  atFilterDynamic = false;
  /** Properties the console does not take (set answers but keeps the old value). */
  ignoreSet = new Set<string>();
  /** Properties whose read-back after a set fails (readOk false, no value). */
  unreadableSet = new Set<string>();
  /** A command that opens a dialog. */
  dialogAfter?: RegExp;
  dialogOpen = false;
  attributesUnreadable = false;
  selectionUnreadable = false;
  viewsUnlistable = false;
  /** Attributes whose Feature read fails (fieldErrors.Feature). */
  featureUnreadable = new Set<string>();
  /** Feature groups whose features cannot be listed. */
  groupUnlistable = new Set<string>();

  constructor() {
    this.objects.set("Filter 1", { class: "Filter", name: "All", fields: { Attributes: "All", Absolute: "Yes", Relative: "Yes", Timing: "Yes", Phaser: "Yes", HasDynamicFilterRules: "No" } });
    this.objects.set("Filter 3", { class: "Filter", name: "Only Dimmer", fields: { Attributes: "1000000", Absolute: "Yes", Relative: "Yes", Timing: "Yes", Phaser: "Yes", HasDynamicFilterRules: "No" } });
    this.objects.set("Filter 4", { class: "Filter", name: "Locked one", lock: "UL", fields: { Attributes: "All", Absolute: "Yes", Relative: "Yes", Timing: "Yes", Phaser: "Yes", HasDynamicFilterRules: "No" } });
    this.objects.set("World 1", { class: "World", name: "All", lock: "SL", fields: { Attributes: "All", SelectionData: "" } });
    this.objects.set("Appearance 1", { class: "Appearance", name: "Macro", fields: { Image: "[macro_png]", ImageMode: "Bar", BackR: "0", BackG: "0", BackB: "0", BackAlpha: "0" } });
    this.objects.set("Image 3.2", { class: "UserImage", name: "[logo_png]", fields: {} });
    this.objects.set("Group 3", { class: "Group", name: "Front", fields: { Appearance: null } });
    this.objects.set("Group 4", { class: "Group", name: "Back", fields: { Appearance: null } });
    this.objects.set("View 2", { class: "View", name: "Preset", fields: { Appearance: "" } });
  }

  addr(ref: string) {
    return `addr:${ref}`;
  }

  row(ref: string, fields: string[], asText: boolean) {
    const o = this.objects.get(ref)!;
    const f: Record<string, unknown> = {};
    const errs: Record<string, unknown> = {};
    for (const k of fields) {
      if (k === "Name") f.Name = o.name;
      else if (k === "Lock") f.Lock = o.lock ?? "";
      else if (k === "No") f.No = ref.split(/[ .]/).pop();
      else if (k === "Attributes" && this.attributesUnreadable) errs.Attributes = "read failed";
      else if (k === "SelectionData" && this.selectionUnreadable) errs.SelectionData = "read failed";
      else if (k === "Appearance") {
        const a = o.fields.Appearance as string | null;
        if (a && this.objects.has(a)) f.Appearance = asText ? this.objects.get(a)!.name : { name: this.objects.get(a)!.name, addr: this.addr(a), class: "Appearance" };
        else if (o.fields.Appearance !== undefined) f.Appearance = asText ? "" : null;
      } else if (k in o.fields) f[k] = o.fields[k];
    }
    return { name: o.name, class: o.class, addr: this.addr(ref), index: Number(ref.split(/[ .]/).pop()), fields: f, ...(Object.keys(errs).length ? { fieldErrors: errs } : {}) };
  }

  objectsOf(ref: string, fields: string[], asText: boolean) {
    const range = ref.match(/^(\w+) Thru$/);
    const named = ref.match(/^(\w+) "([^"]+)"$/);
    const keys = range
      ? [...this.objects.keys()].filter((k) => k.startsWith(`${range[1]} `))
      : named
        ? [...this.objects.keys()].filter((k) => k.startsWith(`${named[1]} `) && this.objects.get(k)!.name === named[2])
        : this.objects.has(ref)
          ? [ref]
          : [];
    if (!keys.length) throw new Error("no objects found");
    const items = keys.map((k) => this.row(k, fields, asText));
    return { total: items.length, offset: 0, count: items.length, items };
  }

  children(ref: string) {
    if (ref === "ShowData.LivePatch.AttributeDefinitions.Attributes")
      return {
        total: ATTRS.length,
        items: ATTRS.map(([i, n, f]) => (this.featureUnreadable.has(n) ? { name: n, index: i, fields: { Name: n }, fieldErrors: { Feature: "read failed" } } : { name: n, index: i, fields: { Name: n, Feature: f } })),
      };
    if (ref === "ShowData.LivePatch.AttributeDefinitions.FeatureGroups") return { total: 4, items: Object.keys(GROUPS).map((g, i) => ({ name: g, index: i + 1, addr: `fg:${g}`, fields: { Name: g } })) };
    const fg = ref.match(/^fg:(\w+)$/);
    if (fg && this.groupUnlistable.has(fg[1])) return { total: 0, items: [], enumerationError: "Children() raised" };
    if (fg) return { total: GROUPS[fg[1]].length, items: GROUPS[fg[1]].map((f, i) => ({ name: f, index: i + 1, fields: { Name: f } })) };
    const pool = { "DataPool.Filters": "Filter", "ShowData.Appearances": "Appearance" }[ref];
    if (pool) {
      const items = [...this.objects.keys()].filter((k) => k.startsWith(`${pool} `)).map((k) => ({ name: this.objects.get(k)!.name, addr: this.addr(k), fields: { No: k.split(" ")[1], Name: this.objects.get(k)!.name } }));
      return { total: items.length, items };
    }
    if (ref === "addr:View 2" && this.viewsUnlistable) return { total: 0, items: [], enumerationError: "Children() raised" };
    if (ref === "addr:View 2") return { total: 2, items: [{ name: "WindowPresetPool", fields: { Name: "WindowPresetPool", X: "0", Y: "0", W: "36", H: "6" } }, { name: "WindowGroupPool", fields: { Name: "WindowGroupPool", X: "0", Y: "14", W: "36", H: "6" } }] };
    throw new Error(`path not found: ${ref}`);
  }

  set(ref: string, property: string, value: string) {
    const o = this.objects.get(ref);
    if (!o) throw new Error(`object not found: ${ref}`);
    if (!this.ignoreSet.has(property)) {
      // A filter passing every attribute reads "All".
      o.fields[property] = property === "Attributes" && /^1+$/.test(value) ? "All" : value;
    }
    if (this.unreadableSet.has(property)) return { ref, property, readOk: false, readError: "read failed" };
    return { ref, property, value: o.fields[property], readOk: true };
  }

  command(cmd: string): string {
    if (this.dialogAfter?.test(cmd)) this.dialogOpen = true;
    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^Store Filter (\d+)(?: "([^"]*)")? \/NoConfirmation$/))) {
      this.objects.set(`Filter ${m[1]}`, { class: "Filter", name: m[2] ?? `Filter ${m[1]}`, fields: { Attributes: "All", Absolute: "Yes", Relative: "No", Timing: "Yes", Phaser: "Yes", HasDynamicFilterRules: this.atFilterDynamic ? "Yes" : "No" } });
      return "OK";
    }
    if ((m = cmd.match(/^Store Appearance (\d+) \/NoConfirmation$/))) {
      this.objects.set(`Appearance ${m[1]}`, { class: "Appearance", name: `Appearance ${m[1]}`, fields: { Image: "", ImageMode: "Stretch", BackR: "0", BackG: "0", BackB: "0", BackAlpha: "0" } });
      return "OK";
    }
    if ((m = cmd.match(/^Label (\w+ \d+) "([^"]*)"$/))) {
      const o = this.objects.get(m[1]);
      if (!o) return "Error";
      o.name = m[2];
      return "OK";
    }
    if ((m = cmd.match(/^Assign (Image \d+\.\d+) At (Appearance \d+)$/))) {
      const img = this.objects.get(m[1]);
      const a = this.objects.get(m[2]);
      if (!img || !a) return "Error";
      a.fields.Image = img.name;
      return "OK";
    }
    if ((m = cmd.match(/^Assign (Appearance \d+) At (\w+ (?:[\d.]+|"[^"]+"))$/))) {
      const byName = m[2].match(/^(\w+) "([^"]+)"$/);
      const key = byName ? [...this.objects.keys()].find((k) => k.startsWith(`${byName[1]} `) && this.objects.get(k)!.name === byName[2]) : m[2];
      const o = key ? this.objects.get(key) : undefined;
      if (!o || !this.objects.has(m[1])) return "Error";
      o.fields.Appearance = m[1];
      return "OK";
    }
    return "Syntax Error";
  }
}

let h: Harness;
let c: Console;

function install() {
  h.fake.reset();
  c = new Console();
  h.fake.on("objects", (a) => c.objectsOf(String(a.ref), (a.fields as string[]) ?? [], a.asText !== false));
  h.fake.on("children", (a) => c.children(String(a.ref)));
  h.fake.on("set", (a) => c.set(String(a.ref), String(a.property), String(a.value)));
  h.fake.on("dialog.read", () => ({ open: c.dialogOpen, modal: c.dialogOpen ? { class: "PopupInput", title: "Select Appearance", buttons: [] } : false }));
  h.fake.on("cmd", (a) => ({ command: a.command, feedback: c.command(String(a.command)) }));
}

before(async () => {
  h = await startHarness(registerWorldFilterTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => install());

const catalog = (): AttributeCatalog => {
  const byIndex = new Map(ATTRS.map(([i, n, f]) => [i, { name: n, feature: f, group: Object.keys(GROUPS).find((g) => GROUPS[g].includes(f)) }]));
  const groups = new Map(Object.entries(GROUPS).map(([g, fs]) => [g.toLowerCase(), { name: g, indices: ATTRS.filter(([, , f]) => fs.includes(f)).map(([i]) => i) }]));
  return { count: ATTRS.length, byIndex, byName: new Map(ATTRS.map(([i, n]) => [n.toLowerCase(), i])), groups, groupGaps: [] };
};

test("attribute strings: one character per definition, All is every one; names and feature groups resolve, unknown ones are errors", () => {
  assert.deepEqual([...decodeAttributes("All", 7)!], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...decodeAttributes("1000100", 7)!], [1, 5]);
  assert.equal(decodeAttributes("101", 7), null, "a string of another length is not compared");
  assert.equal(decodeAttributes(undefined, 7), null);
  assert.equal(encodeAttributes(new Set([1, 5]), 7), "1000100");
  const r = resolveAttributes(catalog(), ["Dimmer"], ["color"], ["ColorRGB_B"]);
  assert.deepEqual([...r.indices].sort(), [1, 4, 5]);
  assert.deepEqual(r.errors, []);
  const bad = resolveAttributes(catalog(), ["Zoom"], ["Beam"], []);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors.join(";"), /"Beam" does not exist .*Dimmer, Position, Color, Gobo/);
  assert.deepEqual(parseColor("c", "#FF8000"), [255, 128, 0]);
  assert.throws(() => parseColor("c", "red"), /#RRGGBB/);
  assert.equal(parseTargetObject("o", " Group  3 "), "Group 3");
  assert.throws(() => parseTargetObject("o", "Group 1 Thru 3"), /one object per item/);
  assert.throws(() => parseTargetObject("o", "Appearance 2"), /not assigned to an appearance/);
});

test("gma3_pool_details filters: attributes decoded by name and feature group, layers, locks", async () => {
  const r = await h.callJson("gma3_pool_details", { kind: "filters" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  const byNo = Object.fromEntries(r.result.filters.map((f: any) => [f.no, f]));
  assert.equal(byNo[1].attributes, "all");
  assert.deepEqual(byNo[3].attributes, { count: 1, featureGroups: ["Dimmer"], attributes: ["Dimmer"] });
  assert.deepEqual(byNo[3].layers, { absolute: true, relative: true, timing: true, phaser: true });
  assert.equal(byNo[4].locked, true);
  assert.deepEqual(h.fake.commands, [], "read-only");
});

test("gma3_pool_details appearances, worlds and views; a range of another pool is refused", async () => {
  let r = await h.callJson("gma3_pool_details", { kind: "appearances" });
  assert.deepEqual(r.result.appearances[0], { no: 1, name: "Macro", background: "#000000", backgroundAlpha: 0, image: "[macro_png]", imageMode: "Bar" });
  r = await h.callJson("gma3_pool_details", { kind: "worlds" });
  assert.deepEqual(r.result.worlds[0], { no: 1, name: "All", locked: true, attributes: "all", fixtures: "all" });
  r = await h.callJson("gma3_pool_details", { kind: "views" });
  assert.deepEqual(r.result.views[0].windows[0], { window: "WindowPresetPool", x: 0, y: 0, w: 36, h: 6 });
  r = await h.callJson("gma3_pool_details", { kind: "filters", range: "Group 1 Thru 3" });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /range must name filters/);
});

test("gma3_store_filter: a new filter is stored, then gets its attributes and every layer written; the read-back matches", async () => {
  const r = await h.callJson("gma3_store_filter", { filter: 20, name: "Colour only", feature_groups: ["Color"], attributes: ["Dimmer"], layers: { timing: false } });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ['Store Filter 20 "Colour only" /NoConfirmation']);
  const f = c.objects.get("Filter 20")!;
  assert.equal(f.fields.Attributes, "1001110");
  // The At Filter had Relative off: a new filter writes every layer.
  assert.deepEqual([f.fields.Absolute, f.fields.Relative, f.fields.Timing, f.fields.Phaser], ["Yes", "Yes", "No", "Yes"]);
});

test("gma3_store_filter: a taken number is refused unless on_taken update; a locked filter and unknown names are refused; nothing is sent", async () => {
  let r = await h.callJson("gma3_store_filter", { filter: 3, attributes: ["Pan"] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Filter 3 is taken .*on_taken \\"update\\"/);
  r = await h.callJson("gma3_store_filter", { filter: 4, attributes: ["Pan"], on_taken: "update" });
  assert.match(r.text, /Filter 4 is locked/);
  r = await h.callJson("gma3_store_filter", { filter: 21, attributes: ["Zoom"] });
  assert.match(r.text, /\\"Zoom\\" is not an attribute definition/);
  r = await h.callJson("gma3_store_filter", { filter: 21, attributes: ["Dimmer"], exclude: ["Dimmer"] });
  assert.match(r.text, /would pass no attribute/);
  r = await h.callJson("gma3_store_filter", { filter: 21, name: "Only Dimmer", attributes: ["Dimmer"] });
  assert.match(r.text, /the name \\"Only Dimmer\\" is taken/);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(h.fake.requests.filter((q) => q.op === "set").length, 0);
});

test("gma3_store_filter update in place: only what was asked is written; a value the console ignores fails its set step and stops", async () => {
  let r = await h.callJson("gma3_store_filter", { filter: 3, feature_groups: ["Position"], on_taken: "update" });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, []);
  assert.deepEqual(h.fake.requests.filter((q) => q.op === "set").map((q) => q.args.property), ["Attributes"]);
  assert.equal(c.objects.get("Filter 3")!.fields.Attributes, "0110000");
  c.ignoreSet.add("Attributes");
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_store_filter", { filter: 3, attributes: ["Gobo1"], on_taken: "update", layers: { phaser: false } });
  assert.notEqual(r.result.outcome, "succeeded", r.text);
  assert.match(r.text, /the console did not take Attributes = \\"0000001\\" on Filter 3: it reads \\"0110000\\"; nothing more was sent/);
  // The layer write after it is not sent.
  assert.deepEqual(h.fake.requests.filter((q) => q.op === "set").map((q) => q.args.property), ["Attributes"]);
});

test("gma3_store_filter: dynamic rules carried from the At Filter are reported; an unreadable read-back is unavailable, not matched", async () => {
  c.atFilterDynamic = true;
  let r = await h.callJson("gma3_store_filter", { filter: 22, attributes: ["Dimmer"] });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.match(JSON.stringify(r.result.warnings), /dynamic filter rules .*At Filter/);
  c.attributesUnreadable = true;
  r = await h.callJson("gma3_store_filter", { filter: 23, attributes: ["Dimmer"] });
  assert.equal(r.result.verification.status, "unavailable", r.text);
});

test("gma3_store_filter: an open dialog refuses before anything is sent; preview sends nothing", async () => {
  c.dialogOpen = true;
  let r = await h.callJson("gma3_store_filter", { filter: 24, attributes: ["Dimmer"] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /a dialog is open/);
  assert.deepEqual(h.fake.commands, []);
  c.dialogOpen = false;
  r = await h.callJson("gma3_store_filter", { filter: 24, attributes: ["Dimmer"], preview: true });
  assert.equal(r.result.preview, true);
  assert.equal(r.result.plan.length, 6, r.text);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(c.objects.has("Filter 24"), false);
});

test("gma3_store_filter batch: one line per filter; a filter in two items is refused", async () => {
  let r = await h.callJson("gma3_store_filter", { filters: [{ filter: 30, attributes: ["Dimmer"] }, { filter: 31, feature_groups: ["Position"] }] });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.items.length, 2);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_store_filter", { filters: [{ filter: 32, attributes: ["Dimmer"] }, { filter: 32, attributes: ["Pan"] }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Filter 32 is in more than one item/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_set_appearance: create with colour and image, assign to a group; read back by handle", async () => {
  const r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: 20, create: { name: "Warm", color: "#FF8000", image: "Image 3.2", image_mode: "crop" } });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Store Appearance 20 /NoConfirmation", 'Label Appearance 20 "Warm"', "Assign Image 3.2 At Appearance 20", "Assign Appearance 20 At Group 3"]);
  const a = c.objects.get("Appearance 20")!;
  assert.deepEqual([a.fields.BackR, a.fields.BackG, a.fields.BackB, a.fields.BackAlpha, a.fields.ImageMode, a.fields.Image], ["255", "128", "0", "255", "Crop", "[logo_png]"]);
  assert.equal(c.objects.get("Group 3")!.fields.Appearance, "Appearance 20");
});

test("gma3_set_appearance: an existing appearance is assigned as is; a taken create, a missing appearance or image, a locked object are refused", async () => {
  let r = await h.callJson("gma3_set_appearance", { object: "Group 4", appearance: 1 });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Assign Appearance 1 At Group 4"]);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_set_appearance", { appearance: 1, create: { color: "#00FF00" } });
  assert.match(r.text, /Appearance 1 is taken/);
  r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: 9 });
  assert.match(r.text, /Appearance 9 does not exist; give create/);
  r = await h.callJson("gma3_set_appearance", { appearance: 21, create: { image: "Image 3.9" } });
  assert.match(r.text, /Image 3.9 does not exist/);
  c.objects.get("Group 3")!.lock = "UL";
  r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: 1 });
  assert.match(r.text, /Group 3 is locked/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_set_appearance: an assignment the console ignores is a mismatch; a dialog that opens stops the rest", async () => {
  c.command = ((orig) => (cmd: string) => (/^Assign Appearance/.test(cmd) ? "OK" : orig(cmd)))(c.command.bind(c));
  let r = await h.callJson("gma3_set_appearance", { object: "Group 4", appearance: 1 });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /Group 4 reads no appearance/);
  install();
  c.dialogAfter = /^Assign Image/;
  r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: 22, create: { image: "Image 3.2" } });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.match(r.text, /a dialog is open on the console .*Select Appearance/);
  assert.deepEqual(h.fake.commands, ["Store Appearance 22 /NoConfirmation", "Assign Image 3.2 At Appearance 22"]);
});

test("gma3_set_appearance batch: an appearance created in two items is refused; one appearance to several objects goes", async () => {
  let r = await h.callJson("gma3_set_appearance", { assignments: [{ object: "Group 3", appearance: 1 }, { object: "Group 4", appearance: 1 }] });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.deepEqual(h.fake.commands, ["Assign Appearance 1 At Group 3", "Assign Appearance 1 At Group 4"]);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_set_appearance", { assignments: [{ appearance: 25, create: { color: "#000000" } }, { appearance: 25, create: { color: "#FFFFFF" } }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /appearance 25 is created or changed by more than one item/);
  assert.deepEqual(h.fake.commands, []);
});

test("validation: nothing to do, create on a named appearance, bad colour and alpha are refused", async () => {
  let r = await h.callJson("gma3_set_appearance", { appearance: 1 });
  assert.match(r.text, /nothing to do/);
  r = await h.callJson("gma3_set_appearance", { appearance: "Macro", create: { color: "#000000" } });
  assert.match(r.text, /give appearance as a number/);
  r = await h.callJson("gma3_set_appearance", { appearance: 30, create: { color: "blue", alpha: 150 } });
  assert.match(r.text, /#RRGGBB/);
  assert.match(r.text, /percentage from 0 to 100/);
  r = await h.callJson("gma3_store_filter", { filter: 40 });
  assert.match(r.text, /needs attributes or feature_groups/);
  assert.deepEqual(h.fake.commands, []);
  void SILENT;
});

test("feature groups fail closed (#161 review): an unreadable attribute Feature or feature listing refuses feature_groups before anything is sent; named attributes still store", async () => {
  c.featureUnreadable.add("ColorRGB_G");
  let r = await h.callJson("gma3_store_filter", { filter: 9, feature_groups: ["Color"] });
  assert.equal(r.result.outcome, "failed", r.text);
  assert.match(r.text, /members of the feature groups cannot be established in full .*the feature of attribute ColorRGB_G could not be read \(read failed\)/);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(h.fake.requests.filter((q) => q.op === "set").length, 0);
  r = await h.callJson("gma3_store_filter", { filter: 9, attributes: ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.equal(c.objects.get("Filter 9")!.fields.Attributes, "0001110");
  // A reader does not claim a group it cannot establish in full.
  r = await h.callJson("gma3_pool_details", { kind: "filters", range: "Filter 9" });
  assert.equal(r.result.filters[0].attributes.featureGroups, undefined, r.text);
  install();
  c.groupUnlistable.add("Color");
  r = await h.callJson("gma3_store_filter", { filter: 10, feature_groups: ["Position"] });
  assert.equal(r.result.outcome, "failed", r.text);
  assert.match(r.text, /the features of feature group Color could not be listed/);
  assert.deepEqual(h.fake.commands, []);
});

test("assignments depend on the appearance they assign (#161 review): a failed create skips them; a failed assignment does not skip other assignments of it", async () => {
  c.ignoreSet.add("BackR");
  let r = await h.callJson("gma3_set_appearance", { assignments: [{ appearance: 26, create: { color: "#FF0000" } }, { object: "Group 3", appearance: "26" }] });
  assert.notEqual(r.result.items[0].outcome, "succeeded", r.text);
  assert.equal(r.result.items[1].outcome, "not_attempted", r.text);
  assert.match(r.result.items[1].summary, /item 1 on appearance 26 did not succeed/);
  assert.equal(h.fake.commands.some((x) => x.startsWith("Assign Appearance")), false);
  install();
  c.objects.get("Group 3")!.lock = "UL";
  r = await h.callJson("gma3_set_appearance", { assignments: [{ object: "Group 3", appearance: 1 }, { object: "Group 4", appearance: 1 }] });
  assert.equal(r.result.items[0].outcome, "failed", r.text);
  assert.equal(r.result.items[1].outcome, "succeeded", r.text);
  assert.deepEqual(h.fake.commands, ["Assign Appearance 1 At Group 4"]);
});

test("the assigned object must be exactly one object (#161 review): wildcards are refused, a name two objects have is refused", async () => {
  let r = await h.callJson("gma3_set_appearance", { object: 'Group "Front*"', appearance: 1 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /wildcards/);
  c.objects.get("Group 4")!.name = "Front";
  r = await h.callJson("gma3_set_appearance", { object: 'Group "Front"', appearance: 1 });
  assert.equal(r.result.outcome, "failed", r.text);
  assert.match(r.text, /Group \\"Front\\" names 2 objects/);
  c.objects.set("Appearance 2", { class: "Appearance", name: "Macro", fields: { Image: "", ImageMode: "Bar", BackR: "0", BackG: "0", BackB: "0", BackAlpha: "0" } });
  r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: "Macro" });
  assert.match(r.text, /names 2 appearances; give it by number/);
  assert.deepEqual(h.fake.commands, []);
});

test("#161 review: on_taken update on a free filter still needs attributes; quoted names keep their spaces; numeric appearance aliases are one appearance", async () => {
  let r = await h.callJson("gma3_store_filter", { filter: 20, name: "Colour", on_taken: "update" });
  assert.equal(r.result.outcome, "failed", r.text);
  assert.match(r.text, /Filter 20 is free, so it would be stored new from the At Filter: give attributes or feature_groups/);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(c.objects.has("Filter 20"), false);

  assert.equal(parseTargetObject("o", '  Group   "Front  Wash" '), 'Group "Front  Wash"');
  c.objects.set("Group 5", { class: "Group", name: "Front  Wash", fields: { Appearance: null } });
  c.objects.set("Group 6", { class: "Group", name: "Front Wash", fields: { Appearance: null } });
  r = await h.callJson("gma3_set_appearance", { object: 'Group "Front  Wash"', appearance: 1 });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ['Assign Appearance 1 At Group "Front  Wash"']);
  assert.equal(c.objects.get("Group 5")!.fields.Appearance, "Appearance 1");
  assert.equal(c.objects.get("Group 6")!.fields.Appearance, null);

  install();
  c.ignoreSet.add("BackR");
  r = await h.callJson("gma3_set_appearance", { assignments: [{ appearance: 26, create: { color: "#FF0000" } }, { object: "Group 3", appearance: "026" }] });
  assert.equal(r.result.items[1].outcome, "not_attempted", r.text);
  assert.equal(h.fake.commands.some((x) => x.startsWith("Assign Appearance")), false);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_set_appearance", { assignments: [{ appearance: 27, create: { color: "#000000" } }, { appearance: "027", create: { color: "#FFFFFF" } }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /appearance 27 is created or changed by more than one item/);
  assert.equal(objectRef("group 03"), objectRef("Group 3"));
  assert.notEqual(objectRef('Group "A  B"'), objectRef('Group "A B"'));
});

test("#161 review: a world whose selection cannot be read is not reported as all fixtures; ranges keep whitespace inside quoted names", async () => {
  c.selectionUnreadable = true;
  let r = await h.callJson("gma3_pool_details", { kind: "worlds" });
  assert.equal(r.result.worlds[0].fixtures, null, r.text);
  assert.deepEqual(r.result.worlds[0].unreadable, ["SelectionData"]);
  assert.match(JSON.stringify(r.result.warnings), /World 1: SelectionData could not be read/);
  c.attributesUnreadable = true;
  r = await h.callJson("gma3_pool_details", { kind: "filters", range: "Filter 3" });
  assert.equal(r.result.filters[0].attributes, null, r.text);
  install();
  c.objects.set("Appearance 5", { class: "Appearance", name: "Front  Wash", fields: { Image: "", ImageMode: "Bar", BackR: "255", BackG: "0", BackB: "0", BackAlpha: "255" } });
  c.objects.set("Appearance 6", { class: "Appearance", name: "Front Wash", fields: { Image: "", ImageMode: "Bar", BackR: "0", BackG: "0", BackB: "255", BackAlpha: "255" } });
  r = await h.callJson("gma3_pool_details", { kind: "appearances", range: '  Appearance   "Front  Wash" ' });
  assert.equal(r.result.appearances.length, 1, r.text);
  assert.equal(r.result.appearances[0].no, 5);
  assert.equal(r.result.appearances[0].background, "#ff0000");
});

test("#161 review: a view whose windows cannot be listed reads windows: null with a warning, not an empty view", async () => {
  c.viewsUnlistable = true;
  const r = await h.callJson("gma3_pool_details", { kind: "views" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.views[0].windows, null, r.text);
  assert.match(JSON.stringify(r.result.warnings), /the windows of view 2 could not be read .*Children\(\) raised/);
});

test("#161 late review: a colour the console ignores or cannot read back stops before the Assign; the object keeps its appearance", async () => {
  c.ignoreSet.add("BackR");
  let r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: 40, create: { color: "#FF8000" } });
  assert.notEqual(r.result.outcome, "succeeded", r.text);
  assert.match(r.text, /the console did not take BackR = \\"255\\" on Appearance 40: it reads \\"0\\"; nothing more was sent/);
  assert.deepEqual(h.fake.commands, ["Store Appearance 40 /NoConfirmation"]);
  assert.equal(c.objects.get("Group 3")!.fields.Appearance, null);
  install();
  c.unreadableSet.add("ImageMode");
  r = await h.callJson("gma3_set_appearance", { object: "Group 3", appearance: 1, create: { image_mode: "Tile" }, on_taken: "update" });
  assert.notEqual(r.result.outcome, "succeeded", r.text);
  assert.match(r.text, /ImageMode of Appearance 1 could not be read back \(read failed\) after the write, so whether the console took \\"Tile\\" is unknown; nothing more was sent/);
  assert.equal(r.result.steps.find((x: any) => x.name === "set_imagemode").status, "unknown");
  assert.deepEqual(h.fake.commands, []);
  assert.equal(c.objects.get("Group 3")!.fields.Appearance, null);
});

test("setTaken: All for all-ones Attributes, numbers by value, text case aside", () => {
  assert.equal(setTaken("Attributes", "1111111", "All"), true);
  assert.equal(setTaken("Attributes", "1011111", "All"), false);
  assert.equal(setTaken("BackR", "255", "255"), true);
  assert.equal(setTaken("BackR", "255", 255), true);
  assert.equal(setTaken("BackR", "255", "0"), false);
  assert.equal(setTaken("BackR", "0", ""), false);
  assert.equal(setTaken("Phaser", "No", "no"), true);
  assert.equal(setTaken("ImageMode", "Crop", "Bar"), false);
  assert.equal(setTaken("BackR", "1", undefined), false);
  // Masks are bit strings (#163 review): 356 characters would both be Infinity as numbers, 18 lose precision.
  const want = "1" + "0".repeat(355);
  assert.equal(setTaken("Attributes", want, "1" + "0".repeat(354) + "1"), false);
  assert.equal(setTaken("Attributes", want, want), true);
  assert.equal(setTaken("Attributes", "100000000000000001", "100000000000000000"), false);
  assert.equal(setTaken("Attributes", "0110000", "110000"), false, "a leading zero is a position, not a numeric no-op");
  assert.equal(setTaken("Attributes", "0110000", "0110000"), true);
});

test("#161 late review: gma3_store_filter stops at a layer write it cannot read back (unknown, nothing after it is sent)", async () => {
  c.unreadableSet.add("Relative");
  const r = await h.callJson("gma3_store_filter", { filter: 41, attributes: ["Dimmer"] });
  assert.notEqual(r.result.outcome, "succeeded", r.text);
  const sets = h.fake.requests.filter((q) => q.op === "set").map((q) => q.args.property);
  assert.deepEqual(sets, ["Attributes", "Absolute", "Relative"], "Timing and Phaser are not written after the unreadable Relative");
  assert.equal(r.result.steps.find((x: any) => x.name === "set_relative").status, "unknown");
});

test("#163 review: an ignored Attributes write in a long mask stops before the layer writes", async () => {
  // The console keeps a mask that differs only in the last position.
  c.objects.get("Filter 3")!.fields.Attributes = "1000001";
  c.ignoreSet.add("Attributes");
  h.fake.requests.length = 0;
  const r = await h.callJson("gma3_store_filter", { filter: 3, attributes: ["Dimmer"], on_taken: "update", layers: { phaser: false } });
  assert.notEqual(r.result.outcome, "succeeded", r.text);
  assert.match(r.text, /did not take Attributes = \\"1000000\\" on Filter 3: it reads \\"1000001\\"/);
  assert.deepEqual(h.fake.requests.filter((q) => q.op === "set").map((q) => q.args.property), ["Attributes"]);
});
