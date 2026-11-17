import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { batchCheck, parseDestination, parsePoolObject, referenceCount, registerPoolObjectTools } from "../src/tools/poolobjects.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

interface Obj {
  class: string;
  name: string;
  lock?: string;
  children: number;
  /** References text; undefined: the property is not readable (fieldErrors). */
  references?: string;
  running?: boolean;
}

/**
 * A console with a few pools, answering objects / children / object reads and the Copy, Move, Delete and Label
 * commands as the grandMA3 2.5 manual describes them: Move onto an occupied slot pushes the occupant on, Copy onto an
 * occupied slot without /Overwrite or /Merge is not answered here (the tool must never send it), Delete removes.
 */
class Console {
  objects = new Map<string, Obj>();
  executors: Array<{ page: number; no: number; object: string }> = [];
  ignore?: RegExp;
  silent?: RegExp;
  /** Extra raw executor items on page 1 (field errors, invalid handles). */
  rawExecs: Array<Record<string, unknown>> = [];
  pagesEnumerationError?: string;

  constructor() {
    this.objects.set("Group 1", { class: "Group", name: "Front", children: 0, references: "" });
    this.objects.set("Group 2", { class: "Group", name: "Back", children: 0, references: "1234:1" });
    this.objects.set("Group 3", { class: "Group", name: "Locked", lock: "UL", children: 0, references: "" });
    this.objects.set("Sequence 5", { class: "Sequence", name: "Main", children: 4, references: "" });
    this.objects.set("Sequence 6", { class: "Sequence", name: "Other", children: 2, references: "" });
    this.objects.set("Macro 7", { class: "Macro", name: "Go", children: 3 });
    this.objects.set("Preset 4.1", { class: "Preset", name: "Red", children: 0, references: "" });
    this.objects.set("Preset 4.2", { class: "Preset", name: "Blue", children: 0, references: "99:2,100:1" });
  }

  addr(ref: string) {
    return `addr:${ref}`;
  }

  row(ref: string, fields: string[]) {
    const o = this.objects.get(ref)!;
    const f: Record<string, unknown> = {};
    const errs: Record<string, unknown> = {};
    for (const k of fields) {
      if (k === "Name") f.Name = o.name;
      else if (k === "Lock") f.Lock = o.lock ?? "";
      else if (k === "References") {
        if (o.references === undefined) errs.References = "unknown property";
        else f.References = o.references;
      }
    }
    return { name: o.name, class: o.class, addr: this.addr(ref), childCount: o.children, fields: f, ...(Object.keys(errs).length ? { fieldErrors: errs } : {}) };
  }

  poolPrefix(ref: string): string | null {
    const m = ref.match(/^DataPool\.(Groups|Sequences|Macros)$/);
    if (m) return { Groups: "Group", Sequences: "Sequence", Macros: "Macro" }[m[1]]!;
    const p = ref.match(/^Preset (\d+)$/);
    return p ? `Preset ${p[1]}.` : null;
  }

  children(ref: string, fields: string[]) {
    // A scoped bridge finds DataPool 2's pools by name; this fake answers them with the same objects.
    if (ref === "DataPool 2") return { total: 3, items: ["Groups", "Sequences", "Macros"].map((n) => ({ name: n, addr: `DataPool.${n}` })) };
    if (ref === "DataPool.Pages") {
      if (this.pagesEnumerationError) return { total: 0, items: [], enumerationError: this.pagesEnumerationError };
      return { total: 1, items: [{ addr: "page1", index: 1, fields: { No: 1 } }] };
    }
    if (ref === "page1") {
      const items = [...this.executors.map((e) => ({ fields: { No: e.no, Object: { class: "x", addr: this.addr(e.object) } } })), ...this.rawExecs];
      return { total: items.length, items };
    }
    const prefix = this.poolPrefix(ref);
    if (prefix === null) throw new Error(`path not found: ${ref}`);
    const items = [...this.objects.keys()]
      .filter((k) => (prefix.endsWith(".") ? k.startsWith(prefix) : k.startsWith(`${prefix} `)))
      .map((k) => ({ ...this.row(k, fields), index: Number(k.split(/[ .]/).pop()), fields: { No: Number(k.split(/[ .]/).pop()), Name: this.objects.get(k)!.name } }));
    return { total: items.length, items };
  }

