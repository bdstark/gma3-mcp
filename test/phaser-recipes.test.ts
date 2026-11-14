import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { registerPhaserRecipeTools, numberMatches } from "../src/tools/phaserrecipes.js";

/**
 * gma3_edit_phaser_recipe against a fake console that models the Edit Recipe facts of onPC 2.5.1 (THK migration
 * docs/phaser-recipes.md §1.5, §1.7): At Shape creates the PhaserRecipe line in Part Zero only in the mode, the store
 * moves it into the preset, ClearAll empties the programmer, a pending target makes EditRecipe open "Update last
 * object?" (the bridge ops are covered by test/lua/recipe_edit_test.lua).
 */
const UPDATE = { class: "MessageBox", name: "MsgBox", title: "Update last object?", text: "FeatureGroup 1 'Dimmer'.Preset 9006 'TEST PH'", buttons: [{ text: "OK", enabled: true }, { text: "Cancel", enabled: true }] };

async function setup(o: { pending?: boolean; programmer?: number; shapeFails?: boolean; slotTaken?: boolean } = {}) {
  const h = await startHarness(registerPhaserRecipeTools);
  const c = { editing: false, pz: [] as Array<{ index: number; class: string; name: string }>, modal: false as false | typeof UPDATE, preset: o.slotTaken === true, lines: 0, values: o.programmer ?? 0, pending: o.pending === true, name: "", speed: "60.00" };
  const cmds: string[] = [];
  const pressed: Array<Record<string, unknown>> = [];
  h.fake.onCommand((command) => {
    cmds.push(command);
    if (/^Store Preset 1\.9010 \/NoConfirmation$/.test(command)) {
      c.preset = true;
      c.pending = false;
    } else if (command === "At Shape 1") {
      if (c.editing && !o.shapeFails) {
        c.pz = [{ index: 1, class: "PhaserRecipe", name: "[9000 'TEST PH'/1 'Sine']" }];
        c.values = 8;
      }
    } else if (command === "Store Preset 1.9010 /Merge /NoConfirmation") {
      if (c.pz.length) c.lines = 1;
      c.pz = [];
      c.pending = true;
    } else if (command === "ClearAll") {
      c.values = 0;
      c.pz = [];
    } else if (command === "Delete Preset 1.9010 /NoConfirmation") c.preset = false;
    return "OK";
  });
  h.fake.on("recipe.editState", () => ({ environment: "Normal", editing: c.editing, editingRaw: String(c.editing), partZeroLines: c.pz, modal: c.modal, lastCommand: "OK" }));
  h.fake.on("recipe.editBegin", (args) => {
    assert.equal(args.exclusive, true);
    if (c.pending) c.modal = UPDATE;
    else c.editing = true;
    return { queued: true, command: `EditRecipe ${args.target}` };
  });
  h.fake.on("recipe.editEnd", (args) => {
    assert.equal(args.exclusive, true);
    if (!c.editing) throw new BridgeReplyError("[editing-off] off", "editing-off");
    c.editing = false;
    return { queued: true, command: "EditRecipe" };
  });
  h.fake.on("dialog.press", (args) => {
    pressed.push(args);
    c.modal = false;
    return { clicked: args.button };
  });
  h.fake.on("programmer", () => ({ environment: "Normal", total: c.values, count: 0, coverage: { complete: true }, rows: [] }));
  h.fake.on("preset.context", () => ({ preferencesReadable: true, preferences: { RecipeStoreMode: "Normal" } }));
  h.fake.on("objects", (args) => {
    const known = ["Group 9000", "Shape 1", "MAtricks 9000"].includes(String(args.ref));
    return { total: known ? 1 : 0, items: known ? [{ name: "x" }] : [], offset: 0, count: known ? 1 : 0 };
  });
  const row = (fixture: string) => ({ fixture, attribute: "Dimmer", cooked: true, stepCount: 2, speed: Number(c.speed) / 60, steps: [{ step: 1, integrated: { valid: true, pool: 1, no: 9001 } }, { step: 2, integrated: { valid: true, pool: 1, no: 9000 } }] });
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    if (ref === "Preset 1.9000" || ref === "Preset 1.9001") return { ref, rows: [], dependencies: [] };
    if (ref === "Preset 1.9010" && c.preset) return { ref, name: c.name, rows: c.lines ? ["1", "2", "3"].map(row) : [], dependencies: [] };
    throw new BridgeReplyError(`no object found for '${ref}'`);
  });
  h.fake.on("children", () => ({ total: c.lines, offset: 0, count: c.lines, items: c.lines ? [{ class: "PhaserRecipe", index: 1, name: "[9000 'TEST PH'/1 'Sine']", fields: { Selection: { class: "Group", index: 9000 }, MAtricks: { class: "MAtrick", index: 9000 }, FailedCookedPart: "None", Enabled: "Yes" } }] : [] }));
  h.fake.on("set", (args) => {
    if (args.property === "Name") c.name = String(args.value);
    if (args.property === "SPEEDX") c.speed = `${Number(args.value).toFixed(2)}`;
    return { value: args.property === "Name" ? c.name : `${Number(args.value).toFixed(2)}` };
  });
  return { h, c, cmds, pressed };
}

