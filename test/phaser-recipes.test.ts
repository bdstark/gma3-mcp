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

async function setup(o: { pending?: boolean; programmer?: number; shapeFails?: boolean; slotTaken?: boolean; prefs?: Record<string, string> } = {}) {
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
  h.fake.on("preset.context", () => ({ preferencesReadable: true, preferences: { RecipeStoreMode: "Normal", StoreSource: "Programmer", ChannelFilter: "Active", StoreLook: "No", ...o.prefs } }));
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

test("create: refused before anything is sent (programmer not empty, slot taken, wrong pool, 3 steps, no exclusive, store preferences)", async () => {
  for (const [opts, args, re] of [
    [{ programmer: 4 }, ARGS, /programmer holds 4 value/],
    [{ slotTaken: true }, ARGS, /Preset 1\.9010 exists/],
    [{}, { ...ARGS, steps: [{ preset: "4.9001" }, { preset: "1.9000" }] }, /one family per line.*pools 4 and 1/],
    [{}, { ...ARGS, steps: [{ preset: "1.9001" }, { preset: "1.9000" }, { preset: "1.9000" }] }, /exactly 2/],
    [{}, { ...ARGS, exclusive: undefined }, /exclusive must be true/],
    [{}, { ...ARGS, selection: 9999 }, /not in the show: Group 9999/],
    // Review of #130: store preferences that would put more than the recipe line into the preset (probe SB-03).
    [{ prefs: { StoreSource: "Output" } }, ARGS, /StoreSource is \\?"Output\\?", not Programmer/],
    [{ prefs: { ChannelFilter: "All" } }, ARGS, /ChannelFilter is \\?"All\\?": the store would take inactive/],
    [{ prefs: { ChannelFilter: "All For Selected" } }, ARGS, /ChannelFilter is \\?"All For Selected\\?"/],
    [{ prefs: { StoreLook: "Yes" } }, ARGS, /StoreLook is \\?"Yes\\?"/],
  ] as const) {
    const { h, cmds } = await setup(opts as Parameters<typeof setup>[0]);
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

test("create: a phaser preset in another family's pool is allowed (the pool does not filter recipe lines)", async () => {
  const { h } = await multiSetup();
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { ...MULTI, preset: "2.9010", preview: true, exclusive: undefined });
    assert.equal(result.preview, true, JSON.stringify(result));
    assert.equal(result.outcome, "succeeded");
  } finally {
    await h.close();
  }
});

test("preview: a line whose steps come from an All pool is allowed, with a one-family-per-line warning", async () => {
  const { h } = await setup();
  h.fake.on("preset.read", (args) => {
    if (String(args.ref) === "Preset 1.9010") throw new BridgeReplyError("no object found for 'Preset 1.9010'");
    return { ref: args.ref, rows: [], dependencies: [] };
  });
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { ...ARGS, preset: "1.9010", steps: [{ preset: "21.5" }, { preset: "21.6" }], preview: true, exclusive: undefined });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result));
    assert.match(result.warnings.join(" "), /line 1 takes its steps from an All pool \(21\).*one family per line/);
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
    // A copy keeps its source's custom curves: line 1's are set after line 2 is copied.
    assert.ok(cmds.indexOf('Set Preset 21.9000.1.1.2.1 Property "Curve" "Snap"') > cmds.indexOf("Copy Preset 21.9000.1 At Preset 21.9000.2 /NoConfirmation"));
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

test("create with lines (review of #130): step layers preset.read leaves out at their default still match the curve", async () => {
  const { h } = await multiSetup();
  const prev = h.fake.handlerFor("preset.read")!;
  h.fake.on("preset.read", async (args, req) => {
    const r = (await prev(args, req)) as { rows?: Array<{ steps?: Array<Record<string, unknown>> }> };
    // As the bridge reports a layer at its default: absent (accel and decel 0, trans 100).
    for (const row of r.rows ?? []) for (const st of row.steps ?? []) for (const [k, d] of [["accel", 0], ["decel", 0], ["trans", 100]] as const) if (st[k] === d) delete st[k];
    return r;
  });
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", MULTI);
    assert.equal(isError, false, JSON.stringify(result.verification));
    assert.equal(result.verification.status, "matched");
  } finally {
    await h.close();
  }
});