  command(cmd: string): string | typeof SILENT {
    if (this.silent?.test(cmd)) return SILENT;
    if (this.ignore?.test(cmd)) return "OK";
    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^Copy (\w+ [\d.]+) At (\w+ [\d.]+)( \/Overwrite| \/Merge)? \/NoConfirmation$/))) {
      const src = this.objects.get(m[1]);
      if (!src) return "Error: no object";
      if (this.objects.has(m[2]) && !m[3]) throw new Error("the fake console would ask: the tool must not copy onto an occupied slot without a mode");
      this.objects.set(m[2], { ...src, references: "" });
      return "OK";
    }
    if ((m = cmd.match(/^Move (\w+ [\d.]+) At (\w+ [\d.]+)$/))) {
      const src = this.objects.get(m[1]);
      if (!src) return "Error: no object";
      if (this.objects.has(m[2])) throw new Error("the fake console would renumber: the tool must not move onto an occupied slot");
      this.objects.delete(m[1]);
      this.objects.set(m[2], src);
      return "OK";
    }
    if ((m = cmd.match(/^Delete (\w+ [\d.]+) \/NoConfirmation$/))) {
      this.objects.delete(m[1]);
      return "OK";
    }
    if ((m = cmd.match(/^Label (\w+ [\d.]+) "([^"]*)"$/))) {
      const o = this.objects.get(m[1]);
      if (!o) return "Error: no object";
      // Names stay unique in a pool: a taken name gets "#2" (as presets do, #102).
      const pool = m[1].replace(/[\d.]+$/, (x) => (x.includes(".") ? x.split(".")[0] + "." : ""));
      const taken = [...this.objects].some(([k, v]) => k !== m![1] && k.startsWith(pool) && v.name === m![2]);
      o.name = taken ? `${m[2]}#2` : m[2];
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
  h.fake.on("objects", (a) => {
    const ref = String(a.ref).replace(/^DataPool 2 /, "");
    if (!c.objects.has(ref)) throw new Error("no objects found");
    return { total: 1, offset: 0, count: 1, items: [c.row(ref, (a.fields as string[]) ?? [])] };
  });
  h.fake.on("children", (a) => c.children(String(a.ref), (a.fields as string[]) ?? []));
  h.fake.on("object", (a) => ({ hasActivePlayback: c.objects.get(String(a.ref))?.running ?? false }));
  h.fake.on("cmd", (a) => {
    const fb = c.command(String(a.command).replace(/DataPool 2 /g, ""));
    return fb === SILENT ? SILENT : { command: a.command, feedback: fb };
  });
}

before(async () => {
  h = await startHarness(registerPoolObjectTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => install());

test("parsing: objects, presets, destinations; ranges, tags and cues are refused with a pointer", () => {
  assert.deepEqual(parsePoolObject("object", " group  5 "), { kind: "group", keyword: "Group", no: 5, ref: "Group 5" });
  assert.equal(parsePoolObject("object", "Seq 3").ref, "Sequence 3");
  assert.deepEqual(parsePoolObject("object", "Preset 4.12"), { kind: "preset", keyword: "Preset", pool: 4, no: 12, ref: "Preset 4.12" });
  assert.throws(() => parsePoolObject("object", "Preset 4"), /Preset <pool>.<number>/);
  assert.throws(() => parsePoolObject("object", "Group 1 Thru 4"), /one object per item/);
  assert.throws(() => parsePoolObject("object", "Tag 3"), /gma3_delete_tag/);
  assert.throws(() => parsePoolObject("object", "Cue 3"), /gma3_delete_cue/);
  const p = parsePoolObject("object", "Preset 4.1");
  assert.equal(parseDestination("to", 20, p).ref, "Preset 4.20");
  assert.equal(parseDestination("to", "4.21", p).ref, "Preset 4.21");
  assert.throws(() => parseDestination("to", "3.21", p), /within preset pool 4/);
  assert.throws(() => parseDestination("to", 1, p), /itself/);
  assert.throws(() => parseDestination("to", "Group 9", parsePoolObject("object", "Sequence 1")), /its own pool/);
  assert.equal(referenceCount(""), 0);
  assert.equal(referenceCount("1:1,2:3"), 2);
  assert.equal(referenceCount(undefined), null);
});

test("copy into a free number: one Copy, the destination reads the source's name and children, the source is unchanged", async () => {
  const r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Sequence 5", to: 9 });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Copy Sequence 5 At Sequence 9 /NoConfirmation"]);
  assert.equal(c.objects.get("Sequence 9")?.children, 4);
  assert.match(JSON.stringify(r.result.warnings), /same name as Sequence 5/);
});

test("copy onto an occupied number is refused unless on_taken; overwrite sends /Overwrite; a name labels the copy after a name check", async () => {
  let r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Sequence 5", to: 6 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /Sequence 6 is taken \(\\"Other\\"\); pass on_taken/);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Sequence 5", to: 6, on_taken: "overwrite", name: "Main copy" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Copy Sequence 5 At Sequence 6 /Overwrite /NoConfirmation", 'Label Sequence 6 "Main copy"']);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Group 1", to: 9, name: "Back" });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /the name \\"Back\\" is taken: \\"Back\\" is Group 2/);
  assert.deepEqual(h.fake.commands, []);
});