const ARGS = { action: "create", preset: "1.9010", name: "TEST PH NEW", selection: 9000, steps: [{ preset: "1.9001" }, { preset: "1.9000" }], matricks: 9000, speed_bpm: 120, phase: { from: 0, to: 360 }, exclusive: true };

test("create: empty store first, the build one command at a time, mode off, ClearAll, settings, cook, verified", async () => {
  const { h, c, cmds, pressed } = await setup({ pending: true });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Store Preset 1.9010 /NoConfirmation", "Group 9000", "At Shape 1", "Step 1", "At Preset 1.9001", "Step 2", "At Preset 1.9000", "MAtricks 9000", "Store Preset 1.9010 /Merge /NoConfirmation", "ClearAll", "Cook Preset 1.9010 /MergeLowPriority"]);
    assert.deepEqual(pressed, [], "the empty store clears the pending target: no dialog");
    assert.equal(c.editing, false);
    assert.equal(c.name, "TEST PH NEW");
    const sets = h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`);
    assert.deepEqual(sets, ["Preset 1.9010 Name=TEST PH NEW", "Preset 1.9010.1 SPEEDX=120", "Preset 1.9010.1 PHASEFROMX=0", "Preset 1.9010.1 PHASETOX=360"]);
    // EditRecipe is never a plain command (it could stall the bridge behind a dialog).
    assert.ok(!cmds.some((x) => /^EditRecipe/.test(x)));
  } finally {
    await h.close();
  }
});

test("create: refused before anything is sent (programmer not empty, slot taken, wrong pool, 3 steps, no exclusive)", async () => {
  for (const [opts, args, re] of [
    [{ programmer: 4 }, ARGS, /programmer holds 4 value/],
    [{ slotTaken: true }, ARGS, /Preset 1\.9010 exists/],
    [{}, { ...ARGS, steps: [{ preset: "4.9001" }, { preset: "1.9000" }] }, /pool 4.*pool 1/],
    [{}, { ...ARGS, steps: [{ preset: "1.9001" }, { preset: "1.9000" }, { preset: "1.9000" }] }, /exactly 2/],
    [{}, { ...ARGS, exclusive: undefined }, /exclusive must be true/],
    [{}, { ...ARGS, selection: 9999 }, /not in the show: Group 9999/],
  ] as const) {
    const { h, cmds } = await setup(opts);
    try {
      const { result, isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true);
      assert.match(text, re as RegExp);
      assert.equal(result.outcome, "failed");
      assert.deepEqual(cmds, []);
      assert.ok(!h.fake.requests.some((r) => r.op === "recipe.editBegin"));
    } finally {
      await h.close();
    }
  }
});

test("create: \"Update last object?\" opens anyway -> Cancel (never OK), then the created preset is removed", async () => {
  const { h, c, cmds, pressed } = await setup();
  // The empty store does not clear the pending target in this run.
  h.fake.onCommand((command) => {
    cmds.push(command);
    if (command.startsWith("Store Preset 1.9010 /NoConfirmation")) {
      c.preset = true;
      c.pending = true;
    } else if (command === "Delete Preset 1.9010 /NoConfirmation") c.preset = false;
    else if (command === "ClearAll") c.values = 0;
    return "OK";
  });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, true, JSON.stringify(result, null, 1));
    assert.equal(pressed.length, 1);
    assert.equal(pressed[0].button, "Cancel");
    assert.equal(pressed[0].expectTitle, "Update last object?");
    assert.match(result.summary, /cancelled \(never OK/);
    assert.deepEqual(cmds, ["Store Preset 1.9010 /NoConfirmation", "ClearAll", "Delete Preset 1.9010 /NoConfirmation"]);
    assert.equal(c.preset, false);
  } finally {
    await h.close();
  }
});

test("create: no line after At Shape -> mode switched off, ClearAll, the preset removed, nothing stored", async () => {
  const { h, c, cmds } = await setup({ shapeFails: true });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, true);
    assert.match(result.summary, /phaser line was not created/);
    assert.deepEqual(cmds, ["Store Preset 1.9010 /NoConfirmation", "Group 9000", "At Shape 1", "ClearAll", "Delete Preset 1.9010 /NoConfirmation"]);
    assert.ok(h.fake.requests.some((r) => r.op === "recipe.editEnd"));
    assert.equal(c.editing, false);
    assert.equal(c.preset, false);
  } finally {
    await h.close();
  }
});

test("create: a cooked speed that is not the one asked is a mismatch", async () => {
  const { h } = await setup();
  h.fake.on("set", (args) => ({ value: args.property === "Name" ? String(args.value) : `${Number(args.value).toFixed(2)}` })); // the reply matches, the cooked speed stays 60 BPM
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", ARGS);
    assert.equal(isError, true);
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /do not run at 120 BPM \(2\.000 Hz/);
  } finally {
    await h.close();
  }
});

test("preview: checks only, returns the plan", async () => {
  const { h, cmds } = await setup();
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { ...ARGS, exclusive: undefined, preview: true });
    assert.equal(result.preview, true);
    assert.ok(result.plan.some((p: string) => p.startsWith("Cook Preset 1.9010")));
    assert.deepEqual(cmds, []);
  } finally {
    await h.close();
  }
});

test("numberMatches reads the console's formatted replies", () => {
  assert.ok(numberMatches(120, "120.00"));
  assert.ok(numberMatches(360, "360.00°"));
  assert.ok(!numberMatches(360, "180.00"));
  assert.ok(!numberMatches(0, "None"));
});

/** A console with several lines: Copy appends a copy of line 1, Assign Preset at a value source retargets that step. */
async function multiSetup() {
  const s = await setup();
  const { h, c, cmds } = s;
  const lines: string[][] = [];
  const curveSet: Array<{ line: number; step: number; curve: string }> = [];
  const prev = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", async (args, req) => {
    const command = String(args.command);
    let m: RegExpMatchArray | null;
    if (command === "Store Preset 21.9000 /NoConfirmation") {
      cmds.push(command);
      c.preset = true;
      return { feedback: "OK" };
    }
    if (command === "Store Preset 21.9000 /Merge /NoConfirmation") {
      cmds.push(command);
      if (c.pz.length) lines.push(["1.9001", "1.9000"]);
      c.pz = [];
      return { feedback: "OK" };
    }
    if ((m = command.match(/^Copy Preset 21\.9000\.1 At Preset 21\.9000\.(\d+) \/NoConfirmation$/))) {
      cmds.push(command);
      lines.push([...lines[0]]);
      return { feedback: "OK" };
    }
    if ((m = command.match(/^Assign Preset (\d+\.\d+) At Preset 21\.9000\.(\d+)\.1\.(\d)\.1$/))) {
      cmds.push(command);
      lines[Number(m[2]) - 1][Number(m[3]) - 1] = m[1];
      return { feedback: "OK" };
    }
    if ((m = command.match(/^Set Preset 21\.9000\.(\d+)\.1\.(\d)\.1 Property "Curve" "(.+)"$/))) {
      cmds.push(command);
      curveSet.push({ line: Number(m[1]), step: Number(m[2]), curve: m[3] });
      return { feedback: "OK" };
    }
    return prev(args, req);
  });
  c.lines = 0;
  h.fake.on("children", () => ({ total: lines.length, offset: 0, count: lines.length, items: lines.map((_, i) => ({ class: "PhaserRecipe", index: i + 1, fields: { Selection: { class: "Group", index: 9000 }, MAtricks: { class: "MAtrick", index: 9000 }, FailedCookedPart: "None" } })) }));
  const speeds = new Map<number, number>();
  h.fake.on("set", (args) => {
    const m = String(args.ref).match(/^Preset 21\.9000\.(\d+)$/);
    if (m && args.property === "SPEEDX") speeds.set(Number(m[1]), Number(args.value));
    return { value: args.property === "Name" ? String(args.value) : `${Number(args.value).toFixed(2)}` };
  });
  const curveOf = (line: number, step: number) => curveSet.filter((x) => x.line === line && x.step === step).at(-1)?.curve;
  const EFFECT: Record<string, [number, number, number?]> = { Linear: [0, 0], "Ease In": [100, -100], "Ease Out": [-100, 100], "Ease In and Out": [-100, -100], Swing: [100, 100], Snap: [0, 0, 0] };
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    if (/^Preset (1\.900[01]|4\.900[01])$/.test(ref)) return { ref, rows: [], dependencies: [] };
    if (ref !== "Preset 21.9000" || !c.preset) throw new BridgeReplyError(`no object found for '${ref}'`);
    const rows = lines.flatMap((st, i) =>
      ["1", "2"].map((fixture) => {
        const steps = st.map((p, n) => ({ step: n + 1, integrated: { valid: true, pool: Number(p.split(".")[0]), no: Number(p.split(".")[1]) }, trans: 100, accel: -100, decel: -100 }));
        for (let n = 0; n < 2; n++) {
          const cv = curveOf(i + 1, n + 1);
          if (!cv) continue;
          const [d, a, t] = EFFECT[cv];
          steps[n].decel = d;
          steps[(n + 1) % 2].accel = a;
          if (t !== undefined) steps[n].trans = t;
        }
        return { fixture, attribute: st[0].startsWith("4.") ? "ColorRGB_R" : "Dimmer", cooked: true, stepCount: 2, speed: (speeds.get(i + 1) ?? speeds.get(1) ?? 60) / 60, steps };
      }),
    );
    return { ref, rows, dependencies: [] };
  });
  return { ...s, lines, curveSet };
}

const MULTI = {
  action: "create",
  preset: "21.9000",
  name: "TEST PH DIM COUL",
  lines: [
    { selection: 9000, steps: [{ preset: "1.9001" }, { preset: "1.9000", curve: "snap" }], matricks: 9000, speed_bpm: 120 },
    { selection: 9000, steps: [{ preset: "4.9000" }, { preset: "4.9001" }], matricks: 9000, speed_bpm: 30, phase: { from: 0, to: 180 } },
  ],
  exclusive: true,
};

test("create with lines: line 1 in Edit Recipe mode, line 2 copied and retargeted, each with its speed; curves set and verified", async () => {
  const { h, cmds, lines, curveSet } = await multiSetup();
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MULTI);
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(lines, [["1.9001", "1.9000"], ["4.9000", "4.9001"]]);
    assert.ok(cmds.includes("Copy Preset 21.9000.1 At Preset 21.9000.2 /NoConfirmation"));
    assert.ok(!cmds.some((x) => /^Assign (Group|MAtricks)/.test(x)), "same group and MAtricks as line 1: nothing to reassign");
    assert.deepEqual(curveSet, [{ line: 1, step: 2, curve: "Snap" }]);
    assert.equal(cmds.at(-1), "Cook Preset 21.9000 /MergeLowPriority");
    const sets = h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`);
    assert.deepEqual(sets, ["Preset 21.9000 Name=TEST PH DIM COUL", "Preset 21.9000.1 SPEEDX=120", "Preset 21.9000.2 SPEEDX=30", "Preset 21.9000.2 PHASEFROMX=0", "Preset 21.9000.2 PHASETOX=180"]);
  } finally {
    await h.close();
  }
});

