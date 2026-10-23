import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { comparePlain, setPropertyChecked } from "../src/tools/setproperty.js";

/**
 * gma3_set_property's read-back check against a fake bridge. A locked object keeps its value and the Set() raises
 * nothing (live 2026-10-22: HazeEnabled on the Show Start's locked RenderQuality "Gobo Animated" stayed "No").
 * Plain values are verified; references, a macro line's Command and Wait, Tags and display-converted values are
 * returned unverified with the typed tool that checks them.
 */

class Obj {
  props: Record<string, string> = { HazeEnabled: "No", Name: "Gobo Animated", Note: "", Lock: "", SystemLocked: "No", FadeTime: "0.000", Request: "On", AddToCmdline: "No", CmdText: "Fixture 1", SpeedFromX: "1.000000", Appearance: "1", Command: "", Wait: "2.000", Tags: "", Level: "2.000" };
  /** Raw (asText false) numbers where they differ from the edit text (SB-02: SpeedFromX 60 reads "1.000000"). */
  raw: Record<string, number> = { SpeedFromX: 60, FadeTime: 0 };
  /** The before-read leaves Lock out (its read raised). */
  lockUnread = false;
  /** The before-read fails at the bridge. */
  readFails = false;
  /** The raw read leaves the field out (its read raised). */
  rawFails = false;
  install(h: Harness) {
    h.fake.on("objects", (args) => {
      if (this.readFails && args.asText !== false) throw new Error("request timed out");
      const fields: Record<string, unknown> = {};
      for (const f of (args.fields as string[]) ?? []) {
        if (!(f in this.props) || (this.lockUnread && f === "Lock" && args.asText !== false)) continue;
        if (args.asText === false) {
          if (this.rawFails) continue;
          // A reference property's raw value is a handle summary.
          fields[f] = f === "Appearance" ? { name: `App ${this.props.Appearance}`, class: "Appearance", addr: `addr:app${this.props.Appearance}` } : f in this.raw ? this.raw[f] : this.props[f];
        } else fields[f] = f === "Appearance" ? `App ${this.props.Appearance}` : this.props[f].trim();
      }
      return { total: 1, offset: 0, count: 1, items: [{ name: this.props.Name, class: "RenderQuality", fields }] };
    });
    h.fake.on("set", (args) => {
      const p = String(args.property);
      const v = String(args.value);
      const writable = this.props.Lock === "" && this.props.SystemLocked !== "Yes";
      // As on onPC 2.5.1: a lock reads "UL" when locked and "" when not.
      if (p === "Lock") this.props.Lock = /^(yes|on|true)$/i.test(v) ? "UL" : "";
      // The command line's CmdText silently refuses a write (KB-10); the DMX Request ignores "Yes" (SU-09).
      else if (p === "CmdText" || (p === "Request" && !/^(auto|on|off)$/i.test(v))) {}
      else if (writable && p === "SpeedFromX") {
        this.raw.SpeedFromX = Number(v);
        this.props.SpeedFromX = (Number(v) / 60).toFixed(6);
      } else if (writable && p === "FadeTime") {
        this.raw.FadeTime = Number(v);
        this.props.FadeTime = Number(v).toFixed(3);
      } else if (writable && (p === "HazeEnabled" || p === "AddToCmdline")) this.props[p] = /^(yes|true)$/i.test(v) ? "Yes" : "No";
      else if (writable && p === "Command") this.props[p] = v === "go+ seq 1" ? "Go+ Sequence 1" : v;
      else if (writable && p === "Wait") this.props[p] = Number(v) >= 3600 ? "1h00m00.00" : Number(v) > 0 ? Number(v).toFixed(3) : "Follow";
      // A level the console clamps to 5.
      else if (writable && p === "Level") this.props[p] = Math.min(Number(v), 5).toFixed(3);
      else if (writable && p === "Appearance") this.props[p] = v.replace(/^Appearance /, "");
      else if (writable) this.props[p] = v;
      // A cleared reference reads nil, and the set op sends no value.
      if (p === "Appearance" && this.props.Appearance === "") return { ref: args.ref, property: p, readOk: true };
      // As getProp: the value trimmed, and exact (0.44.0) with the text as stored when trimming changed it.
      const stored = p === "Appearance" ? `App ${this.props[p]}` : this.props[p];
      return { ref: args.ref, property: p, value: stored.trim(), readOk: true, ...(stored.trim() !== stored ? { exact: stored } : {}) };
    });
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
  o.props.Lock = "UL";
  try {
    const { result, failed } = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: "Yes" });
    assert.equal(failed, true);
    assert.equal(result.verification, "failed");
    assert.equal(result.verified, false);
    assert.equal(result.value, "No");
    assert.deepEqual(result.lock, { state: "locked", Lock: "UL", SystemLocked: "No" });
    assert.match(String(result.error), /RenderQuality 2 is locked \(Lock = "UL"\).*Unlock RenderQuality 2/);
    // SystemLocked is the console's own lock, which Unlock does not remove.
    o.props.Lock = "";
    o.props.SystemLocked = "Yes";
    const sys = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: "Yes" });
    assert.equal(sys.failed, true);
    assert.match(String(sys.result.error), /SystemLocked = "Yes".*read-only lock, which Unlock does not remove/);
  } finally {
    await h.close();
  }
});