test("move: only into a free number; the source slot is read back free and the destination holds the object", async () => {
  let r = await h.callJson("gma3_pool_objects", { action: "move", object: "Group 1", to: 2 });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /renumbering every object in between/);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_pool_objects", { action: "move", object: "Group 1", to: 10 });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Move Group 1 At Group 10"]);
  assert.match(r.result.verification.checked, /Group 1 is free/);
  r = await h.callJson("gma3_pool_objects", { action: "move", object: "Group 1", to: 11, on_taken: "overwrite" });
  assert.match(r.text, /on_taken is only for copy/);
});

test("delete: unused objects go; a slot still there is a mismatch", async () => {
  let r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Group 1" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ["Delete Group 1 /NoConfirmation"]);
  assert.ok(!c.objects.has("Group 1"));
  install();
  c.ignore = /^Delete/;
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Preset 4.1" });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /Preset 4.1 still exists/);
});

test("delete is refused while in use (references, executors, running, unreadable references) unless force", async () => {
  // References listed by the console.
  let r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Preset 4.2" });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /is in use: the console lists 2 object\(s\) that reference it/);
  assert.match(r.text, /plain values/);
  assert.deepEqual(h.fake.commands, []);
  // On an executor and running.
  c.executors.push({ page: 1, no: 201, object: "Sequence 5" });
  c.objects.get("Sequence 5")!.running = true;
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Sequence 5" });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /executor\(s\) Page 1\.201/);
  assert.match(r.text, /it is running/);
  assert.deepEqual(h.fake.commands, []);
  // A reference list that cannot be read: may be in use.
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Macro 7" });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /may be in use: the console's reference list/);
  assert.deepEqual(h.fake.commands, []);
  // force deletes and lists the uses.
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Sequence 5", force: true });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.deepEqual(h.fake.commands, ["Delete Sequence 5 /NoConfirmation"]);
  assert.match(JSON.stringify(r.result.warnings), /deleted with force: it is assigned to executor\(s\) Page 1\.201/);
});

test("rename: a locked object, a missing one and an unchanged name send nothing; a rename reads the new name back", async () => {
  let r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 3", name: "X" });
  assert.match(r.text, /Group 3 is locked/);
  r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 99", name: "X" });
  assert.match(r.text, /Group 99 does not exist; nothing was sent/);
  r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 1", name: "Front" });
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 1", name: "Front Wash" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.deepEqual(h.fake.commands, ['Label Group 1 "Front Wash"']);
  r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 1", name: "Bad,Name" });
  assert.match(r.text, /grandMA3 removes from names/);
});

test("preview reads and plans but sends nothing", async () => {
  const r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Preset 4.1", to: "4.9", preview: true });
  assert.equal(r.result.preview, true, r.text);
  assert.deepEqual(r.result.plan, ["Copy Preset 4.1 At Preset 4.9 /NoConfirmation"]);
  assert.deepEqual(h.fake.commands, []);
});

test("data_pool scopes the reads and the commands", async () => {
  const r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 1", name: "Pool two", data_pool: 2 });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.deepEqual(h.fake.commands, ['Label DataPool 2 Group 1 "Pool two"']);
});

test("a command without a reply is unknown and the batch stops there", async () => {
  c.silent = /^Delete Group 1/;
  const r = await h.callJson("gma3_pool_objects", {
    action: "delete",
    objects: [{ object: "Group 1" }, { object: "Preset 4.1" }],
  });
  assert.equal(r.result.items[0].outcome, "unknown", r.text);
  assert.equal(r.result.items[1].outcome, "not_attempted", r.text);
});

test("batch: a default action, one line per item, and refused duplicates", async () => {
  let r = await h.callJson("gma3_pool_objects", {
    objects: [
      { action: "copy", object: "Group 1", to: 20, name: "Front 2" },
      { action: "rename", object: "Group 2", name: "Rear" },
      { action: "delete", object: "Preset 4.1" },
    ],
  });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.items.length, 3);
  assert.deepEqual(h.fake.commands, ["Copy Group 1 At Group 20 /NoConfirmation", 'Label Group 20 "Front 2"', 'Label Group 2 "Rear"', "Delete Preset 4.1 /NoConfirmation"]);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_pool_objects", { action: "move", objects: [{ object: "Group 1", to: 30 }, { object: "Group 2", to: 30 }] });
  assert.equal(r.result.outcome, "failed");
  assert.match(r.text, /group 30 is the destination of more than one item/);
  assert.deepEqual(h.fake.commands, []);
  assert.deepEqual(batchCheck([{ action: "delete", object: "Group 1" }, { action: "move", object: "group  1", to: 4 }]), ["group 1 is deleted or moved by more than one item"]);
});

