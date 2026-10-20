import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerTagTools, objectLabel, refOf, tagKey, tagPlayback, tagTarget } from "../src/tools/tags.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

interface Obj {
  pool?: number;
  active?: boolean;
  class: string;
  no?: number;
  name: string;
  addr: string;
  sequence?: number;
  cue?: number;
  part?: number;
  macro?: number;
  tags?: Array<{ tag: number; protect: boolean }>;
}

/**
 * A console with a tag pool and taggable objects, answering the bridge's tag ops (0.36.0) and the tag commands as
 * onPC 2.5.1 does (docs/probes/su-21-tags-macos-2.5.1.md): an unknown tag in Assign answers OK and does nothing,
 * Store on an existing tag answers OK and keeps it, names lose commas, a cue's tag goes to its Part 0, fixtures are
 * an Illegal object, and invalid TagType / Action values are refused.
 */
class Console {
  tags = new Map<number, { name: string; tagType: string; forwardCommands: boolean; action: string; note: string; appearance?: number }>();
  objects = new Map<string, Obj>();
  appearances = new Set([1, 3]);
  oldBridge = false;
  ignoreAssign = false;
  silentOn?: RegExp;

  constructor() {
    for (const n of [950, 951, 952]) this.objects.set(`Sequence ${n}`, { class: "Sequence", no: n, name: `Seq ${n}`, addr: `14.14.1.7.${n}`, tags: [] });
    this.objects.set("Sequence 950 Cue 1", { class: "Part", name: "Part 0", sequence: 950, cue: 1, part: 0, addr: "14.14.1.7.950.-1.0", tags: [] });
    this.objects.set("Group 950", { class: "Group", no: 950, name: "Grp", addr: "14.14.1.6.950", tags: [] });
    this.objects.set("Macro 950.1", { class: "MacroLine", no: 1, macro: 950, name: "MacroLine 1", addr: "14.14.1.9.950.1", tags: [] });
    this.objects.set("DataPool 2 Sequence 950", { pool: 2, class: "Sequence", no: 950, name: "Seq 950 in pool 2", addr: "14.14.2.7.950", tags: [] });
    this.objects.set("DataPool 2 Sequence 950 Cue 1", { pool: 2, class: "Part", name: "Part 0", sequence: 950, cue: 1, part: 0, addr: "14.14.2.7.950.-1.0", tags: [] });
  }

  resolve(ref: string): Obj[] | null {
    const m = ref.match(/^Sequence (\d+) Thru (\d+)$/);
    if (m) {
      const out: Obj[] = [];
      for (let n = Number(m[1]); n <= Number(m[2]); n++) if (this.objects.has(`Sequence ${n}`)) out.push(this.objects.get(`Sequence ${n}`)!);
      return out.length ? out : null;
    }
    // A part's address holds a negative cue index, which the bridge does not resolve as an address (live 2026-10-19).
    const byAddr = ref.includes("-") ? undefined : [...this.objects.values()].find((o) => o.addr === ref);
    if (byAddr) return [byAddr];
    const o = this.objects.get(ref.replace(/^DataPool 1 /, "").replace(/ Part 0$/, ""));
    return o ? [o] : null;
  }

  tagRow(no: number, refs: boolean, cls?: string, refOffset = 0, refLimit = 200) {
    const t = this.tags.get(no)!;
    const objs = [...this.objects.values()].filter((o) => o.tags?.some((e) => e.tag === no) && (!cls || o.class === cls));
    const page = objs.slice(refOffset, refOffset + refLimit);
    return {
      no,
      name: t.name,
      tagType: t.tagType,
      forwardCommands: t.forwardCommands,
      action: t.action,
      note: t.note,
      count: objs.length,
      ...(t.appearance ? { appearance: { no: t.appearance, name: `App ${t.appearance}` } } : {}),
      tags: [],
      ...(refs ? { references: page.map((o) => ({ ...this.row(o), protect: o.tags!.find((e) => e.tag === no)!.protect })), referencesTotal: objs.length, referencesOffset: refOffset, referencesIncomplete: objs.length > refOffset + page.length } : {}),
    };
  }

  row(o: Obj) {
    const { tags: _t, pool, active: _a, ...rest } = o;
    return { ...rest, dataPool: pool === 2 ? { no: 2, name: "Pool 2" } : { no: 1, name: "Default" } };
  }

