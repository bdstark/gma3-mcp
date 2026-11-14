/**
 * gma3_edit_phaser_recipe: build phaser recipe lines (PhaserRecipe: group + shape + 2 steps from presets + MAtricks,
 * speed, phase, step curves) in a preset, the way the console's Recipe Editor does, safely and read back.
 *
 * There is no command or property that creates a PhaserRecipe line outside the programmer (onPC 2.5.1, THK migration
 * docs/phaser-recipes.md §3): the first line is built in Edit Recipe mode in the programmer's Part Zero and stored
 * into the target. Console facts this module relies on (live 2026-11-14, §1.5, §1.7, §1.8):
 *   - `EditRecipe <target>` switches the mode on for that target; `EditRecipe` without a target toggles it.
 *   - A store made in Edit Recipe mode leaves its target pending; the next `EditRecipe <other target>` opens
 *     "Update last object?". OK updates the pending target with the programmer (an empty programmer wipes its recipe
 *     lines); Cancel aborts the EditRecipe. Sent with Cmd() from the plugin thread that dialog stalls the bridge, so
 *     the bridge queues EditRecipe with CmdIndirect (recipe.editBegin / recipe.editEnd) and the server polls
 *     recipe.editState. A normal store with an empty programmer just before (the target's own empty Store, on a FREE
 *     slot: on an existing phaser preset it wipes the line) clears the pending target. If the dialog opens anyway the
 *     tool presses Cancel, never OK.
 *   - In the mode: `Group G` creates no line; `At Shape S` creates the PhaserRecipe line in Part Zero; `Step n` +
 *     `At Preset P.X` sets step n's value source (a second `At Preset` on the same step replaces it: one value source
 *     per step); `MAtricks M` sets the line's MAtricks. `Store Preset P.N /Merge /NoConfirmation` moves the line into
 *     the preset and empties Part Zero. A second `At Shape` on the same group re-shapes that line, it adds none.
 *   - After the mode is switched off the programmer still holds the phaser's values (it outputs on stage meanwhile);
 *     ClearAll removes them. A line left in Part Zero (an aborted build) is removed by ClearAll too.
 *   - More lines (another family in the same preset): `Copy Preset P.N.1 At Preset P.N.k /NoConfirmation` copies the
 *     first line; `Assign Group|Shape|MAtricks n At Preset P.N.k` and `Assign Preset X At Preset P.N.k.1.<step>.1`
 *     retarget it. A preset with lines of different families goes in an All pool (21-25): 21.9001 held a Dimmer line
 *     and an RGBW line, 20/20 cooked, each at its own speed.
 *   - The line of a preset is `Preset P.N.L`; SPEEDX (BPM), PHASEFROMX and PHASETOX are its properties.
 *   - Step curve: `Set Preset P.N.L.1.<step>.1 Property "Curve" "<name>"` from the command line (the Lua `set` of the
 *     property is ignored, and CURVE reads back as an opaque id). With Link Steps (the default) a step's curve sets its
 *     DECEL and the next step's ACCEL (Snap also TRANS 0): Linear 0/0, Ease In +100/-100, Ease Out -100/+100,
 *     Ease In and Out -100/-100, Swing +100/+100, Snap 0/0 with TRANS 0. The cooked steps carry these values.
 *
 * Release: a free preset slot, 1 to 8 lines of exactly 2 steps each; the 2 steps of a line come from one pool, which
 * is the target's pool or the target is in an All pool (21-25). The cue calls the preset with a standard line.
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
const MAX_LINES = 8;
const UPDATE_DIALOG = "Update last object?";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);
const isAllPool = (pool: number) => pool >= 21 && pool <= 25;

/** The predefined step curves and what each writes, with Link Steps: [own DECEL, next step's ACCEL, own TRANS or undefined]. */
export const CURVES = {
  linear: { console: "Linear", decel: 0, nextAccel: 0 },
  ease_in: { console: "Ease In", decel: 100, nextAccel: -100 },
  ease_out: { console: "Ease Out", decel: -100, nextAccel: 100 },
  ease_in_out: { console: "Ease In and Out", decel: -100, nextAccel: -100 },
  swing: { console: "Swing", decel: 100, nextAccel: 100 },
  snap: { console: "Snap", decel: 0, nextAccel: 0, trans: 0 },
} as const;
export type CurveName = keyof typeof CURVES;

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

