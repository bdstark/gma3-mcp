/**
 * gma3_edit_phaser_recipe: build a phaser recipe line (a PhaserRecipe: group + shape + steps from presets + MAtricks,
 * speed and phase) in a preset, the way the console's Recipe Editor does, safely and read back.
 *
 * There is no command or property that creates a PhaserRecipe line outside the programmer (onPC 2.5.1, THK migration
 * docs/phaser-recipes.md §3): it is built in Edit Recipe mode in the programmer's Part Zero and stored into the
 * target. Console facts this module relies on (live 2026-11-14, §1.5 and §1.7):
 *   - `EditRecipe <target>` switches the mode on for that target; `EditRecipe` without a target toggles it.
 *   - A store made in Edit Recipe mode leaves its target pending; the next `EditRecipe <other target>` opens
 *     "Update last object?". OK updates the pending target with the programmer (an empty programmer wipes its recipe
 *     lines); Cancel aborts the EditRecipe. Sent with Cmd() from the plugin thread that dialog stalls the bridge, so
 *     the bridge queues EditRecipe with CmdIndirect (recipe.editBegin / recipe.editEnd) and the server polls
 *     recipe.editState. A normal store with an empty programmer just before (the target's own empty Store) clears
 *     the pending target: the dialog does not open. If it opens anyway the tool presses Cancel, never OK.
 *   - In the mode: `Group G` creates no line; `At Shape S` creates the PhaserRecipe line in Part Zero; `Step n` +
 *     `At Preset P.X` sets step n's value source; `MAtricks M` sets the line's MAtricks. `Store Preset P.N /Merge
 *     /NoConfirmation` moves the line into the preset and empties Part Zero.
 *   - After the mode is switched off the programmer still holds the phaser's values (it outputs on stage meanwhile);
 *     ClearAll removes them. A line left in Part Zero (an aborted build) is removed by ClearAll too.
 *   - The line of a preset is `Preset P.N.1`; SPEEDX (BPM), PHASEFROMX and PHASETOX are its properties.
 *
 * First release: a free preset slot as the target, exactly 2 steps, each a preset of the target's pool (the phaser's
 * attributes come from its step presets). The cue then calls the preset with a standard line (gma3_store_recipe_cues).
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { presetId, type PresetRead } from "./presets.js";
import { readLines } from "./recipes.js";
import { asRead, buildResult, commandStep, notRequested, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber, objectName, objectNumber } from "../validate.js";

const POLL_MS = 150;
const MODE_WAIT_MS = 3000;
const UPDATE_DIALOG = "Update last object?";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);

export interface EditState {
  environment?: string;
  editing: boolean;
  editingRaw?: string;
  partZeroLines: Array<{ index: number; class?: string; name?: string }>;
  modal: false | { class?: string; title?: string; text?: string; buttons?: Array<{ text?: string; enabled?: boolean }> };
  modalError?: string;
  lastCommand?: string;
}

export async function readEditState(bridge: Gma3Bridge, t: number): Promise<EditState> {
  return (await bridge.request("recipe.editState", {}, t)) as EditState;
}

/** Programmer value count, or null when the scan was not complete (then nothing is known). */
async function programmerValues(bridge: Gma3Bridge, t: number): Promise<number | null> {
  const r = (await bridge.request("programmer", { scope: "all", limit: 1 }, t)) as { total?: number; coverage?: { complete?: boolean } };
  return r.coverage?.complete === true && typeof r.total === "number" ? r.total : null;
}

async function exists(bridge: Gma3Bridge, ref: string, t: number): Promise<boolean> {
  try {
    const r = (await bridge.request("objects", { ref, fields: [], limit: 1 }, t)) as { items?: unknown[] };
    return (r.items?.length ?? 0) > 0;
  } catch (err) {
    if (notFound(err)) return false;
    throw err;
  }
}