test("create with lines: mixed steps, duplicate lines and both forms are refused before anything is sent", async () => {
  for (const [args, re] of [
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

// ---- Editing an existing phaser preset (set, add_line, remove_line), against a fake console that models the facts
// verified live on 21.9005 (2026-11-14): Assign retargets a line or a step (a step keeps its curve), a new shape
// recomputes the steps without a custom curve, "Reset" restores the shape's, Copy keeps line 1's custom curves,
// Delete moves the later lines up, and on one fixture and attribute the later line's value wins.
type FStep = { preset: string; accel: number; decel: number; trans: number; custom: boolean };
type FLine = { cls?: string; group: number; shape: number; matricks: number | null; speedHz: number; phaseFrom: number; phaseTo: number; steps: FStep[] };
const SHAPE_CURVE: Record<number, [number, number]> = { 1: [-100, -100], 2: [0, 0] }; // [accel, decel] per step: Sine, Linear
const NAMED: Record<string, [number, number, number?]> = { Linear: [0, 0], "Ease In": [100, -100], "Ease Out": [-100, 100], "Ease In and Out": [-100, -100], Swing: [100, 100], Snap: [0, 0, 0] };
const fstep = (preset: string, shape = 1): FStep => ({ preset, accel: SHAPE_CURVE[shape][0], decel: SHAPE_CURVE[shape][1], trans: 100, custom: false });
const fline = (group: number, a: string, b: string, speedBpm: number): FLine => ({ group, shape: 1, matricks: 9000, speedHz: speedBpm / 60, phaseFrom: 0, phaseTo: 360, steps: [fstep(a), fstep(b)] });

async function editSetup(initial: FLine[], o: { modal?: boolean; editing?: boolean } = {}) {
  const h = await startHarness(registerPhaserRecipeTools);
  const lines: FLine[] = structuredClone(initial);
  const cmds: string[] = [];
  const st = { name: "TEST PH EDIT", ignoreAssignPreset: false, assignGroupToLine1: false, dimmerAbsolute: undefined as number | undefined, dimmerAbsoluteAfterCook: undefined as number | undefined, dropDimmerAfterCook: false, dimmerDropped: false, presetRows: {} as Record<string, Array<{ fixture: string; attribute: string; sfIndex?: number; mode?: string; fixtureType?: string }>>, groups: {} as Record<number, Array<{ fixture: string; sfIndex: number }>>, types: {} as Record<string, string>, typeText: {} as Record<number, string>, attrs: {} as Record<string, string[]> };
  const P = "Preset 21.9005";
  const addr = (cls: string, n: number, pool?: number) => ({ class: cls, index: n, addr: `14.14.1.${cls === "Preset" ? `5.${pool}` : 6}.${n}` });
  h.fake.on("recipe.editState", () => ({ environment: "Normal", editing: o.editing === true, partZeroLines: [], partZero: false, modal: o.modal ? UPDATE : false, lastCommand: "OK" }));
  h.fake.on("objects", (args) => {
    const known = ["Group 9000", "Group 9001", "Shape 1", "Shape 2", "MAtricks 9000"].includes(String(args.ref));
    return { total: known ? 1 : 0, items: known ? [{ name: "x" }] : [], offset: 0, count: known ? 1 : 0 };
  });
  h.fake.on("children", (args) => {
    const ref = String(args.ref);
    let m: RegExpMatchArray | null;
    const list = (items: unknown[]) => ({ total: items.length, offset: 0, count: items.length, items });
    if (ref === P)
      return list(lines.map((l, i) => ({ class: l.cls ?? "PhaserRecipe", index: i + 1, name: `[${l.group}/${l.shape}]`, fields: { Selection: addr("Group", l.group), MAtricks: l.matricks ? { class: "MAtrick", index: l.matricks, addr: `14.14.1.11.${l.matricks}` } : null, SHAPE: { class: "Shape", index: l.shape, addr: `14.14.1.4.${l.shape}` }, SPEEDX: l.speedHz, PHASEFROMX: l.phaseFrom, PHASETOX: l.phaseTo, FailedCookedPart: "None" } })));
    if ((m = ref.match(/^Preset 21\.9005\.(\d+)\.1$/))) return list(lines[Number(m[1]) - 1].steps.map((_, n) => ({ class: "PhaserRecipeStep", index: n + 1 })));
    if ((m = ref.match(/^Preset 21\.9005\.(\d+)\.1\.(\d)$/))) {
      const x = lines[Number(m[1]) - 1].steps[Number(m[2]) - 1];
      const [pool, no] = x.preset.split(".").map(Number);
      return list([{ class: "PhaserRecipeValueSource", index: 1, fields: { ACCELX: x.accel, DECELX: x.decel, TRANSX: x.trans, Preset: addr("Preset", no, pool) } }]);
    }
    throw new BridgeReplyError(`no object found for '${ref}'`);
  });
  // As on the console: fixtureAttributes names the type ("LED"); preset.read's rows and typesFor use the display text ("6 LED").
  h.fake.on("fixtureAttributes", (args) => {
    const fid = String(args.ref).replace(/^Fixture /, "");
    const attrs = st.attrs[fid];
    if (!attrs && !st.types[fid]) throw new BridgeReplyError(`no object found for '${args.ref}'`);
    const list = (attrs ?? []).map((attribute) => ({ attribute }));
    return { fid, fixtureType: st.types[fid], total: list.length, offset: 0, count: list.length, attributes: list };
  });
  h.fake.on("group.read", (args) => {
    const n = Number(String(args.ref).replace(/^Group /, ""));
    const members = st.groups[n];
    if (!members) throw new BridgeReplyError(`no object found for '${args.ref}'`);
    return { ref: args.ref, count: members.length, items: members.map((m) => ({ fixture: m.fixture, sfIndex: m.sfIndex })) };
  });
  h.fake.on("preset.read", (args) => {
    const ref = String(args.ref);
    // A step preset's own content (review of #138: masking is judged from it): pool 1 holds Dimmer, pool 4 ColorRGB_R
    // on every fixture of both groups, unless the test sets it.
    const content = st.presetRows[ref] ?? (/^Preset (1\.901[01]|4\.900[01])$/.test(ref) ? ["101", "251", "252"].map((fixture) => ({ fixture, attribute: ref.startsWith("Preset 4.") ? "ColorRGB_R" : "Dimmer" })) : undefined);
    const types = Array.isArray(args.typesFor) ? Object.fromEntries((args.typesFor as number[]).filter((sf) => st.typeText[sf]).map((sf) => [String(sf), st.typeText[sf]])) : undefined;
    if (content) return { ref, rows: content.map((r) => ({ ...r, cooked: false, stepCount: 1 })), dependencies: [], ...(types ? { types } : {}) };
    if (ref !== P) throw new BridgeReplyError(`no object found for '${ref}'`);
    const out = new Map<string, unknown>();
    lines.forEach((l) => {
      if (l.cls === "StandardRecipe") return;
      for (const fixture of l.group === 9001 ? ["251", "252"] : ["101"]) {
        const attribute = l.steps[0].preset.startsWith("4.") ? "ColorRGB_R" : "Dimmer";
        if (attribute === "Dimmer" && st.dimmerDropped) continue;
        const absolute = attribute === "Dimmer" && st.dimmerAbsolute !== undefined ? { absolute: st.dimmerAbsolute } : {};
        const steps = l.steps.map((x, n) => ({ step: n + 1, ...absolute, accel: x.accel, decel: x.decel, trans: x.trans, integrated: { valid: true, pool: Number(x.preset.split(".")[0]), no: Number(x.preset.split(".")[1]) } }));
        out.set(`${fixture}|${attribute}`, { fixture, attribute, cooked: true, stepCount: 2, speed: l.speedHz, steps }); // the later line wins
      }
    });
    return { ref, name: st.name, referencedBy: 1, rows: [...out.values()], dependencies: [] };
  });
  h.fake.on("set", (args) => {
    const m = String(args.ref).match(/^Preset 21\.9005\.(\d+)$/);
    const v = Number(args.value);
    if (args.property === "Name") st.name = String(args.value);
    else if (m && args.property === "SPEEDX") lines[Number(m[1]) - 1].speedHz = v / 60;
    else if (m && args.property === "PHASEFROMX") lines[Number(m[1]) - 1].phaseFrom = v;
    else if (m && args.property === "PHASETOX") lines[Number(m[1]) - 1].phaseTo = v;
    return { value: args.property === "Name" ? st.name : `${v.toFixed(2)}` };
  });
  h.fake.onCommand((command) => {
    cmds.push(command);
    let m: RegExpMatchArray | null;
    if ((m = command.match(/^Assign (Group|Shape|MAtricks) (\d+) At Preset 21\.9005\.(\d+)$/))) {
      const l = lines[(st.assignGroupToLine1 ? 1 : Number(m[3])) - 1];
      if (m[1] === "Group") l.group = Number(m[2]);
      if (m[1] === "MAtricks") l.matricks = Number(m[2]);
      if (m[1] === "Shape") {
        l.shape = Number(m[2]);
        for (const x of l.steps) if (!x.custom) [x.accel, x.decel] = SHAPE_CURVE[l.shape];
      }
    } else if ((m = command.match(/^Assign Preset (\d+\.\d+) At Preset 21\.9005\.(\d+)\.1\.(\d)\.1$/))) {
      if (!st.ignoreAssignPreset) lines[Number(m[2]) - 1].steps[Number(m[3]) - 1].preset = m[1];
    } else if ((m = command.match(/^Set Preset 21\.9005\.(\d+)\.1\.(\d)\.1 Property "Curve" "(.+)"$/))) {
      const l = lines[Number(m[1]) - 1];
      const n = Number(m[2]) - 1;
      const own = l.steps[n];
      const next = l.steps[(n + 1) % 2];
      if (m[3] === "Reset") {
        own.custom = false;
        [, own.decel] = SHAPE_CURVE[l.shape];
        own.trans = 100;
        [next.accel] = SHAPE_CURVE[l.shape];
      } else {
        const [d, a, t] = NAMED[m[3]];
        own.custom = true;
        own.decel = d;
        next.accel = a;
        if (t !== undefined) own.trans = t;
      }
    } else if (/^Cook Preset 21\.9005/.test(command) && (st.dimmerAbsoluteAfterCook !== undefined || st.dropDimmerAfterCook)) {
      if (st.dimmerAbsoluteAfterCook !== undefined) st.dimmerAbsolute = st.dimmerAbsoluteAfterCook;
      if (st.dropDimmerAfterCook) st.dimmerDropped = true;
    } else if ((m = command.match(/^Copy Preset 21\.9005\.1 At Preset 21\.9005\.(\d+) \/NoConfirmation$/))) lines.push(structuredClone(lines[0]));
    else if ((m = command.match(/^Delete Preset 21\.9005\.(\d+) \/NoConfirmation$/))) lines.splice(Number(m[1]) - 1, 1);
    return "OK";
  });
  return { h, lines, cmds, st };
}

const DIM_COUL = [fline(9001, "1.9010", "1.9011", 120), fline(9001, "4.9000", "4.9001", 30)];

test("set: step presets, curve and speed on one line, sent as Assign / Set without the programmer, other line unchanged", async () => {
  const { h, lines, cmds } = await editSetup(DIM_COUL);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9001" }, { preset: "4.9000", curve: "swing" }], speed_bpm: 45 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Assign Preset 4.9001 At Preset 21.9005.2.1.1.1", "Assign Preset 4.9000 At Preset 21.9005.2.1.2.1", 'Set Preset 21.9005.2.1.2.1 Property "Curve" "Reset"', 'Set Preset 21.9005.2.1.2.1 Property "Curve" "Swing"', "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "set").map((r) => `${r.args?.ref} ${r.args?.property}=${r.args?.value}`), ["Preset 21.9005.2 SPEEDX=45"]);
    assert.ok(!h.fake.requests.some((r) => /^(programmer|recipe\.edit(Begin|End))$/.test(r.op)), "no programmer, no Edit Recipe mode");
    assert.equal(lines[1].steps[1].decel, 100);
    assert.equal(lines[1].steps[0].accel, 100);
    assert.match(result.notes.join(" "), /cues that call Preset 21\.9005 .* follow the change/);
  } finally {
    await h.close();
  }
});

test("set: a change to an untouched line's cooked step values is a mismatch, even with the same presets, speed and curves (review of #130)", async () => {
  const { h, st } = await editSetup(DIM_COUL);
  try {
    st.dimmerAbsolute = 100;
    st.dimmerAbsoluteAfterCook = 0;
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, speed_bpm: 45 });
    assert.equal(isError, true, JSON.stringify(result, null, 1));
    assert.notEqual(result.verification.status, "matched");
    assert.match(JSON.stringify(result), /value\(s\) of the other lines changed \(first: 25[12] Dimmer 1\.9010\/1\.9011: step 1 absolute 100 -> 0\)/);
  } finally {
    await h.close();
  }
});

test("set: unchanged cooked step values of the other lines still match, within 0.5 %", async () => {
  const { h, st } = await editSetup(DIM_COUL);
  try {
    st.dimmerAbsolute = 100;
    st.dimmerAbsoluteAfterCook = 99.8;
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, speed_bpm: 45 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
  } finally {
    await h.close();
  }
});

test("set: a new shape first, then the curves; a reset goes back to the shape's curve", async () => {
  const start = structuredClone(DIM_COUL);
  Object.assign(start[0].steps[0], { custom: true, decel: 0, trans: 0 }); // Snap on line 1 step 1
  start[0].steps[1].accel = 0;
  const { h, lines, cmds } = await editSetup(start);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", shape: 2, steps: [{ curve: "reset" }, { curve: "ease_out" }] });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Assign Shape 2 At Preset 21.9005.1", 'Set Preset 21.9005.1.1.1.1 Property "Curve" "Reset"', 'Set Preset 21.9005.1.1.2.1 Property "Curve" "Reset"', 'Set Preset 21.9005.1.1.2.1 Property "Curve" "Ease Out"', "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(lines[0].steps.map((x) => [x.accel, x.decel, x.trans]), [[100, 0, 100], [0, -100, 100]]);
    assert.match(result.warnings.join(" "), /new shape recomputes the curves/);
  } finally {
    await h.close();
  }
});

