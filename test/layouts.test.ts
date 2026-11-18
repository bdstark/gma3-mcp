import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import { expandRange, gridElements, parseObject, propMatches, registerLayoutTools, visibility } from "../src/tools/layouts.ts";

interface El {
  object: string;
  props: Record<string, unknown>;
}
interface Lay {
  name: string;
  elements: El[];
}

/**
 * A console with a few pool objects and layouts. Assign <obj> At Layout <n> appends an element (creating the layout
 * when the slot is empty, as the manual says for fixtures); Delete Layout removes it; set writes element properties
 * and the layout's name, reading them back the way the bridge does (trimmed text).
 */
class Console {
  objects = new Map<string, { class: string; name: string }>();
  layouts = new Map<number, Lay>();
  /** Assigns matching this append two elements (a fixture with cells, say). */
  double?: RegExp;
  /** Assigns matching this append an element showing another object. */
  wrongObject?: RegExp;
  /** Properties the console ignores (the set reads the old value back). */
  ignoreProps = new Set<string>();
  /** Assign commands matching this get no answer. */
  silent?: RegExp;
  /** Delete Layout is answered OK but does nothing. */
  ignoreDelete = false;
  /** Text-field read errors on every element. */
  fieldError?: string;
  /** Properties whose set the console refuses (the set op throws). */
  refuseProps = new Set<string>();

  constructor() {
    this.objects.set("Group 1", { class: "Group", name: "Front" });
    this.objects.set("Group 2", { class: "Group", name: "Back" });
    this.objects.set("Sequence 1", { class: "Sequence", name: "Intro" });
    this.objects.set("Sequence 2", { class: "Sequence", name: "Verse" });
    this.objects.set("Sequence 4", { class: "Sequence", name: "Drop" });
    this.objects.set("Macro 3", { class: "Macro", name: "Blackout" });
    this.objects.set("Preset 4.12", { class: "Preset", name: "Red" });
    this.layouts.set(1, { name: "Default", elements: [] });
    this.layouts.set(2, { name: "Busk", elements: [{ object: "Group 1", props: { PosX: 0, PosY: 0, Width: 50, Height: 50 } }] });
  }

  addr = (ref: string) => `addr:${ref}`;
  elAddr = (n: number, i: number) => `el:${n}:${i}`;

  objectsRead(ref: string) {
    const lm = ref.match(/^Layout (\d+)$/);
    if (lm) {
      const l = this.layouts.get(Number(lm[1]));
      if (!l) throw new Error("no objects found");
      return { total: 1, offset: 0, count: 1, items: [{ name: l.name, class: "Layout", addr: `addr:${ref}`, childCount: l.elements.length, fields: { Name: l.name } }] };
    }
    const o = this.objects.get(ref);
    if (!o) throw new Error("no objects found");
    return { total: 1, offset: 0, count: 1, items: [{ name: o.name, class: o.class, addr: this.addr(ref), fields: { Name: o.name } }] };
  }

  children(ref: string, fields: string[], asText: boolean, limit: number, offset: number) {
    if (ref === "DataPool.Layouts") {
      const items = [...this.layouts].map(([no, l]) => ({ name: l.name, class: "Layout", index: no, childCount: l.elements.length, fields: { No: no, Name: l.name } }));
      return { total: items.length, items };
    }
    const lm = ref.match(/^Layout (\d+)$/);
    if (!lm) throw new Error(`path not found: ${ref}`);
    const n = Number(lm[1]);
    const l = this.layouts.get(n);
    if (!l) throw new Error("no objects found");
    const items = l.elements.slice(offset, offset + limit).map((e, k) => {
      const i = offset + k + 1;
      const f: Record<string, unknown> = {};
      const errs: Record<string, unknown> = {};
      for (const name of fields) {
        if (name === "Object") {
          const o = this.objects.get(e.object);
          if (o) f.Object = asText ? o.name : { class: o.class, name: o.name, addr: this.addr(e.object) };
        } else if (!asText && this.fieldError === undefined) {
          if (e.props[name] !== undefined) f[name] = e.props[name];
        } else if (asText && this.fieldError !== undefined && name === "CustomTextText") {
          errs[name] = this.fieldError;
        } else if (e.props[name] !== undefined) f[name] = e.props[name];
      }
      return { class: "Element", index: i, addr: this.elAddr(n, i), fields: f, ...(Object.keys(errs).length ? { fieldErrors: errs } : {}) };
    });
    return { total: l.elements.length, offset, count: items.length, items };
  }