async function readPreset(bridge: Gma3Bridge, ref: string, t: number): Promise<PresetRead | null> {
  try {
    return (await bridge.request("preset.read", { ref }, t)) as PresetRead;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

/** A numeric property reply ("120.00", "360.00°") compared to the value sent. */
export function numberMatches(sent: number, got: unknown): boolean {
  const n = typeof got === "number" ? got : Number.parseFloat(String(got ?? "").replace(",", "."));
  return Number.isFinite(n) && Math.abs(n - sent) < 0.01;
}

interface CreateArgs {
  action?: string;
  preset?: unknown;
  name?: unknown;
  selection?: unknown;
  shape?: unknown;
  steps?: unknown;
  matricks?: unknown;
  speed_bpm?: unknown;
  phase?: unknown;
  exclusive?: unknown;
  preview?: unknown;
}

export async function createPhaserRecipe(ctx: ToolContext, raw: CreateArgs): Promise<OperationResult> {
  const op = "edit_phaser_recipe";
  const v = new Validator();
  if (raw.action !== "create") v.fail("action must be create (the only action of this release)");
  const target = v.check(() => presetId("preset", raw.preset));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const selection = v.check(() => objectNumber("selection", raw.selection, { max: 9999 }));
  const shape = raw.shape === undefined ? 1 : v.check(() => objectNumber("shape", raw.shape, { max: 9999 }));
  const matricks = raw.matricks === undefined ? undefined : v.check(() => objectNumber("matricks", raw.matricks, { max: 9999 }));
  const speed = raw.speed_bpm === undefined ? undefined : v.check(() => finiteNumber("speed_bpm", raw.speed_bpm, { min: 0.01, max: 6000 }));
  let phase: { from: number; to: number } | undefined;
  if (raw.phase !== undefined) {
    const p = raw.phase as Record<string, unknown> | null;
    if (!p || typeof p !== "object") v.fail("phase must be {from, to} in degrees");
    else {
      const from = v.check(() => finiteNumber("phase.from", p.from, { min: -36000, max: 36000 }));
      const to = v.check(() => finiteNumber("phase.to", p.to, { min: -36000, max: 36000 }));
      if (from !== undefined && to !== undefined) phase = { from, to };
    }
  }
  const steps: Array<{ pool: number; number: number }> = [];
  if (!Array.isArray(raw.steps) || raw.steps.length !== 2) v.fail("steps must be exactly 2 items [{preset: \"P.X\"}, {preset: \"P.Y\"}] (2-step phasers only in this release)");
  else
    raw.steps.forEach((s, i) => {
      const p = v.check(() => presetId(`steps[${i}].preset`, (s as Record<string, unknown> | null)?.preset));
      if (p) steps.push(p);
    });
  if (target) for (const [i, s] of steps.entries()) if (s.pool !== target.pool) v.fail(`steps[${i}].preset is in pool ${s.pool}; the phaser preset is in pool ${target.pool}: put the phaser in the pool of its step presets`);
  if (target && steps.some((s) => s.number === target.number && s.pool === target.pool)) v.fail("a step preset cannot be the target preset itself");
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the build uses the programmer (it is checked empty first, and cleared with ClearAll at the end) and the Edit Recipe mode; nobody else may use them meanwhile");
  const tgt: Record<string, unknown> = { action: raw.action, preset: raw.preset };
  if (!v.ok || !target || selection === undefined || shape === undefined || steps.length !== 2) return validationFailure(op, tgt, v.errors);
  const ref = `Preset ${target.pool}.${target.number}`;
  const lineRef = `${ref}.1`;
  tgt.ref = ref;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;

  const build: string[] = [`Group ${selection}`, `At Shape ${shape}`, "Step 1", `At Preset ${steps[0].pool}.${steps[0].number}`, "Step 2", `At Preset ${steps[1].pool}.${steps[1].number}`, ...(matricks !== undefined ? [`MAtricks ${matricks}`] : [])];
  const settings: Array<{ property: string; value: number }> = [
    ...(speed !== undefined ? [{ property: "SPEEDX", value: speed }] : []),
    ...(phase ? [{ property: "PHASEFROMX", value: phase.from }, { property: "PHASETOX", value: phase.to }] : []),
  ];
  const plan = [
    `Store ${ref} /NoConfirmation   (empty programmer: creates the preset and clears the pending Edit Recipe target)`,
    `EditRecipe ${ref}   (queued; the mode is read back on, Part Zero empty)`,
    ...build,
    `Store ${ref} /Merge /NoConfirmation`,
    "EditRecipe   (queued; the mode is read back off)",
    "ClearAll",
    ...(name !== undefined ? [`set ${ref} Name=${name}`] : []),
    ...settings.map((s) => `set ${lineRef} ${s.property}=${s.value}`),
    `Cook ${ref} /MergeLowPriority`,
  ];

  const body = async (): Promise<OperationResult> => {
    const steps_: StepResult[] = [];
    const fail = (summary: string, extra: Record<string, unknown> = {}) => buildResult({ operation: op, target: tgt, steps: steps_, summary, extra: { plan, ...extra } });
    const read = async (name_: string, fn: () => Promise<string | null>, opName?: string): Promise<boolean> => {
      try {
        const problem = await fn();
        steps_.push(asRead({ name: name_, status: problem ? "failed" : "succeeded", ...(opName ? { op: opName } : {}), ...(problem ? { error: problem } : {}) }));
        return !problem;
      } catch (err) {
        steps_.push(asRead(stepFromError(name_, err, opName ? { op: opName } : {})));
        return false;
      }
    };

    // ---- Checks: nothing is sent unless all pass.
    let stepPresets: Array<PresetRead | null> = [];
    const ok =
      (await read("read_target", async () => ((await readPreset(bridge, ref, tm)) ? `${ref} exists: the phaser is built in a free preset slot (EditRecipe would reload an existing preset's lines)` : null), "preset.read")) &&
      (await read("check_references", async () => {
        const missing: string[] = [];
        if (!(await exists(bridge, `Group ${selection}`, tm))) missing.push(`Group ${selection}`);
        if (!(await exists(bridge, `Shape ${shape}`, tm))) missing.push(`Shape ${shape}`);
        if (matricks !== undefined && !(await exists(bridge, `MAtricks ${matricks}`, tm))) missing.push(`MAtricks ${matricks}`);
        stepPresets = [];
        for (const s of steps) {
          const p = await readPreset(bridge, `Preset ${s.pool}.${s.number}`, tm);
          stepPresets.push(p);
          if (!p) missing.push(`Preset ${s.pool}.${s.number}`);
        }
        return missing.length ? `not in the show: ${missing.join(", ")}` : null;
      })) &&
      (await read("read_edit_state", async () => {
        const s = await readEditState(bridge, tm);
        if (s.modalError) return `whether a dialog is open cannot be read (${s.modalError})`;
        if (s.modal) return `a dialog is open (${s.modal.title ?? "untitled"}): answer it first`;
        if (s.editing) return "the Edit Recipe mode is on: switch it off first";
        if (s.partZeroLines.length) return `the programmer's Part Zero holds ${s.partZeroLines.length} recipe line(s)`;
        return null;
      }, "recipe.editState")) &&
      (await read("read_programmer", async () => {
        const n = await programmerValues(bridge, tm);
        if (n === null) return "the programmer could not be read completely, so it is not known to be empty";
        return n > 0 ? `the programmer holds ${n} value(s): the build would store them into the phaser, and its final ClearAll would discard them. Clear or store them first` : null;
      }, "programmer")) &&
      (await read("read_store_preferences", async () => {
        const c = (await bridge.request("preset.context", {}, tm)) as { preferencesReadable?: boolean; preferences?: Record<string, unknown> };
        if (!c.preferencesReadable) return "the store preferences cannot be read";
        const m = String(c.preferences?.RecipeStoreMode ?? "");
        return m === "Normal" ? null : `the store preference RecipeStoreMode is ${JSON.stringify(m)}, not Normal`;
      }, "preset.context"));
    if (!ok) return fail(`${op} was not performed; nothing was sent: ${steps_.find((s) => s.status !== "succeeded")?.error ?? "a check failed"}`);
    if (preview) return fail("Preview only; nothing was sent.", { preview: true });

    // ---- Build.
    let created = false;
    let stored = false;
    const cmd = async (name_: string, command: string) => {
      const s = await commandStep(bridge, name_, command, tm);
      steps_.push(s);
      return s.status === "succeeded";
    };
    const waitMode = async (want: boolean): Promise<{ state: EditState | null; error?: string }> => {
      const until = Date.now() + MODE_WAIT_MS;
      let last: EditState | null = null;
      for (;;) {
        try {
          last = await readEditState(bridge, tm);
        } catch (err) {
          return { state: last, error: `recipe.editState failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (last.modal || last.modalError || last.editing === want) return { state: last };
        if (Date.now() > until) return { state: last, error: `the Edit Recipe mode still reads ${last.editing ? "on" : "off"} after ${MODE_WAIT_MS} ms` };
        await sleep(POLL_MS);
      }
    };
    /** Answer "Update last object?" with Cancel (never OK); any other dialog is left alone. */
    const cancelUpdateDialog = async (s: EditState): Promise<string> => {
      const m = s.modal;
      if (!m) return "";
      if (m.title !== UPDATE_DIALOG || !m.buttons?.some((b) => b.text === "Cancel")) return `a dialog opened (${m.title ?? "untitled"}: ${m.text ?? ""}); it was left open, answer it on the console`;
      try {
        await bridge.request("dialog.press", { button: "Cancel", exclusive: true, ...(m.class ? { expectClass: m.class } : {}), expectTitle: m.title ?? "", expectText: m.text ?? "" }, tm);
        steps_.push({ name: "cancel_dialog", status: "succeeded", op: "dialog.press", detail: { title: m.title, text: m.text } });
        return `"${UPDATE_DIALOG}" opened (${m.text ?? ""}) and was cancelled (never OK: OK would overwrite that object with the programmer)`;
      } catch (err) {
        steps_.push(stepFromError("cancel_dialog", err, { op: "dialog.press" }));
        return `"${UPDATE_DIALOG}" opened (${m.text ?? ""}) and pressing Cancel failed: answer Cancel on the console`;
      }
    };
    const checkLine = async (name_: string, when: string): Promise<boolean> =>
      read(name_, async () => {
        const s = await readEditState(bridge, tm);
        if (s.modal) return `a dialog is open (${s.modal.title ?? "untitled"})`;
        if (!s.editing) return `the Edit Recipe mode is off ${when}`;
        const ph = s.partZeroLines.filter((l) => l.class === "PhaserRecipe");
        if (ph.length !== 1 || s.partZeroLines.length !== 1) return `Part Zero holds ${s.partZeroLines.length} line(s) (${ph.length} phaser) ${when}, 1 phaser line expected`;
        return null;
      }, "recipe.editState");

    /** After a failure: mode off, programmer cleared, and the preset removed if this call created it and never stored into it. */
    const abort = async (why: string): Promise<OperationResult> => {
      const notes: string[] = [why];
      // The build did not complete, whatever the clean-up does: the outcome must not read as a success.
      steps_.push({ name: "build_aborted", status: "failed", error: why || "the build stopped" });
      try {
        let s = await readEditState(bridge, tm);
        if (s.modal) notes.push(await cancelUpdateDialog(s));
        s = await readEditState(bridge, tm);
        if (s.editing && !s.modal) {
          steps_.push({ name: "abort_edit_end", status: "succeeded", op: "recipe.editEnd", detail: await bridge.request("recipe.editEnd", { exclusive: true }, tm) });
          const w = await waitMode(false);
          if (w.error || w.state?.editing) notes.push(`the Edit Recipe mode could not be switched off (${w.error ?? "still on"}): switch it off on the console`);
        }
        s = await readEditState(bridge, tm);
        if (!s.editing && !s.modal) {
          await cmd("abort_clear", "ClearAll");
          if (created && !stored) await cmd("abort_delete_preset", `Delete ${ref} /NoConfirmation`);
        } else notes.push("the programmer was not cleared (the mode or a dialog is still open)");
      } catch (err) {
        steps_.push(stepFromError("abort", err));
        notes.push("the clean-up did not finish: check the Edit Recipe mode, Part Zero and the programmer on the console");
      }
      return fail(notes.filter(Boolean).join("; "));
    };

    if (!(await cmd("reset_store", `Store ${ref} /NoConfirmation`))) return fail(`the empty store of ${ref} failed; nothing else was sent`);
    created = true;
    try {
      steps_.push({ name: "edit_begin", status: "succeeded", op: "recipe.editBegin", detail: await bridge.request("recipe.editBegin", { target: ref, exclusive: true }, tm) });
    } catch (err) {
      steps_.push(stepFromError("edit_begin", err, { op: "recipe.editBegin" }));
      return abort("EditRecipe was not queued");
    }
    const begun = await waitMode(true);
    if (begun.state?.modal) return abort(await cancelUpdateDialog(begun.state));
    if (begun.error || !begun.state?.editing) return abort(begun.error ?? "the Edit Recipe mode did not switch on");
    if (begun.state.partZeroLines.length) return abort(`EditRecipe loaded ${begun.state.partZeroLines.length} line(s) into Part Zero`);
    steps_.push(asRead({ name: "edit_mode_on", status: "succeeded", op: "recipe.editState" }));

    for (const [i, c] of build.entries()) {
      if (!(await cmd(`build_${i + 1}`, c))) return abort(`"${c}" failed`);
      if (c.startsWith("At Shape") && !(await checkLine("check_line", "after At Shape"))) return abort("the phaser line was not created as expected");
    }
    if (!(await checkLine("check_before_store", "before the store"))) return abort("the programmer is not as expected before the store");
    if (!(await cmd("store", `Store ${ref} /Merge /NoConfirmation`))) return abort("the store failed");
    stored = true;
    if (!(await read("check_after_store", async () => {
      const s = await readEditState(bridge, tm);
      return s.partZeroLines.length ? `Part Zero still holds ${s.partZeroLines.length} line(s) after the store` : null;
    }, "recipe.editState"))) return abort("the store did not take the line");
    try {
      steps_.push({ name: "edit_end", status: "succeeded", op: "recipe.editEnd", detail: await bridge.request("recipe.editEnd", { exclusive: true }, tm) });
    } catch (err) {
      steps_.push(stepFromError("edit_end", err, { op: "recipe.editEnd" }));
      return abort("EditRecipe (off) was not queued");
    }
    const ended = await waitMode(false);
    if (ended.state?.modal) return abort(await cancelUpdateDialog(ended.state));
    if (ended.error || ended.state?.editing) return abort(ended.error ?? "the Edit Recipe mode did not switch off");
    if (!(await cmd("clear", "ClearAll"))) return abort("ClearAll failed");
    await read("check_programmer_clear", async () => {
      const n = await programmerValues(bridge, tm);
      const s = await readEditState(bridge, tm);
      if (n !== 0) return `the programmer holds ${n ?? "an unknown number of"} value(s) after ClearAll`;
      return s.partZeroLines.length ? `Part Zero holds ${s.partZeroLines.length} line(s) after ClearAll` : null;
    }, "programmer");

    // ---- Settings and cook (the line exists from here: a failure is reported, the preset is kept).
    const settingsFailed: string[] = [];
    if (name !== undefined) {
      try {
        const r = (await bridge.request("set", { ref, property: "Name", value: name }, tm)) as { value?: unknown };
        const good = String(r?.value ?? "") === name;
        steps_.push({ name: "label", status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `Name reads ${JSON.stringify(r?.value)}` }) });
        if (!good) settingsFailed.push("name");
      } catch (err) {
        steps_.push(stepFromError("label", err, { op: "set" }));
        settingsFailed.push("name");
      }
    }
    for (const s of settings) {
      try {
        const r = (await bridge.request("set", { ref: lineRef, property: s.property, value: String(s.value) }, tm)) as { value?: unknown };
        const good = numberMatches(s.value, r?.value);
        steps_.push({ name: `set_${s.property.toLowerCase()}`, status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `${s.property} reads ${JSON.stringify(r?.value)} after writing ${s.value}` }) });
        if (!good) settingsFailed.push(s.property);
      } catch (err) {
        steps_.push(stepFromError(`set_${s.property.toLowerCase()}`, err, { op: "set" }));
        settingsFailed.push(s.property);
      }
    }
    await cmd("cook", `Cook ${ref} /MergeLowPriority`);

    // ---- Read back.
    let verification: Verification = notRequested();
    let lines: unknown = null;
    let coverage: unknown = null;
    try {
      const ls = (await readLines(bridge, { kind: "preset", pool: target.pool, number: target.number }, tm)) ?? [];
      const data = await readPreset(bridge, ref, tm);
      const s = await readEditState(bridge, tm);
      lines = ls;
      const problems: string[] = [];
      if (ls.length !== 1) problems.push(`${ref} has ${ls.length} recipe line(s), 1 expected`);
      const l = ls[0];
      if (l && l.class !== "PhaserRecipe") problems.push(`line 1 is a ${l.class}, not a PhaserRecipe`);
      if (l && l.selection?.group !== selection) problems.push(`line 1 selection reads ${l.selection ? `Group ${l.selection.group}` : "none"}`);
      if (l && matricks !== undefined && l.matricks?.no !== matricks) problems.push(`line 1 MAtricks reads ${l.matricks?.no ?? "none"}`);
      if (l?.status.failedCookedPart && l.status.failedCookedPart !== "None") problems.push(`line 1 failed to cook (${l.status.failedCookedPart})`);
      const rows = data?.rows ?? [];
      const uncooked = rows.filter((r) => r.cooked !== true);
      if (!rows.length) problems.push(`${ref} holds no values (nothing cooked)`);
      if (uncooked.length) problems.push(`${ref} holds ${uncooked.length} uncooked value(s): stored directly, not from the recipe`);
      if (data?.truncated) problems.push(`${ref} was not read completely`);
      const badSteps = rows.filter(
        (r) => r.stepCount !== 2 || steps.some((p, i) => r.steps?.[i]?.integrated?.pool !== p.pool || r.steps?.[i]?.integrated?.no !== p.number),
      );
      if (badSteps.length) problems.push(`${badSteps.length} value(s) do not have 2 steps from Preset ${steps.map((p) => `${p.pool}.${p.number}`).join(" / Preset ")} (first: fixture ${badSteps[0].fixture} ${badSteps[0].attribute})`);
      // The cooked speed is in Hz (60 BPM = 1 Hz). The phase is spread by the MAtricks per fixture, so only its set reply is compared.
      if (speed !== undefined) {
        const off = rows.filter((r) => typeof r.speed !== "number" || Math.abs(r.speed - speed / 60) > 0.001);
        if (off.length) problems.push(`${off.length} value(s) do not run at ${speed} BPM (${(speed / 60).toFixed(3)} Hz; first: fixture ${off[0].fixture} ${off[0].attribute} reads ${off[0].speed ?? "none"})`);
      }
      if (s.editing) problems.push("the Edit Recipe mode is on");
      if (s.partZeroLines.length) problems.push(`Part Zero holds ${s.partZeroLines.length} line(s)`);
      if (s.modal) problems.push(`a dialog is open (${s.modal.title ?? "untitled"})`);
      coverage = { cooked: rows.length - uncooked.length, uncooked: uncooked.length, fixtures: [...new Set(rows.map((r) => r.fixture))].length, attributes: [...new Set(rows.map((r) => r.attribute))] };
      steps_.push(asRead({ name: "read_back", status: "succeeded", op: "preset.read" }));
      verification = problems.length
        ? { status: "mismatched", checked: `${ref}: one PhaserRecipe line, every value cooked with its 2 step presets, the mode off and the programmer empty`, detail: problems.join("; ") }
        : { status: "matched", checked: `${ref}: one PhaserRecipe line (Group ${selection}, Shape ${shape}${matricks !== undefined ? `, MAtricks ${matricks}` : ""}), every value cooked with steps from the 2 presets, the Edit Recipe mode off, Part Zero and the programmer empty` };
    } catch (err) {
      steps_.push(asRead(stepFromError("read_back", err, { op: "preset.read" })));
    }
    const warnings = ["Between At Shape and the final ClearAll the phaser ran in the programmer (it was output on stage)."];
    if (settingsFailed.length) warnings.push(`not set as asked: ${settingsFailed.join(", ")} (the preset and its line are kept)`);
    return buildResult({ operation: op, target: tgt, steps: steps_, verification, warnings, extra: { plan, line: lineRef, lines, coverage } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

export const registerPhaserRecipeTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_edit_phaser_recipe",
    {
      title: "Build a phaser recipe line in a preset",
      description:
        "action create: builds one PhaserRecipe line (selection group, shape, 2 steps from presets, MAtricks, speed, phase) in a FREE preset slot, the only way the console makes one: in Edit Recipe mode in the programmer, then stored into the preset. " +
        "The step presets must be in the target's pool (the phaser's attributes come from them: a Dimmer phaser goes in pool 1, a colour phaser in pool 4). Exactly 2 steps in this release. " +
        "Checked first, nothing sent otherwise: the slot is free, the group, shape, presets and MAtricks exist, the Edit Recipe mode is off with an empty Part Zero, no dialog is open, the programmer is empty (read completely), RecipeStoreMode is Normal. " +
        "Then: an empty Store of the preset (it clears the pending Edit Recipe target, so \"Update last object?\" does not open), EditRecipe queued without blocking the bridge (if \"Update last object?\" opens anyway it is answered Cancel, never OK, and the call stops), Group / At Shape / Step / At Preset / MAtricks one command at a time with the line checked in Part Zero, Store /Merge, the mode switched off and read back, ClearAll (the phaser runs on stage from At Shape until then), name, SPEEDX / PHASEFROMX / PHASETOX on the line, Cook /MergeLowPriority. " +
        "A failure before the store switches the mode off, clears the programmer and deletes the preset this call created. Read back: one PhaserRecipe line, every value cooked with its 2 step presets at speed_bpm, nothing uncooked, mode off, programmer and Part Zero empty. The preset then stays the pending Edit Recipe target: a manual EditRecipe elsewhere opens \"Update last object?\" (never OK). Never Store an empty programmer into an existing phaser preset: that wipes its line. " +
        "The cue calls the preset with a standard line (gma3_store_recipe_cues); a cue line's Speed X replaces the preset's speed. preview: true runs the checks and returns the plan. Needs bridge 0.52.0.",
      inputSchema: {
        action: z.enum(["create"]),
        preset: z.string().describe('Target preset "P.N", a free slot in the pool of the step presets.'),
        name: z.string().optional().describe("Preset name (otherwise the console names it after the line)."),
        selection: z.number().describe("Group number."),
        shape: z.number().optional().describe("Shape pool number (default 1)."),
        steps: z.array(z.object({ preset: z.string().describe('Step preset "P.X", same pool as the target.') })).describe("Exactly 2 steps, in order."),
        matricks: z.number().optional().describe("MAtricks pool number (wings, blocks... spread the phase)."),
        speed_bpm: z.number().optional().describe("Speed X in BPM (60 BPM = 1 Hz); the console default otherwise."),
        phase: z.object({ from: z.number(), to: z.number() }).optional().describe("Phase X from/to in degrees (e.g. 0 to 360)."),
        exclusive: z.boolean().optional().describe("Required (true) unless preview: nobody else uses the programmer or the Edit Recipe mode meanwhile."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => createPhaserRecipe(ctx, args as CreateArgs)),
  );
};