test("add_line: a copy of line 1 retargeted; steps without a curve are reset (a copy keeps line 1's custom curves)", async () => {
  const start = [structuredClone(DIM_COUL[0])];
  Object.assign(start[0].steps[0], { custom: true, decel: 0, trans: 0 });
  start[0].steps[1].accel = 0;
  const { h, lines, cmds } = await editSetup(start);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "add_line", preset: "21.9005", selection: 9000, steps: [{ preset: "4.9000", curve: "ease_in" }, { preset: "4.9001" }], speed_bpm: 30 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, [
      "Copy Preset 21.9005.1 At Preset 21.9005.2 /NoConfirmation",
      "Assign Group 9000 At Preset 21.9005.2",
      "Assign Preset 4.9000 At Preset 21.9005.2.1.1.1",
      "Assign Preset 4.9001 At Preset 21.9005.2.1.2.1",
      'Set Preset 21.9005.2.1.1.1 Property "Curve" "Reset"',
      'Set Preset 21.9005.2.1.2.1 Property "Curve" "Reset"',
      'Set Preset 21.9005.2.1.1.1 Property "Curve" "Ease In"',
      "Cook Preset 21.9005 /MergeLowPriority",
    ]);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1].steps.map((x) => x.trans), [100, 100], "line 1's Snap is not inherited");
    assert.equal(lines[1].speedHz, 0.5);
    assert.equal(lines[1].matricks, 9000, "MAtricks not given: line 1's");
  } finally {
    await h.close();
  }
});