  command(cmd: string): string | typeof SILENT {
    if (this.silent?.test(cmd)) return SILENT;
    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^Assign (.+) At Layout (\d+)$/))) {
      if (!this.objects.has(m[1])) return "Error: no object";
      const n = Number(m[2]);
      if (!this.layouts.has(n)) this.layouts.set(n, { name: `Layout ${n}`, elements: [] });
      const l = this.layouts.get(n)!;
      l.elements.push({ object: this.wrongObject?.test(cmd) ? "Macro 3" : m[1], props: { PosX: 0, PosY: 0, Width: 50, Height: 50, VisibilityObjectName: "Visible" } });
      if (this.double?.test(cmd)) l.elements.push({ object: m[1], props: {} });
      return "OK";
    }
    if ((m = cmd.match(/^Delete Layout (\d+) \/NoConfirmation$/))) {
      if (!this.ignoreDelete) this.layouts.delete(Number(m[1]));
      return "OK";
    }
    return "Syntax Error";
  }

  set(ref: string, property: string, value: string) {
    const lm = ref.match(/^Layout (\d+)$/);
    if (lm) {
      const l = this.layouts.get(Number(lm[1]));
      if (!l) throw new Error("no objects found");
      if (property === "Name") l.name = value;
      return { ref, property, value: l.name, readOk: true };
    }
    const em = ref.match(/^el:(\d+):(\d+)$/);
    if (!em) throw new Error(`path not found: ${ref}`);
    const e = this.layouts.get(Number(em[1]))!.elements[Number(em[2]) - 1];
    if (this.refuseProps.has(property)) throw new Error(`Set failed: illegal value for ${property}`);
    if (!this.ignoreProps.has(property)) e.props[property] = /^(PosX|PosY|Width|Height)$/.test(property) ? Number(value) : value;
    return { ref, property, value: e.props[property] ?? null, readOk: true };
  }
}

let h: Harness;
let c: Console;

function install() {
  h.fake.reset();
  c = new Console();
  h.fake.on("objects", (a) => c.objectsRead(String(a.ref)));
  h.fake.on("children", (a) => c.children(String(a.ref), (a.fields as string[]) ?? [], a.asText !== false, Number(a.limit ?? 200), Number(a.offset ?? 0)));
  h.fake.on("cmd", (a) => {
    const fb = c.command(String(a.command));
    return fb === SILENT ? SILENT : { command: a.command, feedback: fb };
  });
  h.fake.on("set", (a) => c.set(String(a.ref), String(a.property), String(a.value)));
}