test("create with lines: a curve the console did not apply is a mismatch", async () => {
  const { h, curveSet } = await multiSetup();
  const prev = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", async (args, req) => {
    const r = await prev(args, req);
    if (/Property "Curve"/.test(String(args.command))) curveSet.pop(); // "OK", but nothing changes
    return r;
  });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MULTI);
    assert.equal(isError, true);
    assert.match(result.verification.detail, /line 1 step 2: 2 value\(s\) do not have the Snap curve/);
  } finally {
    await h.close();
  }
});

test("create with lines: families in a feature pool, mixed steps, duplicate lines and both forms are refused before anything is sent", async () => {
  for (const [args, re] of [
    [{ ...MULTI, preset: "1.9010" }, /lines\[1\]: its step presets are in pool 4.*All pool \(21-25\)/],
    [{ ...MULTI, lines: [{ selection: 9000, steps: [{ preset: "1.9001" }, { preset: "4.9000" }] }] }, /one family per line/],
    [{ ...MULTI, lines: [MULTI.lines[0], MULTI.lines[0]] }, /same 2 step presets/],
    [{ ...MULTI, selection: 9000 }, /not both/],
    [{ ...MULTI, lines: [MULTI.lines[0], { ...MULTI.lines[1], matricks: undefined }] }, /give every line one/],
    [{ ...MULTI, lines: [{ ...MULTI.lines[0], steps: [{ preset: "1.9001", curve: "bounce" }, { preset: "1.9000" }] }] }, /input validation failed|curve must be one of/],
  ] as const) {
    const { h, cmds } = await multiSetup();
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
    } finally {
      await h.close();
    }
  }
});
