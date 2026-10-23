import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { sameValue, setPropertyChecked } from "../src/tools/setproperty.js";

/**
 * gma3_set_property's read-back check against a fake bridge. A locked object keeps its value and the Set() raises
 * nothing (live 2026-10-22: HazeEnabled on the Show Start's locked RenderQuality "Gobo Animated" stayed "No").
 */

class Obj {
  props: Record<string, string> = { HazeEnabled: "No", Name: "Gobo Animated", Lock: "", SystemLocked: "No", FadeTime: "0.000" };
  install(h: Harness) {
    h.fake.on("objects", (args) => {
      const fields: Record<string, string> = {};
      for (const f of (args.fields as string[]) ?? []) if (f in this.props) fields[f] = this.props[f];
      return { total: 1, offset: 0, count: 1, items: [{ name: this.props.Name, class: "RenderQuality", fields }] };
    });
    h.fake.on("set", (args) => {
      const p = String(args.property);
      const v = String(args.value);
      if (p === "Lock") this.props.Lock = /^(yes|on|true)$/i.test(v) ? "Yes" : "";
      else if (this.props.Lock === "") this.props[p] = p === "FadeTime" ? Number(v).toFixed(3) : p === "HazeEnabled" ? (/^(yes|true)$/i.test(v) ? "Yes" : "No") : v;
      return { ref: args.ref, property: p, value: this.props[p] };
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

test("sameValue ignores case, spacing, number format and Yes/No spellings, not the value", () => {
  assert.ok(sameValue("Yes", true));
  assert.ok(sameValue("Off", "no"));
  assert.ok(sameValue("2.500", "2.5"));
  assert.ok(sameValue("2.5s", 2.5));
  assert.ok(sameValue({ name: "Seq 1" }, "seq  1"));
  assert.ok(!sameValue("No", "Yes"));
  assert.ok(!sameValue("2.5s", "2.5%"));
  assert.ok(!sameValue(null, "x"));
});