before(async () => {
  h = await startHarness(registerLayoutTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => install());

test("parsing: one object per element, ranges and + lists for the grid; visibility and property comparison", () => {
  assert.deepEqual(parseObject(" seq 3 "), { keyword: "Sequence", ref: "Sequence 3" });
  assert.equal(parseObject("Preset 4.12").ref, "Preset 4.12");
  assert.equal(parseObject("fixture 101.3").ref, "Fixture 101.3");
  assert.throws(() => parseObject("Preset 4"), /Preset <pool>.<number>/);
  assert.throws(() => parseObject("Group 1 Thru 4"), /one object/);
  assert.throws(() => parseObject("Cue 3"), /not an object a layout element shows/);
  assert.throws(() => parseObject("Group 1.2"), /whole number/);
  assert.deepEqual(expandRange("Sequence 1 Thru 3").map((r) => r.ref), ["Sequence 1", "Sequence 2", "Sequence 3"]);
  assert.deepEqual(expandRange("Preset 4.1 Thru 4.3").map((r) => r.ref), ["Preset 4.1", "Preset 4.2", "Preset 4.3"]);
  assert.deepEqual(expandRange("Preset 4.1 Thru 2").map((r) => r.ref), ["Preset 4.1", "Preset 4.2"]);
  assert.deepEqual(expandRange("Group 1 + 3 + Macro 2").map((r) => r.ref), ["Group 1", "Group 3", "Macro 2"]);
  assert.deepEqual(expandRange("Preset 4.1 + 5").map((r) => r.ref), ["Preset 4.1", "Preset 4.5"]);
  assert.throws(() => expandRange("Preset 4.1 Thru 5.3"), /one preset pool/);
  assert.throws(() => expandRange("Sequence 5 Thru 1"), /upwards/);
  // #159 review: endpoints are bounded safe integers before any counting (2^53 + n++ never ends; 400 digits is Infinity).
  assert.throws(() => expandRange("Group 9007199254740992 Thru 9007199254740992"), /not a number from 1 to 9999/);
  assert.throws(() => expandRange(`Group 1 Thru ${"9".repeat(400)}`), /not a number from 1 to 9999/);
  assert.throws(() => expandRange("Fixture 9007199254740992 Thru 9007199254740993"), /not a number from 1 to 99999999/);
  assert.throws(() => expandRange("Preset 4.9007199254740992 Thru 4.9007199254740992"), /not a number from 1 to 9999/);
  assert.throws(() => expandRange("Sequence 0 Thru 3"), /not a number from 1 to 9999/);
  assert.throws(() => parseObject("Group 10000"), /not a number from 1 to 9999/);
  assert.equal(parseObject("Fixture 50001").ref, "Fixture 50001");
  assert.deepEqual(
    gridElements({ objects: "", columns: 2, width: 100, height: 50, gap: 10 }, expandRange("Sequence 1 Thru 3")),
    [
      { object: "Sequence 1", x: 0, y: 0, width: 100, height: 50 },
      { object: "Sequence 2", x: 110, y: 0, width: 100, height: 50 },
      { object: "Sequence 3", x: 0, y: -60, width: 100, height: 50 },
    ],
  );
  assert.equal(visibility("Visible"), true);
  assert.equal(visibility("Off"), false);
  assert.equal(visibility("maybe"), null);
  assert.ok(propMatches({ key: "text_color", prop: "CustomTextColor", kind: "color" }, "ff0000ff", "FF0000FF"));
  assert.ok(!propMatches({ key: "x", prop: "PosX", kind: "number" }, 10, undefined));
});

test("a new layout: one Assign per element, properties set on the new element, everything read back, named", async () => {
  const r = await h.callJson("gma3_store_layout", {
    layout: 5,
    name: "Busk 2",
    elements: [
      { object: "Sequence 1", x: 0, y: 0, width: 120, height: 80, text: "Intro", action: "Go+", show_name: false },
      { object: "Group 2", x: 130, y: 0, text_color: "ff0000ff", align_h: "Left" },
    ],
  });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Assign Sequence 1 At Layout 5", "Assign Group 2 At Layout 5"]);
  const l = c.layouts.get(5)!;
  assert.equal(l.name, "Busk 2");
  assert.equal(l.elements.length, 2);
  assert.deepEqual(l.elements[0].props, { PosX: 0, PosY: 0, Width: 120, Height: 80, VisibilityObjectName: "Hidden", CustomTextText: "Intro", Action: "Go+" });
  assert.equal(l.elements[1].props.CustomTextColor, "FF0000FF");
  assert.equal(l.elements[1].props.CustomTextAlignmentH, "Left");
  assert.equal(r.result.added, 2);
});

test("a taken layout is refused unless overwrite or append; overwrite deletes and rebuilds, append adds after the old elements", async () => {
  let r = await h.callJson("gma3_store_layout", { layout: 2, elements: [{ object: "Group 2" }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Layout 2 exists \(\\"Busk\\"\); pass overwrite/);
  assert.deepEqual(h.fake.commands, []);

  r = await h.callJson("gma3_store_layout", { layout: 2, append: true, elements: [{ object: "Group 2", x: 60 }] });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(c.layouts.get(2)!.elements.map((e) => e.object), ["Group 1", "Group 2"]);
  assert.equal(c.layouts.get(2)!.elements[1].props.PosX, 60);

  h.fake.requests.length = 0;
  r = await h.callJson("gma3_store_layout", { layout: 2, overwrite: true, elements: [{ object: "Macro 3" }] });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Delete Layout 2 /NoConfirmation", "Assign Macro 3 At Layout 2"]);
  assert.deepEqual(c.layouts.get(2)!.elements.map((e) => e.object), ["Macro 3"]);

  r = await h.callJson("gma3_store_layout", { layout: 2, overwrite: true, append: true, elements: [{ object: "Macro 3" }] });
  assert.match(r.text, /exclude each other/);
});

test("an ignored Delete stops the rebuild before any Assign", async () => {
  c.ignoreDelete = true;
  const r = await h.callJson("gma3_store_layout", { layout: 2, overwrite: true, elements: [{ object: "Macro 3" }] });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.text, /still there after the Delete/);
  assert.deepEqual(h.fake.commands, ["Delete Layout 2 /NoConfirmation"]);
});

test("missing objects are refused before anything is sent; a grid may skip a range's empty numbers", async () => {
  let r = await h.callJson("gma3_store_layout", { layout: 6, elements: [{ object: "Group 9" }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Group 9 does not exist/);
  r = await h.callJson("gma3_store_layout", { layout: 6, grid: { objects: "Sequence 1 Thru 4", columns: 2 } });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Sequence 3 does not exist; pass grid.skip_missing/);
  assert.deepEqual(h.fake.commands, []);

  r = await h.callJson("gma3_store_layout", { layout: 6, grid: { objects: "Sequence 1 Thru 4", columns: 2, width: 100, height: 100, gap: 0, skip_missing: true } });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Assign Sequence 1 At Layout 6", "Assign Sequence 2 At Layout 6", "Assign Sequence 4 At Layout 6"]);
  assert.deepEqual(c.layouts.get(6)!.elements.map((e) => [e.object, e.props.PosX, e.props.PosY]), [["Sequence 1", 0, 0], ["Sequence 2", 100, 0], ["Sequence 4", 0, -100]]);
  assert.match(JSON.stringify(r.result.warnings), /Sequence 3 do not exist and were left out/);
});

test("preview lists the commands and sends nothing", async () => {
  const r = await h.callJson("gma3_store_layout", { layout: 2, overwrite: true, preview: true, grid: { objects: "Group 1 + 2", columns: 4 } });
  assert.equal(r.result.preview, true, r.text);
  assert.deepEqual(r.result.commands, ["Delete Layout 2 /NoConfirmation", "Assign Group 1 At Layout 2", "Assign Group 2 At Layout 2"]);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(h.fake.requests.filter((q) => q.op === "set").length, 0);
});

test("an Assign that adds two elements, or the wrong object, stops the call before any property is set", async () => {
  c.double = /Group 2/;
  let r = await h.callJson("gma3_store_layout", { layout: 7, elements: [{ object: "Sequence 1", x: 5 }, { object: "Group 2", x: 9 }, { object: "Macro 3" }] });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /has 3 elements \(expected 2\)/);
  assert.deepEqual(h.fake.commands, ["Assign Sequence 1 At Layout 7", "Assign Group 2 At Layout 7"]);
  assert.equal(h.fake.requests.filter((q) => q.op === "set").length, 1, "only the first element's x was set");

  install();
  c.wrongObject = /Group 2/;
  r = await h.callJson("gma3_store_layout", { layout: 7, elements: [{ object: "Group 2", x: 9 }] });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /its last shows Macro \\"Blackout\\", not Group 2/);
  assert.equal(h.fake.requests.filter((q) => q.op === "set").length, 0);
});

test("a property the console ignores, or cannot be read, is a mismatch", async () => {
  c.ignoreProps.add("CustomTextText");
  let r = await h.callJson("gma3_store_layout", { layout: 8, elements: [{ object: "Group 1", text: "Front" }] });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /CustomTextText reads null, asked \\"Front\\"/);

  install();
  c.fieldError = "read failed";
  r = await h.callJson("gma3_store_layout", { layout: 8, elements: [{ object: "Group 1", text: "Front" }] });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /CustomTextText could not be read \(read failed\)/);
});

