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
  const row = (fixture: string) => ({ fixture, attribute: "Dimmer", cooked: true, stepCount: 2, steps: [{ step: 1, integrated: { valid: true, pool: 1, no: 9001 } }, { step: 2, integrated: { valid: true, pool: 1, no: 9000 } }] });
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