interface StepSpec {
  pool: number;
  number: number;
  curve?: CurveName;
}
interface LineSpec {
  selection: number;
  shape: number;
  steps: StepSpec[];
  matricks?: number;
  speed?: number;
  phase?: { from: number; to: number };
}

interface CreateArgs {
  action?: string;
  preset?: unknown;
  name?: unknown;
  lines?: unknown;
  selection?: unknown;
  shape?: unknown;
  steps?: unknown;
  matricks?: unknown;
  speed_bpm?: unknown;
  phase?: unknown;
  exclusive?: unknown;
  preview?: unknown;
}

const LINE_FIELDS = ["selection", "shape", "steps", "matricks", "speed_bpm", "phase"] as const;

function parseLine(v: Validator, raw: Record<string, unknown>, path: string): LineSpec | undefined {
  const at = (f: string) => (path ? `${path}.${f}` : f);
  const selection = v.check(() => objectNumber(at("selection"), raw.selection, { max: 9999 }));
  const shape = raw.shape === undefined ? 1 : v.check(() => objectNumber(at("shape"), raw.shape, { max: 9999 }));
  const matricks = raw.matricks === undefined ? undefined : v.check(() => objectNumber(at("matricks"), raw.matricks, { max: 9999 }));
  const speed = raw.speed_bpm === undefined ? undefined : v.check(() => finiteNumber(at("speed_bpm"), raw.speed_bpm, { min: 0.01, max: 6000 }));
  let phase: LineSpec["phase"];
  if (raw.phase !== undefined) {
    const p = raw.phase as Record<string, unknown> | null;
    if (!p || typeof p !== "object") v.fail(`${at("phase")} must be {from, to} in degrees`);
    else {
      const from = v.check(() => finiteNumber(at("phase.from"), p.from, { min: -36000, max: 36000 }));
      const to = v.check(() => finiteNumber(at("phase.to"), p.to, { min: -36000, max: 36000 }));
      if (from !== undefined && to !== undefined) phase = { from, to };
    }
  }
  const steps: StepSpec[] = [];
  if (!Array.isArray(raw.steps) || raw.steps.length !== 2) v.fail(`${at("steps")} must be exactly 2 items [{preset: "P.X"}, {preset: "P.Y"}] (2-step phasers only in this release)`);
  else
    raw.steps.forEach((s, i) => {
      const r = (s ?? {}) as Record<string, unknown>;
      const p = v.check(() => presetId(`${at("steps")}[${i}].preset`, r.preset));
      if (r.curve !== undefined && !(typeof r.curve === "string" && r.curve in CURVES)) v.fail(`${at("steps")}[${i}].curve must be one of ${Object.keys(CURVES).join(", ")}`);
      if (p) steps.push({ ...p, ...(typeof r.curve === "string" && r.curve in CURVES ? { curve: r.curve as CurveName } : {}) });
    });
  if (steps.length === 2 && steps[0].pool !== steps[1].pool) v.fail(`${at("steps")}: the 2 steps of a line come from one preset pool (one family per line; another family is another line), not pools ${steps[0].pool} and ${steps[1].pool}`);
  if (selection === undefined || shape === undefined || steps.length !== 2) return undefined;
  return { selection, shape, steps, matricks, speed, phase };
}

const pair = (l: LineSpec) => l.steps.map((s) => `${s.pool}.${s.number}`).join("/");