test("a property write the console refuses after a confirmed Assign leaves a partial outcome, with the Assign kept as its own succeeded step", async () => {
  c.refuseProps.add("Action");
  const r = await h.callJson("gma3_store_layout", { layout: 11, elements: [{ object: "Sequence 1", action: "Wobble", x: 5 }] });
  assert.equal(r.result.outcome, "partial", r.text);
  assert.equal(r.result.verification.status, "mismatched", r.text);
  const steps = r.result.steps as Array<{ name: string; status: string; error?: string }>;
  assert.equal(steps.find((s) => s.name === "element_1_assign")?.status, "succeeded");
  const set = steps.find((s) => s.name === "element_1_set");
  assert.equal(set?.status, "failed");
  assert.match(set?.error ?? "", /Action: .*illegal value/);
  assert.equal(c.layouts.get(11)!.elements[0].props.PosX, 5, "the other property was still written");
});

test("an unanswered Assign stops the call as unknown and is not retried", async () => {
  c.silent = /Group 2/;
  const r = await h.callJson("gma3_store_layout", { layout: 9, elements: [{ object: "Group 1" }, { object: "Group 2" }, { object: "Macro 3" }] });
  assert.notEqual(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /stopped after 1 of 3 elements/);
  assert.deepEqual(h.fake.commands, ["Assign Group 1 At Layout 9", "Assign Group 2 At Layout 9"]);
});