  ofRow(o: Obj) {
    return { ...this.row(o), ...(o.tags ? { tags: o.tags.map((e) => (this.tags.has(e.tag) ? { tag: e.tag, name: this.tags.get(e.tag)!.name, protect: e.protect } : { handle: "#DEAD", protect: e.protect })) } : { carriesTags: false }), ...(o.class === "Part" ? { fromCue: true } : {}) };
  }

  command(c: string): string {
    let m: RegExpMatchArray | null;
    if ((m = c.match(/^Store Tag (\d+)(?: "([^"]*)")? \/NoConfirmation$/))) {
      const n = Number(m[1]);
      if (!this.tags.has(n)) this.tags.set(n, { name: (m[2] ?? `Tag ${n}`).replace(/,/g, ""), tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
      return "OK";
    }
    if ((m = c.match(/^Label Tag (\d+) "([^"]*)"$/))) {
      const t = this.tags.get(Number(m[1]));
      if (!t) return "Illegal object";
      t.name = m[2].replace(/,/g, "");
      return "OK";
    }
    if ((m = c.match(/^Delete Tag (\d+) \/NoConfirmation$/))) {
      const n = Number(m[1]);
      this.tags.delete(n);
      for (const o of this.objects.values()) if (o.tags) o.tags = o.tags.filter((e) => e.tag !== n);
      return "OK";
    }
    if ((m = c.match(/^Assign (Off )?Tag (\d+) At (.+)$/))) {
      const objs = this.resolve(m[3]);
      if (!objs) return "Illegal object";
      const n = Number(m[2]);
      if (!this.tags.has(n) || this.ignoreAssign) return "OK";
      for (const o of objs) {
        if (!o.tags) return "Illegal object";
        if (m[1]) o.tags = o.tags.filter((e) => e.tag !== n);
        else if (!o.tags.some((e) => e.tag === n)) o.tags.push({ tag: n, protect: false });
      }
      return "OK";
    }
    if ((m = c.match(/^(Go\+|Off) Tag (\d+)$/))) {
      const n = Number(m[2]);
      if (!this.tags.has(n)) return "OK";
      if (this.tags.get(n)!.forwardCommands) for (const o of this.objects.values()) if (o.class === "Sequence" && o.tags?.some((e) => e.tag === n)) o.active = m[1] === "Go+";
      return "OK";
    }
    if ((m = c.match(/^Set Tag (\d+) Property "(\w+)" "([^"]*)"$/))) {
      const t = this.tags.get(Number(m[1]))!;
      const [, , p, v] = m;
      if (p === "TagType") {
        if (!["None", "Kill Instant", "Kill Delayed"].includes(v)) return "Illegal value";
        t.tagType = v;
      } else if (p === "Action") {
        if (!["Pool Default", "Go+", "Toggle", "Flash"].includes(v)) return "Not allowed";
        t.action = v;
      } else if (p === "ForwardCommands") t.forwardCommands = v === "Yes";
      else if (p === "Note") t.note = v;
      else if (p === "Appearance" && v === "") t.appearance = undefined;
      return "OK";
    }
    if ((m = c.match(/^Assign Appearance (\d+) At Tag (\d+)$/))) {
      this.tags.get(Number(m[2]))!.appearance = Number(m[1]);
      return "OK";
    }
    return "Syntax Error";
  }

  install(h: Harness) {
    h.fake.reset();
    const guard = (op: string) => {
      if (this.oldBridge) throw new Error(`unknown op '${op}'`);
    };
    h.fake.on("tags", (a) => {
      guard("tags");
      const want = a.tags as Array<number | string> | undefined;
      let nos = want ? want.flatMap((k) => (typeof k === "number" ? (this.tags.has(k) ? [k] : []) : [...this.tags].filter(([, t]) => t.name === k).slice(0, 1).map(([n]) => n))) : [...this.tags.keys()].sort((x, y) => x - y);
      nos = nos.filter((n) => (a.from === undefined || n >= Number(a.from)) && (a.to === undefined || n <= Number(a.to)));
      const missing = want ? want.filter((k) => (typeof k === "number" ? !this.tags.has(k) : ![...this.tags.values()].some((t) => t.name === k))) : undefined;
      const offset = Number(a.offset ?? 0);
      const page = nos.slice(offset, offset + Number(a.limit ?? 100));
      return { total: nos.length, offset, count: page.length, incomplete: nos.length > offset + page.length, items: page.map((n) => this.tagRow(n, a.references !== false, a.class as string | undefined, Number(a.refOffset ?? 0), Number(a.refLimit ?? 200))), ...(missing ? { missing } : {}) };
    });
    h.fake.on("tags.of", (a) => {
      guard("tags.of");
      const objs = this.resolve(String(a.ref));
      if (!objs) throw new Error(`[not-found] no objects found for '${a.ref}'`);
      return { count: objs.length, items: objs.map((o) => this.ofRow(o)) };
    });
    h.fake.on("tags.protect", (a) => {
      guard("tags.protect");
      const objs = this.resolve(String(a.ref))!;
      return {
        items: objs.map((o) => {
          const e = o.tags?.find((x) => x.tag === a.tag);
          if (!e) return { ...this.ofRow(o), error: `the object does not carry tag ${a.tag}` };
          const before = e.protect;
          e.protect = a.protect as boolean;
          return { ...this.ofRow(o), before, after: e.protect, changed: before !== e.protect };
        }),
      };
    });
    h.fake.on("cmd", (a) => {
      const c = String(a.command);
      if (this.silentOn?.test(c)) return SILENT;
      return { command: c, feedback: this.command(c) };
    });
    h.fake.on("object", (a) => {
      const o = [...this.objects.values()].find((x) => x.addr === a.ref);
      if (!o) throw new Error(`no object found for '${a.ref}'`);
      return { class: o.class, name: o.name, addr: o.addr, hasActivePlayback: o.active === true };
    });
    h.fake.on("objects", (a) => {
      const m = String(a.ref).match(/^Appearance (\d+)$/);
      if (m && this.appearances.has(Number(m[1]))) return { total: 1, items: [{ name: `App ${m[1]}`, class: "Appearance" }] };
      throw new Error(`no objects found for '${a.ref}'`);
    });
  }
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerTagTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  con = new Console();
  con.install(h);
});

test("helpers: tag keys, stored names, object labels", () => {
  assert.equal(tagKey("tag", 950), 950);
  assert.equal(tagKey("tag", "Encore"), "Encore");
  assert.throws(() => tagKey("tag", 0));
  assert.throws(() => tagKey("tag", 'a"b'));
  assert.equal(tagTarget('Tag "Encore"'), "Encore");
  assert.equal(tagTarget("Tag 7"), 7);
  assert.equal(tagTarget("Sequence 7"), undefined);
  assert.equal(refOf({ class: "Part", sequence: 950, cue: 1, part: 0, dataPool: { no: 2 } }), "DataPool 2 Sequence 950 Cue 1 Part 0");
  assert.equal(refOf({ class: "Sequence", no: 950, addr: "14.14.2.7.950" }), "14.14.2.7.950");
  assert.equal(objectLabel({ class: "Part", sequence: 950, cue: 1, part: 0 }), "Sequence 950 Cue 1 Part 0");
  assert.equal(objectLabel({ class: "MacroLine", macro: 950, no: 1 }), "Macro 950.1");
  assert.equal(objectLabel({ class: "Group", no: 5 }), "Group 5");
});

test("gma3_store_tag creates a tag with its name; a comma (which the console strips) is refused before sending", async () => {
  let r = await h.callJson("gma3_store_tag", { tag: 952, name: "Mcp,Tag:C" });
  assert.equal(r.isError, true);
  assert.match(r.text, /removes from names/);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_store_tag", { tag: 952, name: "McpTag:C" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.name, "McpTag:C");
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ['Store Tag 952 "McpTag:C" /NoConfirmation']);
});

test("gma3_store_tag refuses an occupied number unless if_exists is rename; rename labels it", async () => {
  con.tags.set(950, { name: "Old", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  let r = await h.callJson("gma3_store_tag", { tag: 950, name: "New" });
  assert.equal(r.isError, true);
  assert.match(r.text, /exists .*if_exists/);
  assert.deepEqual(h.fake.commands, []);
  r = await h.callJson("gma3_store_tag", { tag: 950, name: "New", if_exists: "rename" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.action, "rename");
  assert.equal(r.result.previousName, "Old");
  assert.deepEqual(h.fake.commands, ['Label Tag 950 "New"']);
  h.fake.requests.length = 0;
  r = await h.callJson("gma3_store_tag", { tag: 950, name: "New", if_exists: "rename" });
  assert.equal(r.result.action, "none");
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_store_tag refuses a name another tag has (the console would append #2)", async () => {
  con.tags.set(950, { name: "Encore", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  const r = await h.callJson("gma3_store_tag", { tag: 951, name: "Encore" });
  assert.equal(r.isError, true);
  assert.match(r.result.summary, /Tag 950 is already named "Encore".*Encore#2/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_store_tag batch creates several tags and refuses duplicates before sending", async () => {
  let r = await h.callJson("gma3_store_tag", { tags: [{ tag: 950, name: "A" }, { tag: 950, name: "B" }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /appears more than once/);
  r = await h.callJson("gma3_store_tag", { tags: [{ tag: 950, name: "A" }, { tag: 951, name: "B" }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.items.length, 2);
  assert.equal(con.tags.get(951)?.name, "B");
});

test("deleting a tag reports the objects it was removed from and re-reads them", async () => {
  con.tags.set(951, { name: "B", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  for (const k of ["Sequence 950", "Group 950", "Macro 950.1", "Sequence 950 Cue 1"]) con.objects.get(k)!.tags!.push({ tag: 951, protect: k === "Group 950" });
  const r = await h.callJson("gma3_delete_tag", { tag: "B" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ["Delete Tag 951 /NoConfirmation"]);
  assert.ok(r.result.removedFrom.every((o: { stillCarries: boolean }) => o.stillCarries === false));
  assert.equal(r.result.removedFromCount, 4);
  assert.deepEqual(r.result.removedFrom.map((o: { object: string }) => o.object).sort(), ["Group 950", "Macro 950.1", "Sequence 950", "Sequence 950 Cue 1 Part 0"]);
  assert.equal(r.result.removedFrom.find((o: { object: string }) => o.object === "Group 950").protect, true);
  assert.equal(con.tags.has(951), false);
  assert.ok(h.fake.requests.some((q) => q.op === "tags.of" && q.args.ref === "DataPool 1 Sequence 950 Cue 1 Part 0"), "a part is re-read by its command-line form in its data pool");
});

test("deleting a missing tag is refused without a command", async () => {
  const r = await h.callJson("gma3_delete_tag", { tags: [{ tag: 951 }] });
  assert.equal(r.isError, true);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_assign_tag assigns over a range by name, sets protect and reads every object back", async () => {
  con.tags.set(952, { name: "McpTag:C", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  const r = await h.callJson("gma3_assign_tag", { tag: "McpTag:C", target: "Sequence 950 Thru 952", protect: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(h.fake.commands, ["Assign Tag 952 At Sequence 950 Thru 952"]);
  assert.equal(r.result.verification.status, "matched");
  assert.equal(r.result.objects.length, 3);
  assert.ok(r.result.objects.every((o: { carries: boolean; protect: boolean; changed: boolean }) => o.carries && o.protect && o.changed));
  assert.equal(r.result.changedCount, 3);
});

test("gma3_assign_tag reports a cue target as its Part 0, and off removes the tag", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  let r = await h.callJson("gma3_assign_tag", { tag: 950, target: "Sequence 950 Cue 1" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.objects[0].object, "Sequence 950 Cue 1 Part 0");
  assert.match(r.result.warnings[0], /Part 0/);
  r = await h.callJson("gma3_assign_tag", { tag: 950, target: "Sequence 950 Cue 1", off: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.objects[0].carries, false);
  assert.equal(r.result.objects[0].changed, true);
});

test("gma3_assign_tag refuses a tag that does not exist (the console would answer OK and do nothing)", async () => {
  const r = await h.callJson("gma3_assign_tag", { tag: 999, target: "Sequence 950" });
  assert.equal(r.isError, true);
  assert.match(r.text, /does not exist.*answer OK/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_assign_tag refuses two tags with the same name, fixtures, and protect with off", async () => {
  con.tags.set(950, { name: "Dup", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  con.tags.set(951, { name: "Dup", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  let r = await h.callJson("gma3_assign_tag", { tag: "Dup", target: "Sequence 950" });
  assert.equal(r.isError, true);
  assert.match(r.text, /2 tags are named/);
  r = await h.callJson("gma3_assign_tag", { tag: 950, target: "Fixture 1" });
  assert.match(r.text, /fixtures cannot carry tags/);
  r = await h.callJson("gma3_assign_tag", { tag: 950, target: "Sequence 950", off: true, protect: true });
  assert.match(r.text, /protect applies to an assignment/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_assign_tag: an assignment the console ignores is a mismatch, not a success", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  con.ignoreAssign = true;
  const r = await h.callJson("gma3_assign_tag", { tag: 950, target: "Sequence 951" });
  assert.equal(r.isError, true);
  assert.equal(r.result.verification.status, "mismatched");
});

test("gma3_assign_tag batch: one tag for several targets; a lost reply stops the rest", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  let r = await h.callJson("gma3_assign_tag", { tag: 950, assignments: [{ target: "Group 950" }, { target: "Macro 950.1", protect: true }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(con.objects.get("Macro 950.1")!.tags![0].protect, true);
  con.silentOn = /Sequence 950$/;
  r = await h.callJson("gma3_assign_tag", { tag: 950, assignments: [{ target: "Sequence 950" }, { target: "Sequence 951" }] });
  assert.equal(r.isError, true);
  assert.equal(r.result.items[0].outcome, "unknown");
  assert.equal(r.result.items[1].outcome, "not_attempted");
});

test("gma3_configure_tag sets type, forwarding, action, appearance and note, and reads them back", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  const r = await h.callJson("gma3_configure_tag", { tag: "A", type: "Kill Delayed", forward_commands: false, action: "Toggle", appearance: 3, note: "encore, set" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, [
    'Set Tag 950 Property "TagType" "Kill Delayed"',
    'Set Tag 950 Property "ForwardCommands" "No"',
    'Set Tag 950 Property "Action" "Toggle"',
    "Assign Appearance 3 At Tag 950",
    'Set Tag 950 Property "Note" "encore, set"',
  ]);
  assert.equal(r.result.after.type, "Kill Delayed");
  h.fake.requests.length = 0;
  const c = await h.callJson("gma3_configure_tag", { tag: 950, appearance: null, note: "" });
  assert.equal(c.isError, false, c.text);
  assert.equal(con.tags.get(950)!.appearance, undefined);
});

test("gma3_configure_tag refuses values outside the enums and a missing appearance before sending", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  let r = await h.callJson("gma3_configure_tag", { tag: 950, type: "KillDelayed" });
  assert.equal(r.isError, true);
  r = await h.callJson("gma3_configure_tag", { tags: [{ tag: 950, action: "Off" }], type: "bogus" });
  assert.equal(r.isError, true);
  r = await h.callJson("gma3_configure_tag", { tag: 950, appearance: 7 });
  assert.equal(r.isError, true);
  assert.match(r.text, /Appearance 7 does not exist/);
  r = await h.callJson("gma3_configure_tag", { tag: 950 });
  assert.match(r.text, /at least one/);
  assert.deepEqual(h.fake.commands, []);
});

test("gma3_configure_tag: a value the console refuses fails at that step; later settings are not sent", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  const r = await h.callJson("gma3_configure_tag", { tag: 950, action: "Temp", note: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.result.outcome, "failed");
  assert.equal(r.result.steps.find((s: { name: string }) => s.name === "note").status, "skipped");
  assert.deepEqual(h.fake.commands, ['Set Tag 950 Property "Action" "Temp"']);
});

test("gma3_tags lists tags with their objects, filters by class (every sequence tagged Encore), and reads the tags of objects", async () => {
  con.tags.set(950, { name: "Encore", tagType: "Kill Instant", forwardCommands: true, action: "Pool Default", note: "" });
  con.objects.get("Sequence 950")!.tags!.push({ tag: 950, protect: false });
  con.objects.get("Group 950")!.tags!.push({ tag: 950, protect: true });
  let r = await h.callJson("gma3_tags", { tags: ["Encore"], class: "Sequence" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.tags[0].type, "Kill Instant");
  assert.deepEqual(r.result.tags[0].objects.map((o: { object: string }) => o.object), ["Sequence 950"]);
  r = await h.callJson("gma3_tags", {});
  assert.equal(r.result.tags[0].objects.length, 2);
  r = await h.callJson("gma3_tags", { tags: [999] });
  assert.deepEqual(r.result.missing, [999]);
  r = await h.callJson("gma3_tags", { of: "Group 950" });
  assert.deepEqual(r.result.objects[0].tags, [{ tag: 950, name: "Encore", protect: true }]);
});

test("gma3_assign_tag with data_pool tags only the sequence of that data pool, a cue there by its part", async () => {
  con.tags.set(950, { name: "A", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  const r = await h.callJson("gma3_assign_tag", { tag: 950, data_pool: 2, assignments: [{ target: "Sequence 950", protect: true }, { target: "Sequence 950 Cue 1" }], detail: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(h.fake.commands, ["Assign Tag 950 At DataPool 2 Sequence 950", "Assign Tag 950 At DataPool 2 Sequence 950 Cue 1"]);
  assert.equal(con.objects.get("DataPool 2 Sequence 950")!.tags![0].protect, true);
  assert.deepEqual(con.objects.get("Sequence 950")!.tags, []);
  assert.equal(r.result.items[0].result.objects[0].dataPool, "Pool 2");
  h.fake.requests.length = 0;
  const d = await h.callJson("gma3_delete_tag", { tag: 950 });
  assert.equal(d.isError, false, d.text);
  assert.ok(h.fake.requests.some((q) => q.op === "tags.of" && q.args.ref === "DataPool 2 Sequence 950 Cue 1 Part 0"), "a part of pool 2 is re-read in pool 2");
});

test("gma3_tags pages tags and each tag's objects, with totals and incomplete flags, and filters a number range", async () => {
  for (const n of [950, 951, 952]) con.tags.set(n, { name: `T${n}`, tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  for (const k of ["Sequence 950", "Sequence 951", "Sequence 952"]) con.objects.get(k)!.tags!.push({ tag: 950, protect: false });
  let r = await h.callJson("gma3_tags", { limit: 2, references_limit: 2 });
  assert.equal(r.result.total, 3);
  assert.equal(r.result.incomplete, true);
  assert.equal(r.result.tags[0].objects.length, 2);
  assert.equal(r.result.tags[0].objectsIncomplete, true);
  r = await h.callJson("gma3_tags", { tags: [950], references_offset: 2 });
  assert.equal(r.result.tags[0].objects.length, 1);
  assert.equal(r.result.tags[0].objectsIncomplete, false);
  r = await h.callJson("gma3_tags", { from: 951, to: 952, references: false });
  assert.deepEqual(r.result.tags.map((x: { tag: number }) => x.tag), [951, 952]);
  r = await h.callJson("gma3_tags", { tags: [950], data_pool: 2 });
  assert.equal(r.isError, true);
});

test("a playback command on a tag resolves its sequences first and reads each one back", async () => {
  con.tags.set(950, { name: "Encore", tagType: "None", forwardCommands: true, action: "Pool Default", note: "" });
  for (const k of ["Sequence 950", "Sequence 951", "Group 950"]) con.objects.get(k)!.tags!.push({ tag: 950, protect: false });
  const r = await h.ctx.mutations.run(() => tagPlayback(h.ctx, "Go+", 'Tag "Encore"'));
  assert.deepEqual(h.fake.commands, ["Go+ Tag 950"]);
  const st = r.playbackState as { sequences: Array<{ object: string; active: boolean }> };
  assert.deepEqual(st.sequences.map((x) => [x.object, x.active]), [["Sequence 950", true], ["Sequence 951", true]]);
  con.tags.get(950)!.tagType = "Kill Instant";
  con.tags.get(950)!.forwardCommands = false;
  const k = await tagPlayback(h.ctx, "Go+", "Tag 950");
  assert.match(String(k.warnings), /Forward Commands is off/);
  assert.match(String(k.warnings), /Kill Instant/);
  h.fake.requests.length = 0;
  await assert.rejects(tagPlayback(h.ctx, "Off", "Tag 999"), /does not exist; nothing was sent/);
  assert.deepEqual(h.fake.commands, []);
});

test("an old bridge says which version the tag tools need", async () => {
  con.oldBridge = true;
  let r = await h.callJson("gma3_tags", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /bridge 0\.36\.0/);
  r = await h.callJson("gma3_assign_tag", { tag: 950, target: "Sequence 950" });
  assert.match(r.text, /bridge 0\.36\.0/);
});