export async function createPhaserRecipe(ctx: ToolContext, raw: CreateArgs): Promise<OperationResult> {
  const op = "edit_phaser_recipe";
  const v = new Validator();
  if (raw.action !== "create") v.fail("action must be create (the only action of this release)");
  const target = v.check(() => presetId("preset", raw.preset));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const specs: LineSpec[] = [];
  const topLevel = LINE_FIELDS.filter((f) => raw[f] !== undefined);
  if (raw.lines !== undefined) {
    if (topLevel.length) v.fail(`give lines, or the fields of one line (${LINE_FIELDS.join(", ")}), not both (got ${topLevel.join(", ")} next to lines)`);
    if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > MAX_LINES) v.fail(`lines must be a list of 1 to ${MAX_LINES} lines`);
    else
      raw.lines.forEach((l, i) => {
        const s = l && typeof l === "object" && !Array.isArray(l) ? parseLine(v, l as Record<string, unknown>, `lines[${i}]`) : (v.fail(`lines[${i}] must be an object`), undefined);
        if (s) specs.push(s);
      });
  } else {
    const s = parseLine(v, raw as Record<string, unknown>, "");
    if (s) specs.push(s);
  }
  if (target) {
    for (const [i, l] of specs.entries()) {
      const pool = l.steps[0].pool;
      if (pool !== target.pool && !isAllPool(target.pool))
        v.fail(`${specs.length > 1 ? `lines[${i}]` : "steps"}: its step presets are in pool ${pool}, the phaser preset in pool ${target.pool}: put the phaser in the pool of its step presets, or in an All pool (21-25) for lines of different families`);
      if (l.steps.some((s) => s.pool === target.pool && s.number === target.number)) v.fail("a step preset cannot be the target preset itself");
    }
  }
  const pairs = specs.map(pair);
  if (new Set(pairs).size !== pairs.length) v.fail("two lines have the same 2 step presets: their output could not be told apart in the read-back");
  if (specs[0]?.matricks !== undefined && specs.some((l) => l.matricks === undefined)) v.fail("lines[0] has a MAtricks and another line has none: the other lines are copies of line 1 and keep its MAtricks; give every line one, or put a line without MAtricks first");
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the build uses the programmer (it is checked empty first, and cleared with ClearAll at the end) and the Edit Recipe mode; nobody else may use them meanwhile");
  const tgt: Record<string, unknown> = { action: raw.action, preset: raw.preset };
  if (!v.ok || !target || specs.length === 0) return validationFailure(op, tgt, v.errors);
  const ref = `Preset ${target.pool}.${target.number}`;
  const lineAt = (k: number) => `${ref}.${k}`;
  const sourceAt = (k: number, step: number) => `${ref}.${k}.1.${step}.1`;
  tgt.ref = ref;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const first = specs[0];

  const build: string[] = [`Group ${first.selection}`, `At Shape ${first.shape}`, "Step 1", `At Preset ${first.steps[0].pool}.${first.steps[0].number}`, "Step 2", `At Preset ${first.steps[1].pool}.${first.steps[1].number}`, ...(first.matricks !== undefined ? [`MAtricks ${first.matricks}`] : [])];
  /** Commands that make line k (k >= 2) out of a copy of line 1. */
  const copyCommands = (k: number, l: LineSpec): string[] => [
    `Copy ${lineAt(1)} At ${lineAt(k)} /NoConfirmation`,
    ...(l.selection !== first.selection ? [`Assign Group ${l.selection} At ${lineAt(k)}`] : []),
    ...(l.shape !== first.shape ? [`Assign Shape ${l.shape} At ${lineAt(k)}`] : []),
    ...(l.matricks !== undefined && l.matricks !== first.matricks ? [`Assign MAtricks ${l.matricks} At ${lineAt(k)}`] : []),
    `Assign Preset ${l.steps[0].pool}.${l.steps[0].number} At ${sourceAt(k, 1)}`,
    `Assign Preset ${l.steps[1].pool}.${l.steps[1].number} At ${sourceAt(k, 2)}`,
  ];
  const settingsOf = (l: LineSpec) => [
    ...(l.speed !== undefined ? [{ property: "SPEEDX", value: l.speed }] : []),
    ...(l.phase ? [{ property: "PHASEFROMX", value: l.phase.from }, { property: "PHASETOX", value: l.phase.to }] : []),
  ];
  const curveCommands = (k: number, l: LineSpec) => l.steps.flatMap((s, i) => (s.curve ? [`Set ${sourceAt(k, i + 1)} Property "Curve" "${CURVES[s.curve].console}"`] : []));
  const plan = [
    `Store ${ref} /NoConfirmation   (empty programmer, free slot: creates the preset and clears the pending Edit Recipe target)`,
    `EditRecipe ${ref}   (queued; the mode is read back on, Part Zero empty)`,
    ...build,
    `Store ${ref} /Merge /NoConfirmation`,
    "EditRecipe   (queued; the mode is read back off)",
    "ClearAll",
    ...(name !== undefined ? [`set ${ref} Name=${name}`] : []),
    ...specs.flatMap((l, i) => [...(i > 0 ? copyCommands(i + 1, l) : []), ...settingsOf(l).map((s) => `set ${lineAt(i + 1)} ${s.property}=${s.value}`), ...curveCommands(i + 1, l)]),
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
    const ok =
      (await read("read_target", async () => ((await readPreset(bridge, ref, tm)) ? `${ref} exists: the phaser is built in a free preset slot (EditRecipe would reload an existing preset's lines, and an empty Store into it would wipe them)` : null), "preset.read")) &&
      (await read("check_references", async () => {
        const refs = new Set<string>();
        for (const l of specs) {
          refs.add(`Group ${l.selection}`);
          refs.add(`Shape ${l.shape}`);
          if (l.matricks !== undefined) refs.add(`MAtricks ${l.matricks}`);
        }
        const missing: string[] = [];
        for (const r of refs) if (!(await exists(bridge, r, tm))) missing.push(r);
        for (const p of new Set(specs.flatMap((l) => l.steps.map((s) => `Preset ${s.pool}.${s.number}`)))) if (!(await readPreset(bridge, p, tm))) missing.push(p);
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

    // ---- Line 1 in Edit Recipe mode.
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

    // ---- From here the preset holds line 1: a failure is reported, the preset is kept.
    const notDone: string[] = [];
    if (name !== undefined) {
      try {
        const r = (await bridge.request("set", { ref, property: "Name", value: name }, tm)) as { value?: unknown };
        const good = String(r?.value ?? "") === name;
        steps_.push({ name: "label", status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `Name reads ${JSON.stringify(r?.value)}` }) });
        if (!good) notDone.push("name");
      } catch (err) {
        steps_.push(stepFromError("label", err, { op: "set" }));
        notDone.push("name");
      }
    }
    let linesMade = 1;
    for (const [i, l] of specs.entries()) {
      const k = i + 1;
      if (k > 1) {
        let made = true;
        for (const [j, c] of copyCommands(k, l).entries()) {
          if (!(await cmd(`line${k}_${j === 0 ? "copy" : `assign_${j}`}`, c))) {
            made = false;
            break;
          }
          if (j === 0) {
            const n = await readLines(bridge, { kind: "preset", pool: target.pool, number: target.number }, tm).catch(() => null);
            const good = n?.length === k && n[k - 1]?.class === "PhaserRecipe";
            steps_.push(asRead({ name: `line${k}_copied`, status: good ? "succeeded" : "failed", op: "children", ...(good ? {} : { error: `${ref} has ${n?.length ?? "an unknown number of"} line(s) after the copy, ${k} expected` }) }));
            if (!good) {
              made = false;
              break;
            }
          }
        }
        if (!made) {
          notDone.push(`line ${k} and the lines after it`);
          break;
        }
        linesMade = k;
      }
      for (const s of settingsOf(l)) {
        const stepName = `line${k}_set_${s.property.toLowerCase()}`;
        try {
          const r = (await bridge.request("set", { ref: lineAt(k), property: s.property, value: String(s.value) }, tm)) as { value?: unknown };
          const good = numberMatches(s.value, r?.value);
          steps_.push({ name: stepName, status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `${s.property} reads ${JSON.stringify(r?.value)} after writing ${s.value}` }) });
          if (!good) notDone.push(`line ${k} ${s.property}`);
        } catch (err) {
          steps_.push(stepFromError(stepName, err, { op: "set" }));
          notDone.push(`line ${k} ${s.property}`);
        }
      }
      for (const [j, c] of curveCommands(k, l).entries()) if (!(await cmd(`line${k}_curve_${j + 1}`, c))) notDone.push(`line ${k} curve`);
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
      if (ls.length !== specs.length) problems.push(`${ref} has ${ls.length} recipe line(s), ${specs.length} expected`);
      const rows = data?.rows ?? [];
      const uncooked = rows.filter((r) => r.cooked !== true);
      if (!rows.length) problems.push(`${ref} holds no values (nothing cooked)`);
      if (uncooked.length) problems.push(`${ref} holds ${uncooked.length} uncooked value(s): stored directly, not from the recipe`);
      if (data?.truncated) problems.push(`${ref} was not read completely`);
      // Each cooked value belongs to the line whose 2 step presets it integrates.
      const rowPair = (r: (typeof rows)[number]) => (r.stepCount === 2 ? [0, 1].map((i) => `${r.steps?.[i]?.integrated?.pool}.${r.steps?.[i]?.integrated?.no}`).join("/") : "?");
      const stray = rows.filter((r) => !pairs.includes(rowPair(r)));
      if (stray.length) problems.push(`${stray.length} value(s) do not have 2 steps from one line's step presets (first: fixture ${stray[0].fixture} ${stray[0].attribute}, steps ${rowPair(stray[0])})`);
      for (const [i, l] of specs.entries()) {
        const k = i + 1;
        const got = ls[i];
        if (!got) continue;
        if (got.class !== "PhaserRecipe") problems.push(`line ${k} is a ${got.class}, not a PhaserRecipe`);
        if (got.selection?.group !== l.selection) problems.push(`line ${k} selection reads ${got.selection ? `Group ${got.selection.group}` : "none"}`);
        if (l.matricks !== undefined && got.matricks?.no !== l.matricks) problems.push(`line ${k} MAtricks reads ${got.matricks?.no ?? "none"}`);
        if (got.status.failedCookedPart && got.status.failedCookedPart !== "None") problems.push(`line ${k} failed to cook (${got.status.failedCookedPart})`);
        const mine = rows.filter((r) => rowPair(r) === pairs[i]);
        if (!mine.length) {
          problems.push(`no cooked value comes from line ${k} (Preset ${pairs[i].replace("/", " / Preset ")})`);
          continue;
        }
        // The cooked speed is in Hz (60 BPM = 1 Hz). The phase is spread per fixture by the MAtricks: only its set reply is compared.
        if (l.speed !== undefined) {
          const off = mine.filter((r) => typeof r.speed !== "number" || Math.abs(r.speed - l.speed! / 60) > 0.001);
          if (off.length) problems.push(`line ${k}: ${off.length} value(s) do not run at ${l.speed} BPM (${(l.speed / 60).toFixed(3)} Hz; first: fixture ${off[0].fixture} ${off[0].attribute} reads ${off[0].speed ?? "none"})`);
        }
        l.steps.forEach((st, n) => {
          if (!st.curve) return;
          const c = CURVES[st.curve];
          const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.01;
          const off = mine.filter((r) => {
            const own = r.steps?.[n];
            const next = r.steps?.[(n + 1) % 2];
            return !near(own?.decel, c.decel) || !near(next?.accel, c.nextAccel) || ("trans" in c && !near(own?.trans, c.trans));
          });
          if (off.length) problems.push(`line ${k} step ${n + 1}: ${off.length} value(s) do not have the ${c.console} curve (first: fixture ${off[0].fixture} ${off[0].attribute})`);
        });
      }
      if (s.editing) problems.push("the Edit Recipe mode is on");
      if (s.partZeroLines.length) problems.push(`Part Zero holds ${s.partZeroLines.length} line(s)`);
      if (s.modal) problems.push(`a dialog is open (${s.modal.title ?? "untitled"})`);
      coverage = { cooked: rows.length - uncooked.length, uncooked: uncooked.length, fixtures: [...new Set(rows.map((r) => r.fixture))].length, attributes: [...new Set(rows.map((r) => r.attribute))] };
      steps_.push(asRead({ name: "read_back", status: "succeeded", op: "preset.read" }));
      const what = `${ref}: ${specs.length} PhaserRecipe line(s), every value cooked with its line's 2 step presets${specs.some((l) => l.speed !== undefined) ? ", speed" : ""}${specs.some((l) => l.steps.some((x) => x.curve)) ? ", curves" : ""}, the Edit Recipe mode off, Part Zero and the programmer empty`;
      verification = problems.length ? { status: "mismatched", checked: what, detail: problems.join("; ") } : { status: "matched", checked: what };
    } catch (err) {
      steps_.push(asRead(stepFromError("read_back", err, { op: "preset.read" })));
    }
    const warnings = ["Between At Shape and the final ClearAll line 1 ran in the programmer (it was output on stage).", `${ref} stays the pending Edit Recipe target: a manual EditRecipe on another target opens "${UPDATE_DIALOG}" (answer Cancel, never OK).`];
    if (notDone.length) warnings.push(`not done as asked: ${notDone.join(", ")} (the preset and its lines are kept)`);
    return buildResult({ operation: op, target: tgt, steps: steps_, verification, warnings, extra: { plan, lines, linesMade, coverage } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

const stepSchema = z.object({
  preset: z.string().describe('Step preset "P.X".'),
  curve: z.enum(Object.keys(CURVES) as [CurveName, ...CurveName[]]).optional().describe("Step curve (default: the shape's). With Link Steps it shapes the move from this step to the next."),
});
const lineShape = {
  selection: z.number().describe("Group number."),
  shape: z.number().optional().describe("Shape pool number (default 1)."),
  steps: z.array(stepSchema).describe("Exactly 2 steps, in order, both from one preset pool."),
  matricks: z.number().optional().describe("MAtricks pool number (wings, blocks... spread the phase)."),
  speed_bpm: z.number().optional().describe("Speed X in BPM (60 BPM = 1 Hz); the console default otherwise (lines 2+ otherwise keep line 1's)."),
  phase: z.object({ from: z.number(), to: z.number() }).optional().describe("Phase X from/to in degrees (e.g. 0 to 360)."),
};

export const registerPhaserRecipeTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_edit_phaser_recipe",
    {
      title: "Build phaser recipe lines in a preset",
      description:
        "action create: builds PhaserRecipe lines (each: selection group, shape, 2 steps from presets with an optional curve, MAtricks, speed, phase) in a FREE preset slot. One line: give its fields at the top level; several (e.g. Dimmer + Colour in one preset): lines: [{...}, ...] (1-8). " +
        "The 2 steps of a line come from one preset pool (the line's family). The target is in that pool, or in an All pool (21-25), which is required when the lines are of different families. " +
        "Checked first, nothing sent otherwise: the slot is free, the groups, shapes, presets and MAtricks exist, the Edit Recipe mode is off with an empty Part Zero, no dialog is open, the programmer is empty (read completely), RecipeStoreMode is Normal. " +
        "Line 1: an empty Store of the preset (it clears the pending Edit Recipe target, so \"Update last object?\" does not open), EditRecipe queued without blocking the bridge (if \"Update last object?\" opens anyway it is answered Cancel, never OK, and the call stops), Group / At Shape / Step / At Preset / MAtricks one command at a time with the line checked in Part Zero, Store /Merge, the mode switched off and read back, ClearAll (line 1 runs on stage from At Shape until then). A failure up to here switches the mode off, clears the programmer and deletes the preset this call created. " +
        "Then the name; lines 2+ as copies of line 1 (Copy, then Assign of their group, shape, MAtricks and step presets; what they do not set is line 1's); SPEEDX / PHASEFROMX / PHASETOX per line; curves (Set ... Property \"Curve\"); Cook /MergeLowPriority. " +
        "Read back: the line count, each line's group and MAtricks, every value cooked and integrating one line's 2 step presets, each line's speed and curves in the cooked steps, nothing uncooked, mode off, programmer and Part Zero empty. " +
        "The preset then stays the pending Edit Recipe target: a manual EditRecipe elsewhere opens \"Update last object?\" (never OK). Never Store an empty programmer into an existing phaser preset: that wipes its lines. " +
        "The cue calls the preset with a standard line (gma3_store_recipe_cues); a cue line's Speed X replaces the preset's speed. preview: true runs the checks and returns the plan. Needs bridge 0.52.0.",
      inputSchema: {
        action: z.enum(["create"]),
        preset: z.string().describe('Target preset "P.N": a free slot, in the pool of the step presets or in an All pool (21-25).'),
        name: z.string().optional().describe("Preset name (otherwise the console names it after the lines)."),
        lines: z.array(z.object(lineShape)).optional().describe("Several lines (1-8), instead of the one-line fields below."),
        selection: lineShape.selection.optional(),
        shape: lineShape.shape,
        steps: lineShape.steps.optional(),
        matricks: lineShape.matricks,
        speed_bpm: lineShape.speed_bpm,
        phase: lineShape.phase,
        exclusive: z.boolean().optional().describe("Required (true) unless preview: nobody else uses the programmer or the Edit Recipe mode meanwhile."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => createPhaserRecipe(ctx, args as CreateArgs)),
  );
};