test("a name another layout has is refused unless allow_suffix", async () => {
  const r = await h.callJson("gma3_store_layout", { layout: 10, name: "Busk", elements: [{ object: "Group 1" }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /the name \\"Busk\\" is taken: \\"Busk\\" is Layout 2/);
  assert.deepEqual(h.fake.commands, []);
});

test("validation: no elements, too many, bad values", async () => {
  let r = await h.callJson("gma3_store_layout", { layout: 3 });
  assert.match(r.text, /at least one element/);
  r = await h.callJson("gma3_store_layout", { layout: 3, elements: [{ object: "Group 1", width: 0, text_color: "red", align_v: "Middle", text_size: "11", action: "go; Off" }] });
  for (const re of [/width must be/, /text_color must be/, /align_v must be/, /text_size must be/, /action must be/]) assert.match(r.text, re);
  r = await h.callJson("gma3_store_layout", { layout: 3, grid: { objects: "Sequence 1 Thru 500", columns: 10 } });
  assert.match(r.text, /at most 200 objects/);
  // #159 review: positions a grid generates obey the explicit elements' bounds, refused before any Delete.
  r = await h.callJson("gma3_store_layout", { layout: 2, overwrite: true, grid: { objects: "Group 1 + 2", columns: 2, x: 32000 } });
  assert.match(r.text, /grid element 2 \(Group 2\)\.x must be a whole number from -32000 to 32000/);
  r = await h.callJson("gma3_store_layout", { layout: 2, overwrite: true, preview: true, grid: { objects: "Sequence 1 Thru 200", columns: 1, height: 1000, gap: 1000 } });
  assert.match(r.text, /grid element \d+ \(Sequence \d+\)\.y must be/);
  assert.ok(c.layouts.has(2), "the existing layout is untouched");
  r = await h.callJson("gma3_store_layout", { layout: 3, preview: true, grid: { objects: "Group 9007199254740992 Thru 9007199254740992", columns: 1 } });
  assert.match(r.text, /not a number from 1 to 9999/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_layouts: the pool, one layout's elements with their objects and properties, and a missing layout", async () => {
  let r = await h.callJson("gma3_layouts", {});
  assert.deepEqual(r.result.layouts, [{ no: 1, name: "Default", elements: 0 }, { no: 2, name: "Busk", elements: 1 }]);
  r = await h.callJson("gma3_layouts", { layout: 2 });
  assert.equal(r.result.found, true);
  assert.equal(r.result.complete, true);
  assert.deepEqual(r.result.elements[0].object, { class: "Group", name: "Front", addr: "addr:Group 1" });
  assert.equal(r.result.elements[0].props.Width, 50);
  r = await h.callJson("gma3_layouts", { layout: 77 });
  assert.deepEqual(r.result, { layout: 77, found: false });
});