test("remove_line: the line is deleted, the later lines move up and are compared under their new number", async () => {
  const { h, lines, cmds } = await editSetup([...DIM_COUL, fline(9000, "1.9011", "1.9010", 60)]);
  try {
    const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "remove_line", preset: "21.9005", line: 2 });
    assert.equal(isError, false, JSON.stringify(result, null, 1));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(cmds, ["Delete Preset 21.9005.2 /NoConfirmation", "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(lines.map((l) => l.group), [9001, 9000]);
  } finally {
    await h.close();
  }
});

test("edit: a line masked on the same fixtures by the edited line may change; other lines' values are still compared", async () => {
  // Line 2 (Dimmer on the same fixtures as line 1) masks line 1; retargeting line 2 to colour unmasks line 1's values.
  const { h } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9011", "1.9010", 60)]);
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9000" }, { preset: "4.9001" }] });
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  } finally {
    await h.close();
  }
});

test("edit (review of #130): editing a line a later line fully masks matches; its definition is still checked", async () => {
  // Line 2 masks every cooked value of line 1 (same group, same Dimmer attribute, later wins): line 1 cooks nothing.
  const { h } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9011", "1.9010", 60)]);
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90, detail: true });
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.ok((result.notes ?? []).some((n: string) => /line 1 cooks no value: line 2 .* masks it/.test(n)), JSON.stringify(result.notes));
  } finally {
    await h.close();
  }
});