test("#155 review: the delete gate fails closed on an executor scan it could not read", async () => {
  c.rawExecs.push({ fields: { No: 201 }, fieldErrors: { Object: "unreadable" } });
  let r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Group 1" });
  assert.equal(r.result.outcome, "failed", r.text);
  assert.match(r.text, /may be in use: the executor scan was incomplete \(executor 201 of page 1: Object could not be read \(unreadable\)\)/);
  assert.deepEqual(h.fake.commands, []);
  install();
  c.pagesEnumerationError = "Children() failed";
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Group 1" });
  assert.equal(r.result.outcome, "failed", r.text);
  assert.match(r.text, /the pages could not be listed: Children\(\) failed/);
  assert.deepEqual(h.fake.commands, []);
  install();
  c.rawExecs.push({ invalid: true });
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Group 1" });
  assert.match(r.text, /invalid handle/);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_pool_objects", { action: "delete", object: "Group 1", force: true });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.match(JSON.stringify(r.result.warnings), /deleted with force: the executor scan was incomplete/);
});

test("#155 review: an overwrite copy the console ignored is a mismatch (only a merge keeps the destination's name)", async () => {
  c.ignore = /^Copy /;
  let r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Group 1", to: 2, on_taken: "overwrite" });
  assert.equal(r.result.verification.status, "mismatched", r.text);
  assert.match(r.text, /Group 2 reads the name \\"Back\\", not \\"Front\\"/);
  install();
  r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Group 1", to: 2, on_taken: "merge" });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.match(r.result.verification.checked, /a merge keeps its name/);
});

test("#155 review: with on_name_taken allow_suffix a \"#2\" name reads back as matched, with the actual name in a warning", async () => {
  let r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 1", name: "Back", on_name_taken: "allow_suffix" });
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.match(JSON.stringify(r.result.warnings), /Group 1 was named \\"Back#2\\"/);
  r = await h.callJson("gma3_pool_objects", { action: "copy", object: "Preset 4.1", to: 9, name: "Blue", on_name_taken: "allow_suffix" });
  assert.equal(r.result.verification.status, "matched", r.text);
  assert.match(JSON.stringify(r.result.warnings), /Preset 4.9 was named \\"Blue#2\\"/);
  // Without allow_suffix the name check refuses before anything is sent; a suffixed read-back would be a mismatch.
  install();
  c.objects.set("Group 9", { class: "Group", name: "Spare", children: 0, references: "" });
  r = await h.callJson("gma3_pool_objects", { action: "rename", object: "Group 9", name: "Back" });
  assert.equal(r.result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
});

test("#155 review: batch keys and duplicates use the canonical object (Seq 5 = Sequence 5, Group 01 = Group 1)", async () => {
  const r = await h.callJson("gma3_pool_objects", {
    objects: [
      { action: "rename", object: "Seq 5", name: "Other" },
      { action: "delete", object: "Sequence 05", force: true },
    ],
  });
  assert.equal(r.result.items[0].outcome, "failed", r.text);
  assert.equal(r.result.items[1].outcome, "not_attempted", r.text);
  assert.deepEqual(h.fake.commands, []);
  assert.deepEqual(batchCheck([{ action: "delete", object: "Group 01" }, { action: "move", object: "Group 1", to: 4 }]), ["group 1 is deleted or moved by more than one item"]);
});

test("#155 review 2: an item's own on_name_taken wins over the call's, in both directions", async () => {
  let r = await h.callJson("gma3_pool_objects", { on_name_taken: "allow_suffix", objects: [{ action: "rename", object: "Group 1", name: "Back", on_name_taken: "refuse" }] });
  assert.equal(r.result.items[0].outcome, "failed", r.text);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_pool_objects", { objects: [{ action: "rename", object: "Group 1", name: "Back", on_name_taken: "allow_suffix" }] });
  assert.equal(r.result.items[0].outcome, "succeeded", r.text);
  assert.deepEqual(h.fake.commands, ['Label Group 1 "Back"']);
  assert.equal(c.objects.get("Group 1")?.name, "Back#2");
});

test("#155 review 2: a failed copy also blocks later items on its destination", async () => {
  const r = await h.callJson("gma3_pool_objects", {
    objects: [
      { action: "copy", object: "Group 1", to: 2 },
      { action: "delete", object: "Group 2", force: true },
    ],
  });
  assert.equal(r.result.items[0].outcome, "failed", r.text);
  assert.equal(r.result.items[1].outcome, "not_attempted", r.text);
  assert.match(r.text, /item 1 on group 2 did not succeed/);
  assert.deepEqual(h.fake.commands, []);
  assert.ok(c.objects.has("Group 2"));
});
