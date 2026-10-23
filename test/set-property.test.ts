import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { sameValue, setPropertyChecked } from "../src/tools/setproperty.js";

/**
 * gma3_set_property's read-back check against a fake bridge. A locked object keeps its value and the Set() raises
 * nothing (live 2026-10-22: HazeEnabled on the Show Start's locked RenderQuality "Gobo Animated" stayed "No").
 */

class Obj {
  props: Record<string, string> = { HazeEnabled: "No", Name: "Gobo Animated", Lock: "", SystemLocked: "No", FadeTime: "0.000", Wait: "2.000", Appearance: "1" };
  install(h: Harness) {
    h.fake.on("objects", (args) => {
      // An appearance resolves to itself, as a reference property's target (asText false: summaries).
      // Appearances 3 and 5 share the name "Red" (review of PR #87): only the address tells them apart.
      const app = String(args.ref).match(/^Appearance (\d+)$/);
      if (app && Number(app[1]) > 50) throw new Error(`no objects found for '${args.ref}'`);
      if (app) return { total: 1, offset: 0, count: 1, items: [{ name: this.appName(app[1]), class: "Appearance", addr: `addr:app${app[1]}` }] };
      const fields: Record<string, unknown> = {};
      for (const f of (args.fields as string[]) ?? []) {
        if (!(f in this.props)) continue;
        // asText false: a reference property comes back as the referenced object's summary.
        if (f === "Appearance" && this.props.Appearance === "") continue;
        fields[f] = f === "Appearance" && args.asText === false ? { name: this.appName(this.props.Appearance), class: "Appearance", addr: `addr:app${this.props.Appearance}` } : f === "Appearance" ? this.appName(this.props.Appearance) : this.props[f];
      }
      return { total: 1, offset: 0, count: 1, items: [{ name: this.props.Name, class: "RenderQuality", fields }] };
    });
    h.fake.on("set", (args) => {
      const p = String(args.property);
      const v = String(args.value);
      // As on onPC 2.5.1: a lock reads "UL" when locked and "" when not.
      if (p === "Lock") this.props.Lock = /^(yes|on|true)$/i.test(v) ? "UL" : "";
      // A macro line's Wait coerces a value it does not take to Follow (review of PR #87).
      // An appearance that does not exist (above 50) is not taken: the old one stays.
      else if (this.props.Lock === "" && p === "Appearance") { if (!(Number(v.replace(/^Appearance /, "")) > 50)) this.props[p] = v.replace(/^Appearance /, ""); }
      else if (this.props.Lock === "" && p === "AddToCmdline") this.props[p] = /^(yes|true)$/i.test(v) ? "Yes" : "No";
      else if (this.props.Lock === "") this.props[p] = p === "FadeTime" ? Number(v).toFixed(3) : p === "HazeEnabled" ? (/^(yes|true)$/i.test(v) ? "Yes" : "No") : p === "Wait" ? (/^\d/.test(v) ? Number(v).toFixed(3) : "Follow") : v;
      // Clearing a reference: the property reads nil, and the set op sends no value.
      if (p === "Appearance" && this.props.Appearance === "") return { ref: args.ref, property: p };
      return { ref: args.ref, property: p, value: p === "Appearance" ? this.appName(this.props[p]) : this.props[p] };
    });
  }
  /** The set op reads a reference back as the referenced object's name. */
  appNames: Record<string, string> = { "3": "Red", "5": "Red", "6": "Appearance 7" };
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
    // Clearing the reference reads back as nothing: that is the requested empty state.
    r = await setPropertyChecked(h.bridge, { ref: "RenderQuality 2", property: "Appearance", value: "" });
    assert.equal(r.failed, false, JSON.stringify(r.result));
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

test("sameValue ignores case, spacing, number format and Yes/No spellings, not the value", () => {
  assert.ok(sameValue("Yes", true));
  assert.ok(sameValue("Off", "no"));
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
});