test("edit (review of #138): a later line of another attribute family does not mask the edited line", async () => {
  // DIM_COUL: line 1 Dimmer and line 2 colour on the same group. Line 1's Dimmer values vanish after the edit; the colour
  // line cooks other attributes, so it does not mask line 1: a mismatch, not a masked match.
  const { h, st } = await editSetup(DIM_COUL);
  try {
    st.dropDimmerAfterCook = true;
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
    assert.equal(result.verification.status, "mismatched", JSON.stringify(result.verification));
    assert.match(result.verification.detail, /no cooked value comes from line 1/);
  } finally {
    await h.close();
  }
});

test("edit (review of #138): a later pool-4 ColorWheel line does not mask an RGB line that cooks nothing", async () => {
  // Line 1 RGB (4.9000 / 4.9001), line 2 ColorWheel1 (4.9002 / 4.9003), both on Group 9001: the fake cooks both as one
  // attribute, so line 1 shows no value. The pool is the same, but the presets hold different attributes: not masked.
  const { h, st } = await editSetup([fline(9001, "4.9000", "4.9001", 120), fline(9001, "4.9002", "4.9003", 60)]);
  try {
    for (const ref of ["Preset 4.9002", "Preset 4.9003"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "ColorWheel1" }));
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
    assert.equal(result.verification.status, "mismatched", JSON.stringify(result.verification));
    assert.match(result.verification.detail, /no cooked value comes from line 1/);
  } finally {
    await h.close();
  }
});

