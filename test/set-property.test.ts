import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { consoleForm, ownerRefs, sameTags, sameValue, setPropertyChecked } from "../src/tools/setproperty.js";

/**
 * gma3_set_property's read-back check against a fake bridge. A locked object keeps its value and the Set() raises
 * nothing (live 2026-10-22: HazeEnabled on the Show Start's locked RenderQuality "Gobo Animated" stayed "No").
 */

/** The console's form of commands, as SB-07 recorded them. */
const CONSOLE_FORM: Record<string, string> = { "go+ seq 1": "Go+ Sequence 1", "store cue 5 /merge /nc": "Store Cue 5 /Merge /NoConfirmation", "fixture 1 thru 5 at 50": "Fixture 1 Thru 5 At 50" };
/** A duration in the console's display text: "2.000", "1h00m00.00", "1d03h46m40.00" (SB-07). */
const waitText = (s: number) => {
  if (s < 3600) return s.toFixed(3);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${d ? `${d}d` : ""}${String(h).padStart(d ? 2 : 1, "0")}h${String(m).padStart(2, "0")}m${sec.toFixed(2).padStart(5, "0")}`;
};

class Obj {
  props: Record<string, string> = { HazeEnabled: "No", Name: "Gobo Animated", Lock: "", StructureLocked: "No", SystemLocked: "No", FadeTime: "0.000", Wait: "2.000", Appearance: "1", Command: "", CmdText: "Fixture 1", SpeedFromX: "1.000000" };
  install(h: Harness) {
    // The object's property list (object op with schema).
    h.fake.on("object", () => ({ name: this.props.Name, schema: Object.keys(this.props).map((name, index) => ({ name, index })) }));
    h.fake.on("objects", (args) => {
      // An appearance resolves to itself, as a reference property's target (asText false: summaries).
      // Appearances 3 and 5 share the name "Red" (review of PR #87): only the address tells them apart.
      // By name: Appearance "Blue" is Appearance 8. A bridge failure (not "not found") on "Appearance 66".
      const named = String(args.ref).match(/^Appearance "(.+)"$/);
      if (named) {
        const nos = Object.keys(this.appNames).filter((n) => this.appNames[n] === named[1]);
        return { total: nos.length, offset: 0, count: nos.length, items: nos.map((n) => ({ name: named[1], class: "Appearance", addr: `addr:app${n}` })) };
      }
      if (String(args.ref) === "Appearance 66") throw new Error("request timed out");
      if (this.owner && String(args.ref) === this.owner.ref && this.ownerFails) throw new Error("request timed out");
      if (this.owner && String(args.ref) === this.owner.ref) return { total: 1, offset: 0, count: 1, items: [{ name: "Owner", class: "Page", fields: { Lock: this.owner.Lock } }] };
      const app = String(args.ref).match(/^Appearance (\d+)$/);
      if (app && Number(app[1]) > 50) throw new Error(`no objects found for '${args.ref}'`);
      if (app) return { total: 1, offset: 0, count: 1, items: [{ name: this.appName(app[1]), class: "Appearance", addr: `addr:app${app[1]}` }] };
      const fields: Record<string, unknown> = {};
      for (const f of (args.fields as string[]) ?? []) {
        if (!(f in this.props)) continue;
        // asText false: a reference property comes back as the referenced object's summary.
        if (f === "Appearance" && (this.props.Appearance === "" || (this.rawFails && args.asText === false))) continue;
        fields[f] = args.asText === false && f in this.raw ? this.raw[f] : typeof this.props[f] === "string" && f !== "Appearance" ? this.props[f].trim() : f === "Appearance" && args.asText === false ? { name: this.appName(this.props.Appearance), class: "Appearance", addr: `addr:app${this.props.Appearance}` } : f === "Appearance" ? this.appName(this.props.Appearance) : this.props[f];
      }
      // A macro line's class and index give its default name (SB-07: "MacroLine 1").
      const line = /^Macro \d+\.(\d+)$/.exec(String(args.ref));
      return { total: 1, offset: 0, count: 1, items: [{ name: this.props.Name, class: line ? "MacroLine" : "RenderQuality", index: line ? Number(line[1]) : 2, fields }] };
    });
    h.fake.on("set", (args) => {
      const p = String(args.property);
      const v = String(args.value);
      // As on onPC 2.5.1: a lock reads "UL" when locked and "" when not.
      // A locked owner blocks the object's own Lock write too (a page for its executors).
      if (p === "Lock") {
        if (!(this.owner && this.owner.Lock !== "")) this.props.Lock = /^(yes|on|true)$/i.test(v) ? "UL" : "";
      }
      // The command line's CmdText silently refuses a write (KB-10).
      else if (p === "CmdText") {}
      // A macro line's Wait coerces a value it does not take to Follow (review of PR #87).
      // An appearance that does not exist (above 50) is not taken: the old one stays.
      else if (this.writable && p === "Appearance") {
        const byName = v.match(/^Appearance "(.+)"$/);
        const no = byName ? Object.keys(this.appNames).find((n) => this.appNames[n] === byName[1]) ?? "" : v.replace(/^Appearance /, "");
        if (no !== "" && !(Number(no) > 50) || v === "") this.props[p] = no;
      }
      // A macro line's Command is stored in the console's form (SB-07).
      else if (this.writable && p === "Command") this.props[p] = CONSOLE_FORM[v] ?? v;
      else if (this.writable && p === "AddToCmdline") this.props[p] = /^(yes|true)$/i.test(v) ? "Yes" : "No";
      // A cleared macro line name reads its default again (SB-07).
      else if (this.writable && p === "Name" && v === "" && /^Macro \d+\.\d+$/.test(String(args.ref))) this.props.Name = `MacroLine ${String(args.ref).split(".")[1]}`;
      // SpeedFromX 60 reads "1.000000" in the edit role and 60 raw (SB-02).
      else if (this.writable && p === "SpeedFromX") {
        this.raw.SpeedFromX = Number(v);
        this.props.SpeedFromX = (Number(v) / 60).toFixed(6);
      }
      else if (this.writable) this.props[p] = p === "FadeTime" ? Number(v).toFixed(3) : p === "HazeEnabled" ? (/^(yes|true)$/i.test(v) ? "Yes" : "No") : p === "Wait" ? (/^\d/.test(v) && Number(v) > 0 ? waitText(Number(v)) : "Follow") : v;
      // Clearing a reference: the property reads nil, and the set op sends no value.
      if (p === "Appearance" && this.props.Appearance === "") return { ref: args.ref, property: p, readOk: true };
      // A wait's raw value is its seconds; the display rounds them.
      if (this.writable && p === "Wait" && Number(v) > 0) this.raw.Wait = Number(v);
      // As getProp: the value trimmed, and exact (0.44.0) with the text as stored when trimming changed it.
      const stored = p === "Appearance" ? this.appName(this.props[p]) : this.props[p];
      return { ref: args.ref, property: p, value: stored.trim(), ...(stored.trim() !== stored ? { exact: stored } : {}) };
    });
  }
  /** Raw (asText false) values where they differ from the edit text. */
  raw: Record<string, number> = { SpeedFromX: 60 };
  /** The owner's read fails at the bridge. */
  ownerFails = false;
  /** The raw (asText false) read of Appearance raises, so the bridge leaves the field out. */
  rawFails = false;
  /** An owner (a page, for its executors) whose Lock blocks writes to this object. */
  owner: { ref: string; Lock: string } | null = null;
  /** A write is taken only with no lock on the object or its owner (StructureLocked is the console's own). */
  get writable() {
    return this.props.Lock === "" && this.props.StructureLocked !== "Yes" && !(this.owner && this.owner.Lock !== "");
  }
  /** The set op reads a reference back as the referenced object's name. */
  appNames: Record<string, string> = { "3": "Red", "5": "Red", "6": "Appearance 7", "8": "Blue" };
  appName(no: string) {
    return this.appNames[no] ?? `App ${no}`;
  }
}

async function setup() {
  const h = await startHarness(() => {});
  const o = new Obj();
  o.install(h);
  return { h, o };
}

test("set_property: a locked object keeps its value; the result is an error that names the lock (live 2026-10-22)", async () => {
  const { h, o } = await setup();
  o.props.Lock = "Yes";
  try {
    const { result, failed } = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: "Yes" });
    assert.equal(failed, true);
    assert.equal(result.verified, false);
    assert.equal(result.value, "No");
    assert.deepEqual(result.locked, { Lock: "Yes" });
    assert.match(String(result.error), /RenderQuality 2 is locked \(Lock = "Yes"\).*Unlock RenderQuality 2/);
  } finally {
    await h.close();
  }
});

test("set_property: an applied value matches, also in the console's spelling; a value kept on an unlocked object is an error", async () => {
  const { h, o } = await setup();
  try {
    let r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(r.result.value, "Yes");
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "FadeTime", value: 2.5 });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(r.result.verified, true);
    // Unlocking is not blocked by the lock it removes ("" reads as No).
    o.props.Lock = "Yes";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Lock", value: "No" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    // A value the console does not take, with no lock: still the old value, reported.
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property, value: o.props[String(args.property)] }));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Name", value: "Bogus" });
    assert.equal(r.failed, true);
    assert.equal(r.result.locked, undefined);
    assert.match(String(r.result.error), /did not apply Name = "Bogus".*still reads "Gobo Animated"/);
  } finally {
    await h.close();
  }
});

test("set_property: a refused rename of a locked object is not taken for a Yes/No or case spelling (review of PR #87)", async () => {
  const { h, o } = await setup();
  o.props.Lock = "Yes";
  try {
    o.props.Name = "Off";
    let r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Name", value: "No" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.locked, { Lock: "Yes" });
    o.props.Name = "gobo";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Name", value: "Gobo" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.match(String(r.result.error), /is locked/);
    // A number or boolean request on a text property is compared as the text the bridge sets ("2.5", "false").
    o.props.Name = "2.500";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Name", value: 2.5 });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.props.Name = "Off";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Name", value: false });
    assert.equal(r.failed, true, JSON.stringify(r.result));
  } finally {
    await h.close();
  }
});

test("set_property: a value the console replaced with its own (Wait \"abc\" reads Follow) is not applied, although it changed (review of PR #87)", async () => {
  const { h } = await setup();
  try {
    const r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: "abc" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.equal(r.result.value, "Follow");
    assert.match(String(r.result.error), /reads "Follow" after the write \(it was "2.000"\), not "abc"/);
    const ok = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: 3 });
    assert.equal(ok.failed, false, JSON.stringify(ok.result));
  } finally {
    await h.close();
  }
});

test("set_property: a Yes/No field named with Command or Cmd, a reference property, and a no-op on a locked object (review of PR #87)", async () => {
  const { h, o } = await setup();
  try {
    let r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "AddToCmdline", value: true });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    // Appearance reads back as the appearance's name: the request is resolved and compared by its object.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 3" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(r.result.value, "Red");
    // Already the requested value on a locked object: the state is right, and the result says the write was refused.
    o.props.HazeEnabled = "Yes";
    o.props.Lock = "Yes";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.match(String(r.result.note), /already read "Yes"; RenderQuality 2 is locked/);
    assert.deepEqual(r.result.locked, { Lock: "Yes" });
    // A locked object whose appearance is not the requested one is still an error.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 4" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    // ... also when the requested appearance has the same name as the kept one ("Red"): compared by address.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 5" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.equal(r.result.value, "Red");
    // ... and when the kept object is named exactly like the requested reference (Appearance 6 named "Appearance 7").
    o.props.Lock = "";
    await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 6" });
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 7" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.equal(r.result.value, "Appearance 7");
    // A reference that names no object is not applied, even when the kept object is named like it (unlocked too).
    o.props.Lock = "";
    o.appNames["6"] = "Appearance 99";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 99" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.equal(r.result.value, "Appearance 99", "the kept appearance is named like the request");
    // Clearing the reference reads back as nothing: that is the requested empty state, when the bridge says the read
    // worked (readOk). With a failed read (or an older bridge, which sends no readOk) it is unknown.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property, readOk: false, readError: "read failed" }));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.match(String(r.result.error), /could not be read back after the write \(read failed\)/);
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property }));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
  } finally {
    await h.close();
  }
});

test("set_property: locking an unlocked object verifies although Lock reads \"UL\" (review of PR #87)", async () => {
  const { h, o } = await setup();
  try {
    let r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Lock", value: "Yes" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(o.props.Lock, "UL");
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Lock", value: false });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Lock", value: true });
    assert.equal(r.failed, false, JSON.stringify(r.result));
  } finally {
    await h.close();
  }
});

test("set_property: a write whose read-back has no value is not verified, an unlock included (review of PR #87)", async () => {
  const { h, o } = await setup();
  o.props.Lock = "UL";
  // The set op sends no value when its read-back fails.
  h.fake.on("set", (args) => ({ ref: args.ref, property: args.property }));
  try {
    for (const [property, value] of [["Lock", false], ["SystemLocked", "No"], ["HazeEnabled", "Yes"]] as const) {
      const r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property, value });
      assert.equal(r.failed, true, `${property}: ${JSON.stringify(r.result)}`);
      assert.match(String(r.result.error), /could not be read back after the write/);
    }
  } finally {
    await h.close();
  }
});

test("set_property: the console's form of a command and a duration's display text verify; a misspelled property cleared with \"\" does not; quoted names and bridge failures (review of PR #87)", async () => {
  const { h, o } = await setup();
  try {
    for (const command of Object.keys(CONSOLE_FORM)) {
      const r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: command });
      assert.equal(r.failed, false, JSON.stringify(r.result));
      assert.equal(r.result.value, CONSOLE_FORM[command]);
    }
    for (const [secs, shown] of [[3600, "1h00m00.00"], [100000, "1d03h46m40.00"]] as const) {
      const r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: secs });
      assert.equal(r.result.value, shown);
      assert.equal(r.failed, false, JSON.stringify(r.result));
    }
    // A property the object does not have reads nothing before or after: a "" request proves nothing.
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property, readOk: true }));
    let r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Bogus", value: "" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.install(h);
    // A reference by quoted name resolves to its object.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: 'Appearance "Blue"' });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(o.props.Appearance, "8");
    // A repeated clear: empty before and after, on a property the object has.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    // Wait 0 reads Follow; "abc" also reads Follow and is still not applied.
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: 0 });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: "0" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    // A kept command on a locked line: a literal argument is never taken for an abbreviation.
    o.props.Command = "Echo xyzzy";
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "Echo xyz" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    // ... nor a capitalised word that did not change.
    o.props.Command = "Echo Xyzzy";
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "Echo xyz" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    // ... nor when the read before the write failed, so nothing shows the line did not change (review of PR #92).
    h.fake.on("objects", () => {
      throw new Error("request timed out");
    });
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "Echo Xyz" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.install(h);
    // A repeated abbreviated request finds its own console form again, unchanged (review of PR #87).
    o.props.Lock = "";
    // The second reads the same as a refused write would: not an error, and not verified (review of PR #92).
    for (let i = 0; i < 2; i++) {
      r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "go+ seq 1" });
      assert.equal(r.failed, false, JSON.stringify(r.result));
      assert.equal(r.result.value, "Go+ Sequence 1");
      assert.equal(r.result.verified, i === 0, JSON.stringify(r.result));
    }
    assert.match(String(r.result.warning), /console's form of "go\+ seq 1", but it did not change/);
    // Locked on that line, the console did not write it, so its form proves nothing: an error naming the lock
    // (review of PR #92: a kept "Echo Sequence" is not "Echo Seq").
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "go+ seq 1" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.match(String(r.result.error), /locked \(Lock = "UL"\)/);
    o.props.Command = "Echo Sequence";
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "Echo Seq" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    // ... and the same with the macro locked instead of its line.
    o.props.Lock = "";
    o.owner = { ref: "Macro 1", Lock: "UL" };
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "Echo Seq" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.lockedOwner, { ref: "Macro 1", Lock: "UL" });
    o.owner = null;
    o.props.Appearance = "8";
    // A bridge failure while resolving the requested object leaves the result unknown, never a match.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 66" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.match(String(r.result.error), /read to verify Appearance of RenderQuality 2 by its object failed .*request timed out/);
  } finally {
    await h.close();
  }
});

test("sameValue ignores case, spacing, number format and Yes/No spellings, not the value", () => {
  assert.ok(sameValue("Yes", true));
  assert.ok(sameValue("No", "off"));
  assert.ok(!sameValue("On", "Yes", "Request"), "an On/Off/Auto enum ignores Yes (SU-09)");
  assert.ok(!sameValue("Off", false, "Request"));
  assert.ok(sameValue("On", "on", "Request"));
  assert.ok(sameValue("0.050", "0:05", "Wait") && !sameValue("5.000", "0:05", "Wait"), "Wait 0:05 is 0.05 s (SB-07)");
  assert.ok(sameValue("2.500", "2.5"));
  assert.ok(sameValue("2.5s", 2.5));
  assert.ok(sameValue({ name: "Seq 1" }, "seq  1"));
  assert.ok(!sameValue("No", "Yes"));
  assert.ok(!sameValue("2.5s", "2.5%"));
  assert.ok(!sameValue(null, "x"));
  assert.ok(sameValue("Follow", "follow", "Trigger"));
  assert.ok(!sameValue("Off", "No", "Name"));
  assert.ok(!sameValue("gobo", "Gobo", "Name"));
  assert.ok(sameValue("Gobo", "Gobo", "Name"));
  assert.ok(!sameValue("2.500", 2.5, "Name"));
  assert.ok(!sameValue("Off", false, "Name"));
  assert.ok(sameValue("2.5", 2.5, "Name"));
  assert.ok(sameValue("Yes", true, "ForwardCommands"));
  assert.ok(sameValue("No", false, "AddToCmdline"));
  assert.ok(!consoleForm("Go+ Sequence 1", "go+ seq 2"), "a different number is not the console's form");
  assert.ok(!consoleForm('Echo "a b"', 'echo "A b"'), "quoted text compares exactly");
  assert.ok(!consoleForm("Go+ Sequence 1", "go+ macro 1"), "another keyword is not an abbreviation");
  assert.ok(!consoleForm("Echo xyzzy", "Echo xyz"), "a literal argument compares exactly");
  assert.ok(!consoleForm("Echo Xyzzy", "Echo Xyz"), "a capitalised literal argument is not a keyword");
  assert.ok(consoleForm("ClearAll; Label Executor 201 \"Gobo\"", "cleara; lab exec 201 \"Gobo\""), "keywords from the list");
  assert.ok(!sameValue("Follow", "abc", "Wait"));
  assert.ok(!sameValue("1h00m00.00", 3599, "Wait"));
});

test("set_property: StructureLocked, an owner's lock, a repeated clear on a locked object, a duration's display precision and an OSC Prefix (review of PR #92)", async () => {
  const { h, o } = await setup();
  try {
    // The console's own read-only lock: named, and not something Unlock removes.
    o.props.StructureLocked = "Yes";
    let r = await setPropertyChecked(h.bridge, { ref: "Sequence 9", property: "HazeEnabled", value: true });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.locked, { StructureLocked: "Yes" });
    assert.match(String(r.result.error), /StructureLocked = "Yes".*read-only locks, which Unlock does not remove/);
    o.props.StructureLocked = "No";
    // A locked page keeps its executor's value while the executor's own Lock reads "".
    o.owner = { ref: "Page 91", Lock: "UL" };
    r = await setPropertyChecked(h.bridge, { ref: "Page 91.201", property: "HazeEnabled", value: true });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.lockedOwner, { ref: "Page 91", Lock: "UL" });
    assert.match(String(r.result.error), /^Page 91 is locked \(Lock = "UL"\), which blocks writes to Page 91\.201.*Unlock Page 91/);
    o.owner = null;
    // A repeated clear on a locked object: the end state is right, and the note names the lock.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.deepEqual(r.result.locked, { Lock: "UL" });
    assert.match(String(r.result.note), /Appearance already read ""; RenderQuality 2 is locked/);
    o.props.Lock = "";
    // A bare number refers to an object of the class the property holds, compared by address (review of PR #92).
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: 3 });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(r.result.value, "Red");
    // A kept appearance that is named "3" is not Appearance 3.
    o.appNames["9"] = "3";
    o.props.Appearance = "9";
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: 3 });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.props.Lock = "";
    // A raw read that leaves the field out (its read raised) is unknown, not a match by the display name: Appearance 6
    // is named "Appearance 7" (review of PR #92).
    o.props.Appearance = "6";
    o.props.Lock = "UL";
    o.rawFails = true;
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 7" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.match(String(r.result.error), /raw read of Appearance returned no value.*unknown/);
    o.rawFails = false;
    o.props.Lock = "";
    // Spaces count in a text property: " cue " is stored as is and verifies; a kept " cue " is not "cue".
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Note", value: " cue " });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Note", value: "cue" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.props.Lock = "";
    // An executor that already has the value on a locked page: verified, with the page's lock in the note.
    o.owner = { ref: "Page 91", Lock: "UL" };
    r = await setPropertyChecked(h.bridge, { ref: "Page 91.201", property: "HazeEnabled", value: "No" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.deepEqual(r.result.lockedOwner, { ref: "Page 91", Lock: "UL" });
    assert.match(String(r.result.note), /Page 91 is locked .*which blocks writes to Page 91\.201, so the console did not take the write itself/);
    o.owner = null;
    // A locked macro whose Lock cannot be read keeps "Echo Sequence": not verified, with a warning that says so.
    o.props.Command = "Echo Sequence";
    o.owner = { ref: "Macro 1", Lock: "UL" };
    o.ownerFails = true;
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Command", value: "Echo Seq" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
    assert.equal(r.result.verified, false);
    assert.match(String(r.result.warning), /Lock of Macro 1 could not be read/);
    o.owner = null;
    o.ownerFails = false;
    // A reference property decides by object whatever the request: true names no appearance, so a kept one named
    // "Yes" is not taken for it (review of PR #92).
    o.appNames["10"] = "Yes";
    o.props.Appearance = "10";
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: true });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Yes" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.props.Lock = "";
    // CmdText refuses writes silently: a request differing only in case or spacing is not taken for it (review of
    // PR #92).
    for (const cmd of ["fixture 1", "Fixture  1"]) {
      r = await setPropertyChecked(h.bridge, { ref: "CmdLine", property: "CmdText", value: cmd });
      assert.equal(r.failed, true, JSON.stringify(r.result));
    }
    // An appearance with a blank name still is an object: a clear that keeps it is not applied (review of PR #92).
    o.appNames["11"] = "  ";
    o.props.Appearance = "11";
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    // An empty appearance that a lock keeps reads nil, which is empty, not unknown: the error names the lock.
    o.props.Appearance = "";
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "Appearance 3" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.match(String(r.result.error), /RenderQuality 2 is locked \(Lock = "UL"\)/);
    o.props.Lock = "";
    // The raw value decides a number: SpeedFromX 120 reads "2.000000" in the edit role; a short wait rounds.
    r = await setPropertyChecked(h.bridge, { ref: "MAtricks 1", property: "SpeedFromX", value: 120 });
    assert.equal(r.result.value, "2.000000");
    assert.equal(r.failed, false, JSON.stringify(r.result));
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: 2.0001 });
    assert.equal(r.result.value, "2.000");
    assert.equal(r.failed, false, JSON.stringify(r.result));
    // A cleared macro line name reads its default "MacroLine 1"; a kept custom name does not pass for a clear.
    o.props.Name = "Gobo";
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Name", value: "" });
    assert.equal(r.result.value, "MacroLine 1");
    assert.equal(r.failed, false, JSON.stringify(r.result));
    o.props.Name = "Gobo";
    o.props.Lock = "UL";
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Name", value: "" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    o.props.Lock = "";
    // Locking an executor on a locked page: the page blocks it, and the error names the page.
    o.owner = { ref: "Page 91", Lock: "UL" };
    r = await setPropertyChecked(h.bridge, { ref: "Page 91.201", property: "Lock", value: "Yes" });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.lockedOwner, { ref: "Page 91", Lock: "UL" });
    o.owner = null;
    // A long wait reads in hundredths: 3600.001 reads "1h00m00.00" and is applied.
    r = await setPropertyChecked(h.bridge, { ref: "Macro 1.1", property: "Wait", value: 3600.001 });
    assert.equal(r.result.value, "1h00m00.00");
    assert.equal(r.failed, false, JSON.stringify(r.result));
  } finally {
    await h.close();
  }
  assert.ok(!sameValue("/foo", "/Foo", "Prefix"), "an OSC Prefix is text");
  assert.ok(sameValue("1h00m00.00", "3600.004", "Wait") && !sameValue("1h00m00.00", 3600.01, "Wait"), "within half a hundredth");
  assert.ok(sameValue("2.000", 2.0004, "Wait") && !sameValue("2.000", 2.0004, "FadeTime"), "a Wait's display rounds");
  const tags = [{ tag: 2, name: "McpTag B", protect: false }, { tag: 3, name: "McpTag C", protect: true }];
  assert.equal(sameTags(tags, "McpTag B:0,McpTag C:1"), true, "tags by name with their protect flags");
  assert.equal(sameTags(tags, "McpTag C, McpTag B"), true, "in any order, flags not given");
  assert.equal(sameTags(tags, "McpTag B:1,McpTag C:1"), false, "a protect flag that differs");
  assert.equal(sameTags(tags, "McpTag B"), false, "a list of another length");
  assert.equal(sameTags(tags, "McpTag B,McpTag B"), false, "a tag twice is not two tags");
  assert.equal(sameTags(tags, ""), false, "a clear the console ignores (SU-21)");
  assert.equal(sameTags(tags, "#BC000E42:1"), undefined, "a request by handle is not compared by name");
  assert.deepEqual(ownerRefs("Page 91.201"), ["Page 91"]);
  assert.deepEqual(ownerRefs("Sequence 1 Cue 2.5 Part 1"), ["Sequence 1 Cue 2.5", "Sequence 1"]);
  assert.deepEqual(ownerRefs('Sequence "Gobo" Cue 3'), ['Sequence "Gobo"']);
  assert.deepEqual(ownerRefs("RenderQuality 2"), []);
});