test("set_property: plain values verify: Yes/No, numbers by their raw value, enums, text exactly with spaces", async () => {
  const { h, o } = await setup();
  try {
    const ok = async (property: string, value: string | number | boolean, readBack: string) => {
      const r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property, value });
      assert.equal(r.failed, false, JSON.stringify(r.result));
      assert.equal(r.result.verification, "verified", JSON.stringify(r.result));
      assert.equal(r.result.value, readBack);
      assert.equal((r.result.lock as { state: string }).state, "unlocked");
    };
    await ok("HazeEnabled", true, "Yes");
    await ok("AddToCmdline", "yes", "Yes");
    await ok("FadeTime", 2.5, "2.500");
    await ok("Request", "Off", "Off");
    await ok("Name", "Gobo", "Gobo");
    // The edit text is in other units; the raw value is the request (SB-02).
    await ok("SpeedFromX", 120, "2.000000");
    // Spaces count in a text property: value is trimmed, exact is not.
    const r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Note", value: " cue " });
    assert.equal(r.result.verification, "verified", JSON.stringify(r.result));
    assert.equal(r.result.exact, " cue ");
    // Locking and unlocking: Lock reads "UL" and "".
    await ok("Lock", "Yes", "UL");
    await ok("Lock", false, "");
    // Already the requested value on a locked object: verified, and the note says the write itself was refused.
    o.props.HazeEnabled = "Yes";
    o.props.Lock = "UL";
    const same = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(same.result.verification, "verified");
    assert.match(String(same.result.note), /already read "Yes"; RenderQuality 2 is locked \(Lock = "UL"\)/);
  } finally {
    await h.close();
  }
});

test("set_property: a kept or replaced plain value is an error, also when it differs only in spelling or spaces", async () => {
  const { h, o } = await setup();
  try {
    const fails = async (property: string, value: string | number | boolean, error: RegExp) => {
      const r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property, value });
      assert.equal(r.failed, true, JSON.stringify(r.result));
      assert.equal(r.result.verification, "failed");
      assert.match(String(r.result.error), error);
    };
    // Unlocked, and still the old value.
    await fails("CmdText", "fixture 1", /did not apply CmdText = "fixture 1".*still reads "Fixture 1"/);
    await fails("CmdText", "Fixture  1", /still reads "Fixture 1"/);
    // An On/Off/Auto enum ignores "Yes": its On is not Yes.
    await fails("Request", "Yes", /did not apply Request = "Yes".*still reads "On"/);
    o.props.Lock = "UL";
    // A refused rename is not taken for a Yes/No, case, number or spacing spelling.
    o.props.Name = "Off";
    await fails("Name", "No", /is locked/);
    o.props.Name = "gobo";
    await fails("Name", "Gobo", /is locked/);
    o.props.Name = "2.500";
    await fails("Name", 2.5, /is locked/);
    o.props.Note = " cue ";
    await fails("Note", "cue", /is locked/);
    // A kept raw number decides, not its display: SpeedFromX raw 60 displays "1.000000", which is not 1.
    await fails("SpeedFromX", 1, /is locked.*kept SpeedFromX = "1.000000"/);
    // A number the console replaced with another plain number: not a display form, an error.
    o.props.Lock = "";
    await fails("Level", 10, /reads "5.000" after the write \(it was "2.000"\), not 10/);
    // Lock left out of the read, SystemLocked "No": the lock state is unknown, not unlocked.
    o.props.Lock = "UL";
    o.lockUnread = true;
    const lu = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(lu.failed, true, JSON.stringify(lu.result));
    assert.deepEqual(lu.result.lock, { state: "unknown", SystemLocked: "No" });
    assert.match(String(lu.result.error), /whether RenderQuality 2 is locked is unknown/);
    o.lockUnread = false;
    // A lock whose state cannot be read is reported as unknown.
    o.props.Lock = "";
    o.props.Name = "Gobo Animated";
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property, value: o.props[String(args.property)], readOk: true }));
    o.readFails = true;
    let r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Name", value: "Bogus" });
    assert.equal(r.failed, true);
    assert.deepEqual(r.result.lock, { state: "unknown" });
    assert.match(String(r.result.error), /value before could not be read/);
    o.readFails = false;
    // A failed read-back is never verified; nor one from an older bridge that sends neither value nor readOk.
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property, readOk: false, readError: "read failed" }));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(r.failed, true);
    assert.match(String(r.result.error), /could not be read back after the write \(read failed\)/);
    h.fake.on("set", (args) => ({ ref: args.ref, property: args.property }));
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(r.failed, true);
  } finally {
    await h.close();
  }
});