test("edit (review of #138): a red line retargeted to blue is not masked by a later red line", async () => {
  // Line 1 red (4.9002 / 4.9003) is retargeted to blue (4.9004 / 4.9005); line 2 is red (4.9000 / 4.9001) on the same
  // group. Line 1 cooks nothing after the edit: line 2 covers its old red values but not the blue ones it should output.
  const { h, st } = await editSetup([fline(9001, "4.9002", "4.9003", 120), fline(9001, "4.9000", "4.9001", 60)]);
  try {
    for (const ref of ["Preset 4.9002", "Preset 4.9003"]) st.presetRows[ref] = ["101", "251", "252"].map((fixture) => ({ fixture, attribute: "ColorRGB_R" }));
    for (const ref of ["Preset 4.9004", "Preset 4.9005"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "ColorRGB_B" }));
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, steps: [{ preset: "4.9004" }, { preset: "4.9005" }] });
    assert.equal(result.verification.status, "mismatched", JSON.stringify(result.verification));
    assert.match(result.verification.detail, /no cooked value comes from line 1/);
  } finally {
    await h.close();
  }
});

test("edit (review of #138): masking needs the cell too; unreadable step presets prove nothing", async () => {
  {
    // The later line's presets hold only cell 2 of the fixtures; the edited line's presets cell 1: not masked.
    const { h, st } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9011", "1.9010", 60)]);
    try {
      st.presetRows["Preset 1.9010"] = [{ fixture: "251", attribute: "Dimmer", sfIndex: 1 }];
      st.presetRows["Preset 1.9011"] = [{ fixture: "251", attribute: "Dimmer", sfIndex: 2 }];
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
      // Both lines use the same two presets (swapped), so their coverage is the same union: masked, matched.
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    } finally {
      await h.close();
    }
  }
  {
    const { h, st } = await editSetup([fline(9001, "4.9000", "4.9001", 120), fline(9001, "4.9002", "4.9003", 60)]);
    try {
      st.presetRows["Preset 4.9002"] = ["251", "252"].map((fixture) => ({ fixture, attribute: "ColorRGB_R", sfIndex: 2 }));
      st.presetRows["Preset 4.9003"] = ["251", "252"].map((fixture) => ({ fixture, attribute: "ColorRGB_R", sfIndex: 2 }));
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
      assert.equal(result.verification.status, "mismatched", "cell 2 does not cover the edited line's values (no cell)");
    } finally {
      await h.close();
    }
  }
  {
    const { h, st } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9011", "1.9010", 60)]);
    try {
      st.presetRows["Preset 1.9010"] = [];
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
      assert.equal(result.verification.status, "mismatched", "an empty step preset proves no coverage");
    } finally {
      await h.close();
    }
  }
});

test("edit (follow-up #138): masking coverage counts only the fixtures the line's group selects", async () => {
  // Presets hold 101, 251 and 252; Group 9001 is 251 and 252. Line 2 (Dimmer on 251/252 only) masks line 1 on everything
  // line 1 outputs, though its presets do not hold 101: matched.
  const sel = [{ fixture: "251", sfIndex: 251 }, { fixture: "252", sfIndex: 252 }];
  {
    const { h, st } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9012", "1.9013", 60)]);
    try {
      st.groups[9001] = sel;
      for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "Dimmer" }));
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90, detail: true });
      assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
      assert.ok((result.notes ?? []).some((n: string) => /line 1 cooks no value: line 2 .* masks it/.test(n)), JSON.stringify(result.notes));
    } finally {
      await h.close();
    }
  }
  {
    // The group also holds 101, which line 2's presets do not: not masked.
    const { h, st } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9012", "1.9013", 60)]);
    try {
      st.groups[9001] = [{ fixture: "101", sfIndex: 101 }, ...sel];
      for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "Dimmer" }));
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
      assert.equal(result.verification.status, "mismatched", JSON.stringify(result.verification));
      assert.match(result.verification.detail, /no cooked value comes from line 1/);
    } finally {
      await h.close();
    }
  }
  {
    // The group cannot be read: no cut, so the uncovered 101 keeps it a mismatch (as before).
    const { h, st } = await editSetup([fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9012", "1.9013", 60)]);
    try {
      for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "Dimmer" }));
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
      assert.equal(result.verification.status, "mismatched", JSON.stringify(result.verification));
    } finally {
      await h.close();
    }
  }
});