test("set_property: the lock is unknown when the read before the write fails, and a kept value says so", async () => {
  const { h, o } = await setup();
  try {
    // The before-read fails once, then the property reads again for the comparison.
    let first = true;
    h.fake.on("objects", (args) => {
      if (first) {
        first = false;
        return { total: 1, offset: 0, count: 1, items: [{ name: "x", class: "RenderQuality", fields: { HazeEnabled: "No" } }] };
      }
      return { total: 1, offset: 0, count: 1, items: [{ name: "x", class: "RenderQuality", fields: { HazeEnabled: args.asText === false ? false : "No" } }] };
    });
    o.props.Lock = "UL";
    const r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "HazeEnabled", value: true });
    assert.equal(r.failed, true, JSON.stringify(r.result));
    assert.deepEqual(r.result.lock, { state: "unknown" });
    assert.match(String(r.result.error), /still reads "No", and whether RenderQuality 2 is locked is unknown/);
  } finally {
    await h.close();
  }
});

test("set_property: references, a macro line's Command and Wait, Tags and display-converted values are unverified, with the typed tool", async () => {
  const { h, o } = await setup();
  try {
    const unverified = async (property: string, value: string | number | boolean, hint: RegExp | null) => {
      const r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property, value });
      assert.equal(r.failed, false, JSON.stringify(r.result));
      assert.equal(r.result.verification, "unverified", JSON.stringify(r.result));
      assert.equal(r.result.verified, false);
      if (hint) assert.match(String(r.result.hint), hint);
      return r;
    };
    let r = await unverified("Appearance", "Appearance 3", /gma3_get_object/);
    assert.equal(r.result.value, "App 3");
    // A boolean on a reference property is not compared with the referenced object's name.
    o.props.Lock = "UL";
    r = await unverified("Appearance", true, /gma3_get_object/);
    assert.equal(r.result.unchanged, true);
    assert.equal((r.result.lock as { state: string }).state, "locked");
    o.props.Lock = "";
    // A cleared reference reads nothing.
    await unverified("Appearance", "", /gma3_get_object/);
    r = await unverified("Command", "go+ seq 1", /gma3_macros.*gma3_edit_macro_line/);
    assert.equal(r.result.value, "Go+ Sequence 1");
    r = await unverified("Wait", 3600, /gma3_edit_macro_line/);
    assert.equal(r.result.value, "1h00m00.00");
    await unverified("Tags", "McpTag B:0", /gma3_assign_tag/);
    // A raw value that cannot be read leaves a plain value unknown.
    o.rawFails = true;
    await unverified("HazeEnabled", true, null);
    o.rawFails = false;
  } finally {
    await h.close();
  }
});

test("comparePlain: Yes/No only on a Yes/No property, numbers by raw value or number text, text exactly", () => {
  assert.equal(comparePlain("Yes", true), "match");
  assert.equal(comparePlain("No", "off"), "match");
  assert.equal(comparePlain("On", "Yes", "Request"), "differs");
  assert.equal(comparePlain("On", "on", "Request"), "match");
  assert.equal(comparePlain("2.500", 2.5), "match");
  assert.equal(comparePlain("60.00 BPM", 60), "match");
  assert.equal(comparePlain("1.000000", 60, "SpeedFromX", 60), "match");
  assert.equal(comparePlain("1.000000", 1, "SpeedFromX", 60), "differs");
  assert.equal(comparePlain("1h00m00.00", 3600), "reformatted");
  assert.equal(comparePlain("5.000", 10), "differs");
  assert.equal(comparePlain("5.00 BPM", 10), "reformatted");
  assert.equal(comparePlain("Gobo", "gobo", "Name"), "differs");
  assert.equal(comparePlain("2.5", 2.5, "Name"), "match");
  assert.equal(comparePlain("cue", " cue ", "Note"), "differs");
});