test("edit (follow-up #140): global preset rows apply by fixture type, universal rows to every selected fixture with the attribute", async () => {
  const sel = [{ fixture: "251", sfIndex: 251 }, { fixture: "252", sfIndex: 252 }];
  // Rows and typesFor carry the display text "6 LED"; fixtureAttributes names the type "LED" (review of #140: the two
  // forms must not be compared with each other).
  const global = (fixture: string, fixtureType: string) => [{ fixture, attribute: "Dimmer", mode: "global", fixtureType }];
  const run = async (setPresets: (st: any) => void, lines = [fline(9001, "1.9010", "1.9011", 120), fline(9001, "1.9012", "1.9013", 60)]) => {
    const { h, st } = await editSetup(lines);
    try {
      st.groups[9001] = sel;
      st.types = { "101": "LED", "251": "LED", "252": "LED" };
      st.typeText = { 251: "6 LED", 252: "6 LED" };
      st.attrs = { "251": ["Dimmer", "ColorRGB_R"], "252": ["Dimmer", "ColorRGB_R"] };
      setPresets(st);
      const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 1, speed_bpm: 90 });
      return result.verification.status;
    } finally {
      await h.close();
    }
  };
  // Both lines' presets hold global Dimmer rows on 101 (the lowest FID of the type, outside Group 9001 = 251/252).
  assert.equal(await run((st) => {
    for (const ref of ["Preset 1.9010", "Preset 1.9011", "Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = global("101", "6 LED");
  }), "matched");
  // The edited line's global row on 101 applies to 251/252; the later line covers them selectively: matched.
  assert.equal(await run((st) => {
    for (const ref of ["Preset 1.9010", "Preset 1.9011"]) st.presetRows[ref] = global("101", "6 LED");
    for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "Dimmer" }));
  }), "matched");
  // A universal row covers every selected fixture that has the attribute.
  assert.equal(await run((st) => {
    for (const ref of ["Preset 1.9010", "Preset 1.9011"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "Dimmer" }));
    for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = [{ fixture: "101", attribute: "Dimmer", mode: "universal" }];
  }), "matched");
  // The later line's global row is of another type: it covers none of Group 9001.
  assert.equal(await run((st) => {
    for (const ref of ["Preset 1.9010", "Preset 1.9011"]) st.presetRows[ref] = global("101", "6 LED");
    for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = global("301", "4 Spot");
  }), "mismatched");
  // A member's type cannot be read: the global row stays as itself and the selective cover does not match it.
  assert.equal(await run((st) => {
    st.typeText = { 251: "6 LED" };
    for (const ref of ["Preset 1.9010", "Preset 1.9011"]) st.presetRows[ref] = global("101", "6 LED");
    for (const ref of ["Preset 1.9012", "Preset 1.9013"]) st.presetRows[ref] = ["251", "252"].map((fixture) => ({ fixture, attribute: "Dimmer" }));
  }), "mismatched");
  // Group 9001: 251 has RGB, 252 is dimmer-only. The edited line's universal ColorRGB_R (held on 251) reaches only 251,
  // which the later line covers selectively: matched.
  const rgb = [fline(9001, "4.9002", "4.9003", 120), fline(9001, "4.9004", "4.9005", 60)];
  assert.equal(await run((st) => {
    st.attrs = { "251": ["Dimmer", "ColorRGB_R"], "252": ["Dimmer"] };
    for (const ref of ["Preset 4.9002", "Preset 4.9003"]) st.presetRows[ref] = [{ fixture: "251", attribute: "ColorRGB_R", mode: "universal" }];
    for (const ref of ["Preset 4.9004", "Preset 4.9005"]) st.presetRows[ref] = [{ fixture: "251", attribute: "ColorRGB_R" }];
  }, rgb), "matched");
  // The same with 252's attributes unreadable: the universal row stays as itself, no proof.
  assert.equal(await run((st) => {
    st.attrs = { "251": ["Dimmer", "ColorRGB_R"] };
    st.types = {};
    for (const ref of ["Preset 4.9002", "Preset 4.9003"]) st.presetRows[ref] = [{ fixture: "251", attribute: "ColorRGB_R", mode: "universal" }];
    for (const ref of ["Preset 4.9004", "Preset 4.9005"]) st.presetRows[ref] = [{ fixture: "251", attribute: "ColorRGB_R" }];
  }, rgb), "mismatched");
});

test("edit: a step preset the console did not take, or another line changed, is a mismatch", async () => {
  {
    const { h, st } = await editSetup(DIM_COUL);
    st.ignoreAssignPreset = true;
    try {
      const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "4.9001" }, { preset: "4.9000" }] });
      assert.equal(isError, true);
      assert.match(result.verification.detail, /line 2 step 1 preset reads 4\.9000, 4\.9001 expected/);
    } finally {
      await h.close();
    }
  }
  {
    const { h, st } = await editSetup(DIM_COUL);
    st.assignGroupToLine1 = true;
    try {
      const { result, isError } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, selection: 9000 });
      assert.equal(isError, true);
      assert.match(result.verification.detail, /line 1 selection reads Group 9000, Group 9001 expected/);
      assert.match(result.verification.detail, /value\(s\) of the other lines changed/);
    } finally {
      await h.close();
    }
  }
});

test("edit: refused before anything is sent", async () => {
  const std = [{ ...fline(9001, "1.9010", "1.9011", 60), cls: "StandardRecipe", steps: [] }, DIM_COUL[1]];
  for (const [start, opts, args, re] of [
    [DIM_COUL, {}, { action: "set", preset: "21.9006", speed_bpm: 60 }, /Preset 21\.9006 is not in the show/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", line: 3, speed_bpm: 60 }, /no line 3/],
    [[DIM_COUL[0]], {}, { action: "remove_line", preset: "21.9005", line: 1 }, /only line .* delete the preset instead/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "1.9010" }, { preset: "1.9011" }] }, /line 1 already has the step presets 1\.9010\/1\.9011/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", line: 2, steps: [{ preset: "1.9010" }, {}] }, /one preset pool .* pools 1 and 4/],
    [DIM_COUL, {}, { action: "add_line", preset: "21.9005", selection: 9001, steps: [{ preset: "1.9010" }, { preset: "1.9011" }] }, /same 2 step presets|already has the step presets/],
    [std, {}, { action: "set", preset: "21.9005", line: 1, speed_bpm: 60 }, /StandardRecipe, not a PhaserRecipe/],
    [[{ ...DIM_COUL[0], steps: [DIM_COUL[0].steps[0]] }, DIM_COUL[1]], {}, { action: "add_line", preset: "21.9005", selection: 9001, steps: [{ preset: "4.9001" }, { preset: "4.9000" }] }, /line 1 of Preset 21\.9005 has 1 step/],
    [[DIM_COUL[0], { ...DIM_COUL[1], steps: [DIM_COUL[1].steps[0]] }], {}, { action: "remove_line", preset: "21.9005", line: 2 }, /line 2 has 1 step/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005" }, /set changes at least one/],
    [DIM_COUL, {}, { action: "remove_line", preset: "21.9005", line: 2, speed_bpm: 60 }, /remove_line takes preset and line only/],
    [DIM_COUL, {}, { action: "set", preset: "21.9005", selection: 9999 }, /not in the show: Group 9999/],
    [DIM_COUL, { editing: true }, { action: "set", preset: "21.9005", speed_bpm: 60 }, /Edit Recipe mode is on/],
    [DIM_COUL, { modal: true }, { action: "set", preset: "21.9005", speed_bpm: 60 }, /a dialog is open/],
  ] as const) {
    const { h, cmds } = await editSetup(start as FLine[], opts);
    try {
      const { isError, text } = await h.callJson("gma3_edit_phaser_recipe", args as Record<string, unknown>);
      assert.equal(isError, true, text);
      assert.match(text, re as RegExp);
      assert.deepEqual(cmds, []);
      assert.ok(!h.fake.requests.some((r) => r.op === "set"));
    } finally {
      await h.close();
    }
  }
});

test("edit preview: checks and the plan, nothing sent", async () => {
  const { h, cmds } = await editSetup(DIM_COUL);
  try {
    const { result } = await h.callJson("gma3_edit_phaser_recipe", { action: "set", preset: "21.9005", line: 2, name: "X", phase: { from: 0, to: 180 }, preview: true });
    assert.equal(result.preview, true);
    assert.deepEqual(result.plan, ["set Preset 21.9005.2 PHASEFROMX=0", "set Preset 21.9005.2 PHASETOX=180", "set Preset 21.9005 Name=X", "Cook Preset 21.9005 /MergeLowPriority"]);
    assert.deepEqual(cmds, []);
  } finally {
    await h.close();
  }
});
