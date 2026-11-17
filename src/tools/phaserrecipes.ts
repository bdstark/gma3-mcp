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
 *     retarget it. 21.9001 (All) held a Dimmer line and an RGBW line, 20/20 cooked, each at its own speed.
 *   - The preset's pool does not filter its recipe lines: a Dimmer + RGBW preset in the Dimmer pool (1.9012) and an
 *     RGBW phaser built in Edit Recipe mode in the Position pool (2.9003) cooked completely. The pool is free.
 *   - The line of a preset is `Preset P.N.L`; SPEEDX (BPM), PHASEFROMX and PHASETOX are its properties.
 *   - Step curve: `Set Preset P.N.L.1.<step>.1 Property "Curve" "<name>"` from the command line (the Lua `set` of the
 *     property is ignored, and CURVE reads back as an opaque id). With Link Steps (the default) a step's curve sets its
 *     DECEL and the next step's ACCEL (Snap also TRANS 0): Linear 0/0, Ease In +100/-100, Ease Out -100/+100,
 *     Ease In and Out -100/-100, Swing +100/+100, Snap 0/0 with TRANS 0. The cooked steps carry these values.
 *
 * Release: create builds in a free preset slot in any pool, 1 to 8 lines of exactly 2 steps each, the 2 steps of a line
 * from one preset pool (one family per line). set / add_line / remove_line edit an existing phaser preset (below).
 * The cue calls the preset with a standard line.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { presetId, STEP_DEFAULTS, type PresetRead } from "./presets.js";
import { listComplete, readLines } from "./recipes.js";
import { asRead, buildResult, commandStep, notRequested, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber, objectName, objectNumber } from "../validate.js";

const POLL_MS = 150;
const MODE_WAIT_MS = 3000;
const MAX_LINES = 8;
const UPDATE_DIALOG = "Update last object?";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notFound = (err: unknown) => err instanceof BridgeError && /no objects? found|no object at address|path not found/i.test(err.message);

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
/** A step curve to set: a predefined curve, or reset (back to the shape's curve; its values are the shape's, not compared). */
export type CurveChoice = CurveName | "reset";
const CURVE_CHOICES: [CurveChoice, ...CurveChoice[]] = ["reset", ...(Object.keys(CURVES) as CurveName[])];
const curveConsole = (c: CurveChoice) => (c === "reset" ? "Reset" : CURVES[c].console);
const isCurve = (c: unknown): c is CurveChoice => typeof c === "string" && (CURVE_CHOICES as string[]).includes(c);

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

async function readPreset(bridge: Gma3Bridge, ref: string, t: number, typesFor?: number[]): Promise<PresetRead | null> {
  try {
    return (await bridge.request("preset.read", { ref, ...(typesFor ? { typesFor } : {}) }, t)) as PresetRead;
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
  curve?: CurveChoice;
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
      if (r.curve !== undefined && !isCurve(r.curve)) v.fail(`${at("steps")}[${i}].curve must be one of ${CURVE_CHOICES.join(", ")}`);
      if (p) steps.push({ ...p, ...(isCurve(r.curve) ? { curve: r.curve } : {}) });
    });
  if (steps.length === 2 && steps[0].pool !== steps[1].pool) v.fail(`${at("steps")}: the 2 steps of a line come from one preset pool (one family per line; another family is another line), not pools ${steps[0].pool} and ${steps[1].pool}`);
  if (selection === undefined || shape === undefined || steps.length !== 2) return undefined;
  return { selection, shape, steps, matricks, speed, phase };
}

const pair = (l: LineSpec) => l.steps.map((s) => `${s.pool}.${s.number}`).join("/");

export async function createPhaserRecipe(ctx: ToolContext, raw: CreateArgs): Promise<OperationResult> {
  const op = "edit_phaser_recipe";
  const v = new Validator();
  if (raw.action !== "create") v.fail("createPhaserRecipe handles action create (set, add_line and remove_line: editPhaserRecipe)");
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
    for (const l of specs) if (l.steps.some((s) => s.pool === target.pool && s.number === target.number)) v.fail("a step preset cannot be the target preset itself");
  }
  const pairs = specs.map(pair);
  if (new Set(pairs).size !== pairs.length) v.fail("two lines have the same 2 step presets: their output could not be told apart in the read-back");
  if (specs[0]?.matricks !== undefined && specs.some((l) => l.matricks === undefined)) v.fail("lines[0] has a MAtricks and another line has none: the other lines are copies of line 1 and keep its MAtricks; give every line one, or put a line without MAtricks first");
  // Preferred, not required: one family per line (a cue reads more clearly). All-pool step presets may mix families.
  const advice = specs.flatMap((l, i) => (l.steps.some((s) => s.pool >= 21 && s.pool <= 25) ? [`line ${i + 1} takes its steps from an All pool (${l.steps[0].pool}): its presets may mix families; one family per line (Dimmer, Colour, Position... each its own line) is preferred`] : []));
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
  const curveCommands = (k: number, l: LineSpec) => l.steps.flatMap((s, i) => (s.curve ? [`Set ${sourceAt(k, i + 1)} Property "Curve" "${curveConsole(s.curve)}"`] : []));
  const plan = [
    `Store ${ref} /NoConfirmation   (empty programmer, free slot: creates the preset and clears the pending Edit Recipe target)`,
    `EditRecipe ${ref}   (queued; the mode is read back on, Part Zero empty)`,
    ...build,
    `Store ${ref} /Merge /NoConfirmation`,
    "EditRecipe   (queued; the mode is read back off)",
    "ClearAll",
    ...(name !== undefined ? [`set ${ref} Name=${name}`] : []),
    ...specs.flatMap((l, i) => [...(i > 0 ? copyCommands(i + 1, l) : []), ...settingsOf(l).map((s) => `set ${lineAt(i + 1)} ${s.property}=${s.value}`)]),
    // After every copy: a copy keeps its source's custom curves (live 2026-11-14), so line 1's must not be set yet.
    ...specs.flatMap((l, i) => curveCommands(i + 1, l)),
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
        const pref = (k: string) => String(c.preferences?.[k] ?? "").trim();
        const m = pref("RecipeStoreMode");
        if (m !== "Normal") return `the store preference RecipeStoreMode is ${JSON.stringify(m)}, not Normal`;
        // The first Store into the free slot must create an empty preset, and the /Merge store must take only the line
        // from the programmer: playback output (StoreSource Output), inactive values (ChannelFilter All) or open dimmers
        // (StoreLook) would be stored as uncooked data (probe SB-03, docs/probes/sb-03-presets-macos-2.5.1.md).
        const src = pref("StoreSource");
        if (src !== "Programmer") return `the store preference StoreSource is ${JSON.stringify(src)}, not Programmer: the store would take values from elsewhere. Ask the operator to set it to Programmer`;
        const filter = pref("ChannelFilter");
        if (!filter || /^all/i.test(filter)) return `the store preference ChannelFilter is ${JSON.stringify(filter)}: the store would take inactive programmer values too. Ask the operator to set it to Active`;
        const look = pref("StoreLook").toLowerCase();
        if (look !== "no" && look !== "off") return `the store preference StoreLook is ${JSON.stringify(pref("StoreLook"))}: the store would take every fixture with an open dimmer, and no store option turns Look off. Ask the operator to set Look off`;
        return null;
      }, "preset.context"));
    if (!ok) return fail(`${op} was not performed; nothing was sent: ${steps_.find((s) => s.status !== "succeeded")?.error ?? "a check failed"}`);
    if (preview) return buildResult({ operation: op, target: tgt, steps: steps_, summary: "Preview only; nothing was sent.", ...(advice.length ? { warnings: advice } : {}), extra: { plan, preview: true } });

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
    }
    // Curves after every copy: a copied line keeps line 1's custom curves.
    for (const [i, l] of specs.slice(0, linesMade).entries())
      for (const [j, c] of curveCommands(i + 1, l).entries()) if (!(await cmd(`line${i + 1}_curve_${j + 1}`, c))) notDone.push(`line ${i + 1} curve`);
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
          if (!st.curve || st.curve === "reset") return;
          const c = CURVES[st.curve];
          const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.01;
          const off = mine.filter((r) => {
            const own = r.steps?.[n];
            const next = r.steps?.[(n + 1) % 2];
            // preset.read leaves out a layer at its default (accel and decel 0, trans 100): read it as that default.
            if (!own || !next) return true;
            return !near(own.decel ?? STEP_DEFAULTS.decel, c.decel) || !near(next.accel ?? STEP_DEFAULTS.accel, c.nextAccel) || ("trans" in c && !near(own.trans ?? STEP_DEFAULTS.trans, c.trans));
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
    const warnings = [...advice, "Between At Shape and the final ClearAll line 1 ran in the programmer (it was output on stage).", `${ref} stays the pending Edit Recipe target: a manual EditRecipe on another target opens "${UPDATE_DIALOG}" (answer Cancel, never OK).`];
    if (notDone.length) warnings.push(`not done as asked: ${notDone.join(", ")} (the preset and its lines are kept)`);
    return buildResult({ operation: op, target: tgt, steps: steps_, verification, warnings, extra: { plan, lines, linesMade, coverage } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---- Editing an existing phaser preset (actions set, add_line, remove_line). No programmer and no Edit Recipe mode:
// every change is an Assign / Set / Copy / Delete on the preset's lines (live 2026-11-14, THK migration
// docs/phaser-recipes.md §1.9):
//   - `Assign Group|Shape|MAtricks n At Preset P.N.L` retargets a line; `Assign Preset X At Preset P.N.L.1.<step>.1`
//     changes a step's preset and keeps its curve. A new shape recomputes the steps' accel/decel from the shape;
//     a custom curve (one set with Set ... Property "Curve") survives it, "Reset" restores the shape's.
//   - `Copy Preset P.N.1 At Preset P.N.k` copies line 1 with its custom curves; `Delete Preset P.N.k` removes a line
//     and the later lines move up (3 lines, delete line 2: line 3 becomes line 2); its cooked values go at once.
//   - A cue that calls the preset with a standard line follows the change without being re-cooked (Sequence 9000
//     Cue 11 on 21.9005: speed, a new family and a removed line all showed in the cue's own values).

interface StepDetail {
  preset: { pool: number; number: number } | null;
  accel?: number;
  decel?: number;
  trans?: number;
}
/** One recipe line of a preset as the console reads it (numbers raw: SPEEDX in Hz, phase in degrees). */
export interface LineDetail {
  line: number;
  class: string;
  group: number | null;
  matricks: number | null;
  shape: number | null;
  speedHz?: number;
  phaseFrom?: number;
  phaseTo?: number;
  steps: StepDetail[];
}
type Handle = { class?: string; index?: number; addr?: string } | null;
type ChildList = { total?: number; count?: number; items?: Array<{ class?: string; index?: number; name?: string; fields?: Record<string, unknown> }> };
const handleOf = (v: unknown): Handle => (v && typeof v === "object" ? (v as Handle) : null);
const rawNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** The pool number an object handle points at (the last part of its address), when it has the class asked for. */
const numberOf = (v: unknown, cls: string): number | null => {
  const h = handleOf(v);
  if (!h || h.class !== cls || typeof h.addr !== "string") return null;
  const n = Number(h.addr.split(".").pop());
  return Number.isInteger(n) ? n : null;
};
const presetOf = (v: unknown): StepDetail["preset"] => {
  const h = handleOf(v);
  if (!h || h.class !== "Preset" || typeof h.addr !== "string") return null;
  const parts = h.addr.split(".");
  const pool = Number(parts[parts.length - 2]);
  const number = Number(parts[parts.length - 1]);
  return Number.isInteger(pool) && Number.isInteger(number) ? { pool, number } : null;
};
const stepPair = (l: { steps: StepDetail[] }): string | null =>
  l.steps.length === 2 && l.steps.every((s) => s.preset) ? l.steps.map((s) => `${s.preset!.pool}.${s.preset!.number}`).join("/") : null;

async function childList(bridge: Gma3Bridge, ref: string, fields: string[], t: number): Promise<ChildList> {
  const r = (await bridge.request("children", { ref, fields, asText: false, limit: 100 }, t)) as ChildList;
  if ((r.items?.length ?? 0) < (r.total ?? 0)) throw new Error(`${ref} has ${r.total} children; only ${r.items?.length ?? 0} were read`);
  return r;
}

/** Every recipe line of a preset with its group, MAtricks, shape, speed, phase and steps; null when the preset is not in the show. */
export async function readLineDetails(bridge: Gma3Bridge, ref: string, t: number): Promise<LineDetail[] | null> {
  let top: ChildList;
  try {
    top = await childList(bridge, ref, ["SPEEDX", "PHASEFROMX", "PHASETOX", "SHAPE", "MAtricks", "Selection"], t);
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
  const out: LineDetail[] = [];
  for (const [i, it] of (top.items ?? []).entries()) {
    if (it.class !== "PhaserRecipe" && it.class !== "StandardRecipe") continue;
    const f = it.fields ?? {};
    const line = typeof it.index === "number" ? it.index : i + 1;
    const d: LineDetail = { line, class: it.class, group: numberOf(f.Selection, "Group"), matricks: numberOf(f.MAtricks, "MAtrick"), shape: numberOf(f.SHAPE, "Shape"), steps: [] };
    if (it.class === "PhaserRecipe") {
      d.speedHz = rawNumber(f.SPEEDX);
      d.phaseFrom = rawNumber(f.PHASEFROMX);
      d.phaseTo = rawNumber(f.PHASETOX);
      const steps = await childList(bridge, `${ref}.${line}.1`, [], t);
      for (let n = 1; n <= (steps.items?.length ?? 0); n++) {
        const src = (await childList(bridge, `${ref}.${line}.1.${n}`, ["ACCELX", "DECELX", "TRANSX", "Preset"], t)).items?.[0]?.fields ?? {};
        d.steps.push({ preset: presetOf(src.Preset), accel: rawNumber(src.ACCELX), decel: rawNumber(src.DECELX), trans: rawNumber(src.TRANSX) });
      }
    }
    out.push(d);
  }
  return out;
}

/** What a line should read after the edit; an undefined field is not compared. */
interface LineExpect {
  class: string;
  group: number | null;
  matricks: number | null;
  shape: number | null;
  speedHz?: number;
  phaseFrom?: number;
  phaseTo?: number;
  steps: StepDetail[];
}
const near = (a: number | undefined, b: number | undefined, tol: number) => b === undefined || (a !== undefined && Math.abs(a - b) < tol);
function lineDiff(label: string, got: LineDetail | undefined, want: LineExpect): string[] {
  if (!got) return [`${label} is missing`];
  const p: string[] = [];
  if (got.class !== want.class) p.push(`${label} is a ${got.class}, not a ${want.class}`);
  if (got.group !== want.group) p.push(`${label} selection reads ${got.group === null ? "none" : `Group ${got.group}`}, Group ${want.group} expected`);
  if (got.matricks !== want.matricks) p.push(`${label} MAtricks reads ${got.matricks ?? "none"}, ${want.matricks ?? "none"} expected`);
  if (got.shape !== want.shape) p.push(`${label} shape reads ${got.shape ?? "none"}, Shape ${want.shape} expected`);
  if (!near(got.speedHz, want.speedHz, 0.001)) p.push(`${label} speed reads ${got.speedHz === undefined ? "none" : `${+(got.speedHz * 60).toFixed(3)} BPM`}, ${+(want.speedHz! * 60).toFixed(3)} BPM expected`);
  if (!near(got.phaseFrom, want.phaseFrom, 0.01) || !near(got.phaseTo, want.phaseTo, 0.01)) p.push(`${label} phase reads ${got.phaseFrom} to ${got.phaseTo}, ${want.phaseFrom ?? "(unchanged)"} to ${want.phaseTo ?? "(unchanged)"} expected`);
  if (got.steps.length !== want.steps.length) p.push(`${label} has ${got.steps.length} step(s), ${want.steps.length} expected`);
  want.steps.forEach((w, n) => {
    const g = got.steps[n];
    if (!g) return;
    const wp = w.preset ? `${w.preset.pool}.${w.preset.number}` : null;
    const gp = g.preset ? `${g.preset.pool}.${g.preset.number}` : null;
    if (wp !== gp) p.push(`${label} step ${n + 1} preset reads ${gp ?? "none"}, ${wp ?? "none"} expected`);
    for (const k of ["accel", "decel", "trans"] as const) if (!near(g[k], w[k], 0.01)) p.push(`${label} step ${n + 1} ${k} reads ${g[k] ?? "none"}, ${w[k]} expected`);
  });
  return p;
}
const expectOf = (d: LineDetail): LineExpect => ({ class: d.class, group: d.group, matricks: d.matricks, shape: d.shape, speedHz: d.speedHz, phaseFrom: d.phaseFrom, phaseTo: d.phaseTo, steps: d.steps.map((s) => ({ ...s })) });

type Row = PresetRead["rows"][number];
const rowPairOf = (r: Row) => (r.stepCount === 2 ? [0, 1].map((i) => `${r.steps?.[i]?.integrated?.pool}.${r.steps?.[i]?.integrated?.no}`).join("/") : "?");
/** Which cooked value a row is: fixture, cell, attribute, the line's step presets and whether it is cooked. */
const rowId = (r: Row) => `${r.fixture}|${r.sfIndex ?? ""}|${r.attribute}|${rowPairOf(r)}|${r.cooked === true}`;
/** Tolerances of the playback-significant fields: percent layers 0.5 (as gma3_store_cue's check), speed in Hz, phase in degrees. */
const ROW_TOL = { percent: 0.5, speed: 0.001, phase: 0.01, measure: 0.01, time: 0.01 };
const refOf = (o: { pool?: number; no?: number; addrNative?: string } | null | undefined) => (o ? `${o.addrNative ?? `${o.pool}.${o.no}`}` : "");
/** A field that differs between two readings of one cooked value, or undefined when they agree (absent = absent). */
function rowDifference(a: Row, b: Row): string | undefined {
  const num = (field: string, x: number | null | undefined, y: number | null | undefined, tol: number) => {
    const ax = typeof x === "number" ? x : undefined;
    const by = typeof y === "number" ? y : undefined;
    if (ax === undefined && by === undefined) return undefined;
    if (ax === undefined || by === undefined || Math.abs(ax - by) > tol) return `${field} ${ax ?? "none"} -> ${by ?? "none"}`;
    return undefined;
  };
  const top =
    num("value", a.value, b.value, ROW_TOL.percent) ?? num("relative", a.relative, b.relative, ROW_TOL.percent) ??
    num("fade", a.fade, b.fade, ROW_TOL.time) ?? num("delay", a.delay, b.delay, ROW_TOL.time) ??
    num("speed", a.speed, b.speed, ROW_TOL.speed) ?? num("phase", a.phase, b.phase, ROW_TOL.phase) ??
    num("measure", a.measure, b.measure, ROW_TOL.measure) ?? num("speedMaster", a.speedMaster, b.speedMaster, 0) ??
    num("stepCount", a.stepCount, b.stepCount, 0) ??
    (refOf(a.absPreset) !== refOf(b.absPreset) ? `absPreset ${refOf(a.absPreset) || "none"} -> ${refOf(b.absPreset) || "none"}` : undefined) ??
    (refOf(a.relPreset) !== refOf(b.relPreset) ? `relPreset ${refOf(a.relPreset) || "none"} -> ${refOf(b.relPreset) || "none"}` : undefined);
  if (top) return top;
  const sa = a.steps ?? [];
  const sb = b.steps ?? [];
  if (sa.length !== sb.length) return `steps ${sa.length} -> ${sb.length}`;
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i];
    const y = sb[i];
    for (const k of ["absolute", "relative", "accel", "decel", "trans", "width"] as const) {
      const d = num(`step ${i + 1} ${k}`, x[k], y[k], ROW_TOL.percent);
      if (d) return d;
    }
    if (refOf(x.integrated) !== refOf(y.integrated)) return `step ${i + 1} preset ${refOf(x.integrated) || "none"} -> ${refOf(y.integrated) || "none"}`;
  }
  return undefined;
}
/** A stable order for rows with the same id (a cell read twice), so equal readings pair up. */
const rowOrder = (r: Row) => [r.value, r.relative, ...(r.steps ?? []).flatMap((x) => [x.absolute, x.relative])].map((n) => (typeof n === "number" ? n.toFixed(3) : "-")).join(",");
/**
 * The cooked values of the other lines, before and after: every playback-significant field (values, relative values,
 * every step layer and preset, speed, phase, measure, speed master, fade, delay, preset references) is compared
 * within ROW_TOL. Returns one line per changed value (id and the first field that differs).
 */
function changedRows(before: Row[], after: Row[]): string[] {
  const group = (rows: Row[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(rowId(r), [...(m.get(rowId(r)) ?? []), r]);
    for (const list of m.values()) list.sort((x, y) => rowOrder(x).localeCompare(rowOrder(y)));
    return m;
  };
  const b = group(before);
  const a = group(after);
  const out: string[] = [];
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const lb = b.get(id) ?? [];
    const la = a.get(id) ?? [];
    const [fixture, cell, attribute, pair, cooked] = id.split("|");
    const label = `${fixture}${cell ? ` cell ${cell}` : ""} ${attribute} ${pair}${cooked === "true" ? "" : " (not cooked)"}`;
    if (lb.length !== la.length) {
      out.push(`${label}: ${lb.length} value(s) before, ${la.length} after`);
      continue;
    }
    for (let i = 0; i < lb.length; i++) {
      const d = rowDifference(lb[i], la[i]);
      if (d) out.push(`${label}: ${d}`);
    }
  }
  return out;
}

interface EditArgs extends CreateArgs {
  line?: unknown;
}
const EDIT_ACTIONS = ["set", "add_line", "remove_line"] as const;

export async function editPhaserRecipe(ctx: ToolContext, raw: EditArgs): Promise<OperationResult> {
  const op = "edit_phaser_recipe";
  const v = new Validator();
  const action = raw.action as (typeof EDIT_ACTIONS)[number];
  if (!(EDIT_ACTIONS as readonly string[]).includes(String(raw.action))) v.fail(`action must be one of create, ${EDIT_ACTIONS.join(", ")}`);
  const target = v.check(() => presetId("preset", raw.preset));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  if (raw.lines !== undefined) v.fail(`lines is for action create; ${action} edits one line`);
  const given = LINE_FIELDS.filter((f) => raw[f] !== undefined);
  const lineNo = raw.line === undefined ? (action === "add_line" ? undefined : 1) : v.check(() => objectNumber("line", raw.line, { max: MAX_LINES }));
  if (action === "add_line" && raw.line !== undefined) v.fail("add_line appends the line after the last one: line is not given");
  if (action === "remove_line" && (given.length || name !== undefined)) v.fail(`remove_line takes preset and line only (got ${[...given, ...(name !== undefined ? ["name"] : [])].join(", ")})`);
  // set: each field is optional; steps is 2 items, each {preset?, curve?} ({} keeps the step).
  const change: Omit<Partial<LineSpec>, "steps"> & { steps?: Array<Partial<StepSpec>> } = {};
  let addSpec: LineSpec | undefined;
  if (action === "set") {
    if (!given.length && name === undefined) v.fail(`set changes at least one of ${LINE_FIELDS.join(", ")}, name`);
    if (raw.selection !== undefined) change.selection = v.check(() => objectNumber("selection", raw.selection, { max: 9999 }));
    if (raw.shape !== undefined) change.shape = v.check(() => objectNumber("shape", raw.shape, { max: 9999 }));
    if (raw.matricks !== undefined) change.matricks = v.check(() => objectNumber("matricks", raw.matricks, { max: 9999 }));
    if (raw.speed_bpm !== undefined) change.speed = v.check(() => finiteNumber("speed_bpm", raw.speed_bpm, { min: 0.01, max: 6000 }));
    if (raw.phase !== undefined) {
      const p = raw.phase as Record<string, unknown> | null;
      if (!p || typeof p !== "object") v.fail("phase must be {from, to} in degrees");
      else {
        const from = v.check(() => finiteNumber("phase.from", p.from, { min: -36000, max: 36000 }));
        const to = v.check(() => finiteNumber("phase.to", p.to, { min: -36000, max: 36000 }));
        if (from !== undefined && to !== undefined) change.phase = { from, to };
      }
    }
    if (raw.steps !== undefined) {
      if (!Array.isArray(raw.steps) || raw.steps.length !== 2) v.fail('steps must be exactly 2 items, each {preset?: "P.X", curve?} ({} keeps that step)');
      else
        change.steps = raw.steps.map((s, i) => {
          const r = (s ?? {}) as Record<string, unknown>;
          const out: Partial<StepSpec> = {};
          if (r.preset !== undefined) Object.assign(out, v.check(() => presetId(`steps[${i}].preset`, r.preset)) ?? {});
          if (r.curve !== undefined) {
            if (isCurve(r.curve)) out.curve = r.curve;
            else v.fail(`steps[${i}].curve must be one of ${CURVE_CHOICES.join(", ")}`);
          }
          return out;
        });
    }
  } else if (action === "add_line") {
    addSpec = parseLine(v, raw as Record<string, unknown>, "");
  }
  /** Steps reset to the shape's curve (every step given a curve; with add_line every step), then the named curves. */
  const curvePlan = (reqSteps: Array<Partial<StepSpec>>) => ({
    resets: reqSteps.flatMap((st, n) => (st.curve !== undefined || action === "add_line" ? [n] : [])),
    named: reqSteps.flatMap((st, n): Array<[number, CurveName]> => (st.curve && st.curve !== "reset" ? [[n, st.curve]] : [])),
  });
  const tgt: Record<string, unknown> = { action: raw.action, preset: raw.preset, ...(lineNo !== undefined ? { line: lineNo } : {}) };
  if (!v.ok || !target) return validationFailure(op, tgt, v.errors);
  const ref = `Preset ${target.pool}.${target.number}`;
  tgt.ref = ref;
  const bridge = ctx.bridge;
  const tm = ctx.requestTimeoutMs;
  const preview = raw.preview === true;

  const body = async (): Promise<OperationResult> => {
    const steps_: StepResult[] = [];
    let plan: string[] = [];
    const fail = (summary: string) => buildResult({ operation: op, target: tgt, steps: steps_, summary, extra: { plan } });
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
    let before: LineDetail[] = [];
    let rowsBefore: Row[] = [];
    let referencedBy: number | undefined;
    let k = lineNo ?? 0; // the line edited, added or removed
    let want: LineExpect | undefined; // the edited or added line after the edit
    const lineAt = (n: number) => `${ref}.${n}`;
    const sourceAt = (n: number, step: number) => `${ref}.${n}.1.${step}.1`;
    const ok =
      (await read("read_target", async () => {
        const ls = await readLineDetails(bridge, ref, tm);
        if (!ls) return `${ref} is not in the show (action create builds a new phaser preset)`;
        const data = await readPreset(bridge, ref, tm);
        if (data?.truncated) return `${ref} was not read completely`;
        before = ls;
        rowsBefore = data?.rows ?? [];
        referencedBy = data?.referencedBy;
        if (!ls.length) return `${ref} has no recipe line`;
        if (action === "add_line") {
          if (ls.length >= MAX_LINES) return `${ref} already has ${ls.length} lines (at most ${MAX_LINES})`;
          if (ls[0].class !== "PhaserRecipe") return `line 1 of ${ref} is a ${ls[0].class}: a new line is a copy of line 1, a PhaserRecipe`;
          if (!stepPair(ls[0])) return `line 1 of ${ref} has ${ls[0].steps.length} step(s)${ls[0].steps.some((s) => !s.preset) ? ", not all from a preset" : ""}: a new line is a copy of line 1, and this release copies lines of 2 steps, each from a preset`;
          k = ls.length + 1;
          return null;
        }
        const line = ls[k - 1];
        if (!line) return `${ref} has ${ls.length} line(s), no line ${k}`;
        if (line.class !== "PhaserRecipe") return `line ${k} of ${ref} is a ${line.class}, not a PhaserRecipe`;
        if (action === "remove_line" && ls.length === 1) return `line ${k} is the only line of ${ref}: delete the preset instead`;
        // Its cooked values are told apart by their 2 step presets: the read-back needs them, removal included.
        if (!stepPair(line)) return `line ${k} has ${line.steps.length} step(s)${line.steps.some((s) => !s.preset) ? ", not all from a preset" : ""}: this release edits lines of 2 steps, each from a preset`;
        return null;
      }, "children")) &&
      (await read("check_edit", async () => {
        if (action === "remove_line") return null;
        const base = action === "set" ? before[k - 1] : before[0];
        const w = expectOf(base);
        const shapeChanged = action === "set" ? change.shape !== undefined && change.shape !== base.shape : true;
        const s = action === "set" ? change : addSpec!;
        if (s.selection !== undefined) w.group = s.selection;
        if (action === "set" ? s.shape !== undefined : raw.shape !== undefined) w.shape = s.shape!;
        if (s.matricks !== undefined) w.matricks = s.matricks;
        if (s.speed !== undefined) w.speedHz = s.speed / 60;
        if (s.phase) {
          w.phaseFrom = s.phase.from;
          w.phaseTo = s.phase.to;
        }
        const reqSteps: Array<Partial<StepSpec>> = s.steps ?? [{}, {}];
        reqSteps.forEach((st, n) => {
          if (st.pool !== undefined) w.steps[n].preset = { pool: st.pool, number: st.number! };
        });
        // Curves: a new shape recomputes them (a custom curve survives, not knowable here). Every step given a curve
        // is reset to the shape's first (a named curve over a Snap would keep its TRANS 0), every step of a new line
        // too (a copy keeps line 1's custom curves); then the named curves. Reset values are the shape's: not compared.
        if (shapeChanged) w.steps.forEach((x) => Object.assign(x, { accel: undefined, decel: undefined, trans: undefined }));
        curvePlan(reqSteps).resets.forEach((n) => {
          Object.assign(w.steps[n], { decel: undefined, trans: undefined });
          w.steps[(n + 1) % 2].accel = undefined;
        });
        curvePlan(reqSteps).named.forEach(([n, c]) => {
          const cv = CURVES[c];
          w.steps[n].decel = cv.decel;
          if ("trans" in cv) w.steps[n].trans = cv.trans;
          w.steps[(n + 1) % 2].accel = cv.nextAccel;
        });
        want = w;
        const pools = w.steps.map((x) => x.preset!.pool);
        if (pools[0] !== pools[1]) return `the 2 steps of a line come from one preset pool (one family per line; another family is another line), not pools ${pools[0]} and ${pools[1]}`;
        if (w.steps.some((x) => x.preset!.pool === target.pool && x.preset!.number === target.number)) return "a step preset cannot be the target preset itself";
        const mine = stepPair(w);
        const clash = before.find((l, i) => i !== k - 1 && stepPair(l) === mine);
        if (clash) return `line ${clash.line} already has the step presets ${mine}: two lines with the same 2 step presets cannot be told apart in the read-back`;
        return null;
      })) &&
      (await read("check_references", async () => {
        if (!want) return null;
        const refs = [`Group ${want.group}`, `Shape ${want.shape}`, ...(want.matricks !== null ? [`MAtricks ${want.matricks}`] : [])];
        const missing: string[] = [];
        for (const r of refs) if (!(await exists(bridge, r, tm))) missing.push(r);
        for (const st of want.steps) if (!(await readPreset(bridge, `Preset ${st.preset!.pool}.${st.preset!.number}`, tm))) missing.push(`Preset ${st.preset!.pool}.${st.preset!.number}`);
        return missing.length ? `not in the show: ${missing.join(", ")}` : null;
      })) &&
      (await read("read_edit_state", async () => {
        const s = await readEditState(bridge, tm);
        if (s.modalError) return `whether a dialog is open cannot be read (${s.modalError})`;
        if (s.modal) return `a dialog is open (${s.modal.title ?? "untitled"}): answer it first`;
        if (s.editing) return "the Edit Recipe mode is on: switch it off first";
        return null;
      }, "recipe.editState"));

    // ---- The commands, in order: retarget, step presets, curves (after the shape: a new shape recomputes them), speed / phase, name.
    const commands: string[] = [];
    const settings: Array<{ property: string; value: number }> = [];
    if (action === "remove_line") commands.push(`Delete ${lineAt(k)} /NoConfirmation`);
    else if (want) {
      const base = action === "set" ? before[k - 1] : before[0];
      const s = action === "set" ? change : addSpec!;
      if (action === "add_line") commands.push(`Copy ${lineAt(1)} At ${lineAt(k)} /NoConfirmation`);
      if (want.group !== base.group) commands.push(`Assign Group ${want.group} At ${lineAt(k)}`);
      if (want.shape !== base.shape) commands.push(`Assign Shape ${want.shape} At ${lineAt(k)}`);
      if (want.matricks !== base.matricks) commands.push(`Assign MAtricks ${want.matricks} At ${lineAt(k)}`);
      const reqSteps: Array<Partial<StepSpec>> = s.steps ?? [{}, {}];
      reqSteps.forEach((st, n) => {
        if (st.pool !== undefined) commands.push(`Assign Preset ${st.pool}.${st.number} At ${sourceAt(k, n + 1)}`);
      });
      const cp = curvePlan(reqSteps);
      for (const n of cp.resets) commands.push(`Set ${sourceAt(k, n + 1)} Property "Curve" "Reset"`);
      for (const [n, c] of cp.named) commands.push(`Set ${sourceAt(k, n + 1)} Property "Curve" "${curveConsole(c)}"`);
      if (s.speed !== undefined) settings.push({ property: "SPEEDX", value: s.speed });
      if (s.phase) settings.push({ property: "PHASEFROMX", value: s.phase.from }, { property: "PHASETOX", value: s.phase.to });
    }
    plan = [...commands, ...settings.map((x) => `set ${lineAt(k)} ${x.property}=${x.value}`), ...(name !== undefined ? [`set ${ref} Name=${name}`] : []), `Cook ${ref} /MergeLowPriority`];
    if (!ok) return fail(`${op} was not performed; nothing was sent: ${steps_.find((s) => s.status !== "succeeded")?.error ?? "a check failed"}`);
    if (preview) return buildResult({ operation: op, target: tgt, steps: steps_, summary: "Preview only; nothing was sent.", extra: { plan, preview: true, before: before[k - 1] ?? null } });

    // ---- Send. The first failure stops the edit (nothing is undone); the preset is cooked and read back either way.
    const notDone: string[] = [];
    let stopped = false;
    for (const [j, c] of commands.entries()) {
      const s = await commandStep(bridge, `edit_${j + 1}`, c, tm);
      steps_.push(s);
      if (s.status !== "succeeded") {
        stopped = true;
        notDone.push(`"${c}" and what follows it`);
        break;
      }
      if (action === "add_line" && j === 0) {
        const n = await readLines(bridge, { kind: "preset", pool: target.pool, number: target.number }, tm).catch(() => null);
        const good = n?.length === k && n[k - 1]?.class === "PhaserRecipe";
        steps_.push(asRead({ name: "line_copied", status: good ? "succeeded" : "failed", op: "children", ...(good ? {} : { error: `${ref} has ${n?.length ?? "an unknown number of"} line(s) after the copy, ${k} expected` }) }));
        if (!good) {
          stopped = true;
          notDone.push("the new line's settings");
          break;
        }
      }
    }
    for (const x of stopped ? [] : settings) {
      const stepName = `set_${x.property.toLowerCase()}`;
      try {
        const r = (await bridge.request("set", { ref: lineAt(k), property: x.property, value: String(x.value) }, tm)) as { value?: unknown };
        const good = numberMatches(x.value, r?.value);
        steps_.push({ name: stepName, status: good ? "succeeded" : "failed", op: "set", ...(good ? {} : { error: `${x.property} reads ${JSON.stringify(r?.value)} after writing ${x.value}` }) });
        if (!good) notDone.push(x.property);
      } catch (err) {
        steps_.push(stepFromError(stepName, err, { op: "set" }));
        notDone.push(x.property);
      }
    }
    if (!stopped && name !== undefined) {
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
    steps_.push(await commandStep(bridge, "cook", `Cook ${ref} /MergeLowPriority`, tm));

    // ---- Read back: the edited line as asked, every other line and its cooked values unchanged.
    let verification: Verification = notRequested();
    let after: LineDetail[] | null = null;
    let maskedNote: string | undefined;
    try {
      after = (await readLineDetails(bridge, ref, tm)) ?? [];
      const data = await readPreset(bridge, ref, tm);
      const s = await readEditState(bridge, tm);
      const rows = data?.rows ?? [];
      const problems: string[] = [];
      const expected: Array<{ label: string; want: LineExpect }> = before.map((l) => ({ label: `line ${l.line}`, want: expectOf(l) }));
      if (action === "set") expected[k - 1].want = want!;
      if (action === "add_line") expected.push({ label: `line ${k}`, want: want! });
      if (action === "remove_line") expected.splice(k - 1, 1);
      if (after.length !== expected.length) problems.push(`${ref} has ${after.length} line(s), ${expected.length} expected`);
      expected.forEach((e, i) => {
        const label = action === "remove_line" && i >= k - 1 ? `${e.label} (now line ${i + 1})` : e.label;
        problems.push(...lineDiff(label, after![i], e.want));
      });
      // Cooked values: the edited line's pair has values at its speed; the old pair's are gone; every other value unchanged.
      const oldPair = action === "add_line" ? null : stepPair(before[k - 1]);
      const newPair = want ? stepPair(want) : null;
      const shared = (p: string | null) => p !== null && before.filter((l) => stepPair(l) === p).length > 1;
      // A fixture and attribute the edited line output, before or after, is left out: there one line masks another
      // (the later line wins), so another line's value may rightly appear or go.
      const covered = new Set([...rowsBefore.filter((r) => rowPairOf(r) === oldPair), ...rows.filter((r) => rowPairOf(r) === newPair)].map((r) => `${r.fixture}|${r.attribute}`));
      const mine = (r: Row) => rowPairOf(r) === oldPair || rowPairOf(r) === newPair || covered.has(`${r.fixture}|${r.attribute}`);
      const changed = changedRows(rowsBefore.filter((r) => !mine(r)), rows.filter((r) => !mine(r)));
      if (changed.length) problems.push(`${changed.length} value(s) of the other lines changed (first: ${changed[0]})`);
      const uncookedBefore = rowsBefore.filter((r) => r.cooked !== true).length;
      const uncooked = rows.filter((r) => r.cooked !== true).length;
      if (uncooked > uncookedBefore) problems.push(`${ref} holds ${uncooked} uncooked value(s), ${uncookedBefore} before`);
      if (data?.truncated) problems.push(`${ref} was not read completely`);
      if (oldPair && oldPair !== newPair && !shared(oldPair)) {
        const stale = rows.filter((r) => rowPairOf(r) === oldPair);
        if (stale.length) problems.push(`${stale.length} cooked value(s) still come from the old step presets ${oldPair}`);
      }
      if (newPair && want) {
        const got = rows.filter((r) => rowPairOf(r) === newPair);
        // A later line on the same group masks this line's cooked values (the later line wins on each fixture and
        // attribute both output): then no cooked value from this line is expected; its definition is still checked.
        const posAfter = action === "remove_line" ? -1 : k - 1;
        // A later line masks this one only where it outputs every fixture, cell and attribute this line would (review of
        // #138). That is read from the step presets themselves: the union of what this line's 2 step presets hold must be
        // inside the union of what the later line's step presets hold (a pool proves nothing: pool 4 holds RGB and
        // ColorWheel presets alike). The later line must also have cooked values, and cover every value this line
        // output before the edit. Coverage that cannot be read (a preset missing, empty or read in part) is no proof.
        // Only what the line's selection holds counts (follow-up #138): a step preset may hold fixtures its group does
        // not, and the line outputs only the group's fixtures and cells. Both lines' preset coverage is cut to the edited
        // line's group (read with group.read); when the group cannot be read completely, nothing is cut (conservative).
        const keyOf = (r: { fixture?: unknown; sfIndex?: unknown; attribute?: unknown }) => `${r.fixture}|${r.sfIndex ?? ""}|${r.attribute}`;
        type Cell = { fixture?: unknown; sfIndex?: unknown; attribute?: unknown; mode?: unknown; fixtureType?: unknown };
        let selection: Array<{ fixture: string | null; sfIndex: number }> | null = null;
        try {
          const g = (await bridge.request("group.read", { ref: `Group ${want!.group}` }, tm)) as { truncated?: boolean; items?: Array<{ fixture?: string | null; sfIndex?: number; unreadable?: boolean }> };
          const items = g.items ?? [];
          if (g.truncated !== true && items.length && items.every((x) => !x.unreadable && typeof x.sfIndex === "number")) selection = items.map((x) => ({ fixture: x.fixture ?? null, sfIndex: x.sfIndex! }));
        } catch {
          selection = null;
        }
        // What a preset row applies to inside the selection depends on its mode (follow-up #140, docs/tools/presets.md):
        // a selective row to its own fixture or cell, a global row to every selected fixture of its fixture type (it
        // sits on the lowest FID of that type, which may be outside the group), a universal row to every selected
        // fixture that has its attribute. Inside the selection each row becomes the members it applies to
        // (`m:<sfIndex>|<attribute>`). Fixture types come from preset.read's typesFor, in the same form as the rows'
        // fixtureType ("6 Mega Hex Par"); a member's attributes from fixtureAttributes. A row whose type or attributes
        // cannot be read stays as itself (`r:<row>`), matched only by the identical row of the other line. Without a
        // readable selection every row stays as itself.
        const memberTypes = new Map<number, string>();
        const memberAttrs = new Map<string, Set<string> | null>();
        const attrsOf = async (m: { fixture: string | null }): Promise<Set<string> | null> => {
          if (m.fixture === null) return null;
          if (memberAttrs.has(m.fixture)) return memberAttrs.get(m.fixture)!;
          let attrs: Set<string> | null = null;
          try {
            const fa = (await bridge.request("fixtureAttributes", { ref: `Fixture ${m.fixture}`, limit: 500 }, tm)) as { total?: number; offset?: number; count?: number; attributes?: Array<{ attribute?: string }> };
            if (Array.isArray(fa.attributes) && listComplete({ ...fa, items: fa.attributes })) attrs = new Set(fa.attributes.map((x) => String(x.attribute)));
          } catch {
            attrs = null;
          }
          memberAttrs.set(m.fixture, attrs);
          return attrs;
        };
        type Applied = { fixture?: unknown; sfIndex?: unknown; attribute?: unknown; mode?: unknown; fixtureType?: unknown };
        const appliesTo = async (r: Applied): Promise<string[]> => {
          const literal = [`r:${keyOf(r)}`];
          if (selection === null) return literal;
          const attr = String(r.attribute);
          const mode = String(r.mode ?? "selective").toLowerCase();
          if (mode === "universal") {
            // Universal data reaches every selected fixture that has the attribute (as gma3_cook_recipes predicts it).
            const out: string[] = [];
            for (const m of selection) {
              const has = await attrsOf(m);
              if (has === null) return literal;
              if (has.has(attr)) out.push(`m:${m.sfIndex}|${attr}`);
            }
            return out;
          }
          if (mode === "global") {
            if (typeof r.fixtureType !== "string" || r.fixtureType === "") return literal;
            const out: string[] = [];
            for (const m of selection) {
              const t = memberTypes.get(m.sfIndex);
              if (t === undefined) return literal;
              if (t === r.fixtureType) out.push(`m:${m.sfIndex}|${attr}`);
            }
            return out;
          }
          // Selective: by its cell (sfIndex) when it has one, else by its fixture; outside the selection it applies to nothing.
          return selection.filter((m) => (typeof r.sfIndex === "number" ? m.sfIndex === r.sfIndex : m.fixture !== null && m.fixture === String(r.fixture))).map((m) => `m:${m.sfIndex}|${attr}`);
        };
        const appliedKeys = async (cells: Applied[]): Promise<string[]> => {
          const out: string[] = [];
          for (const c of cells) out.push(...(await appliesTo(c)));
          return out;
        };
        const coverageCache = new Map<string, Cell[] | null>();
        const coverage = async (pair: string): Promise<Cell[] | null> => {
          if (coverageCache.has(pair)) return coverageCache.get(pair)!;
          let cells: Cell[] | null = [];
          for (const p of pair.split("/")) {
            const typesFor = selection?.map((m) => m.sfIndex);
            const d = await readPreset(bridge, `Preset ${p}`, tm, typesFor).catch(() => null);
            if (!d || d.truncated || !d.rows?.length || d.rows.some((r) => !r.attribute)) {
              cells = null;
              break;
            }
            for (const [sf, t] of Object.entries(d.types ?? {})) if (typeof t === "string" && t !== "") memberTypes.set(Number(sf), t);
            cells.push(...d.rows);
          }
          coverageCache.set(pair, cells);
          return cells;
        };
        const oldKeys = oldPair ? rowsBefore.filter((r) => rowPairOf(r) === oldPair).map(keyOf) : [];
        const masks = async (l: LineDetail): Promise<boolean> => {
          const pair = stepPair(l);
          if (l.group === null || l.group !== want!.group || pair === null) return false;
          const theirs = rows.filter((r) => rowPairOf(r) === pair);
          if (!theirs.length) return false;
          const cooked = new Set(theirs.map(keyOf));
          if (!oldKeys.every((key) => cooked.has(key))) return false;
          const mine = await coverage(newPair!);
          const covers = await coverage(pair);
          if (mine === null || covers === null) return false;
          const mineIn = await appliedKeys(mine);
          const coversIn = new Set(await appliedKeys(covers));
          // Nothing of the edited line's presets inside its selection: no output to mask, so no proof either.
          return mineIn.length > 0 && mineIn.every((key) => coversIn.has(key));
        };
        let masker: LineDetail | undefined;
        if (!got.length && after) for (const l of after.slice(posAfter + 1)) if (await masks(l)) { masker = l; break; }
        if (masker) maskedNote = `line ${k} cooks no value: line ${masker.line} on the same group (Group ${want!.group}) masks it; its definition was checked`;
        else if (!got.length) problems.push(`no cooked value comes from line ${k} (Preset ${newPair.replace("/", " / Preset ")})`);
        else if (want.speedHz !== undefined && !shared(newPair)) {
          const off = got.filter((r) => typeof r.speed !== "number" || Math.abs(r.speed - want!.speedHz!) > 0.001);
          if (off.length) problems.push(`line ${k}: ${off.length} cooked value(s) do not run at ${+(want.speedHz * 60).toFixed(3)} BPM`);
        }
      }
      if (s.modal) problems.push(`a dialog is open (${s.modal.title ?? "untitled"})`);
      steps_.push(asRead({ name: "read_back", status: "succeeded", op: "children" }));
      const what = `${ref}: ${action === "remove_line" ? `line ${k} removed, the later lines moved up` : `line ${k} ${action === "add_line" ? "added" : "edited"} (group, shape, MAtricks, step presets, speed, phase, curves set)`}, the other lines and their cooked values unchanged, the edited line's values cooked`;
      verification = problems.length ? { status: "mismatched", checked: what, detail: problems.join("; ") } : { status: "matched", checked: what };
    } catch (err) {
      steps_.push(asRead(stepFromError("read_back", err, { op: "children" })));
    }
    const warnings: string[] = [];
    if (notDone.length) warnings.push(`not done as asked: ${notDone.join(", ")} (nothing was undone)`);
    if (want && action === "set" && change.shape !== undefined) warnings.push("a new shape recomputes the curves of steps without a custom curve; a custom curve stays (give curve: reset to go back to the shape's)");
    const notes = [`cues that call ${ref} with a standard line follow the change without being re-cooked${referencedBy ? ` (${referencedBy} object(s) reference it)` : ""}; a cue line with its own Speed X keeps that speed`, ...(maskedNote ? [maskedNote] : [])];
    return buildResult({ operation: op, target: tgt, steps: steps_, verification, ...(warnings.length ? { warnings } : {}), extra: { plan, notes, before: action === "add_line" ? null : before[k - 1] ?? null, lines: after } });
  };
  return preview ? body() : ctx.mutations.run(body);
}

const stepSchema = z.object({
  preset: z.string().optional().describe('Step preset "P.X" (required by create and add_line; set: omit to keep the step\'s).'),
  curve: z.enum(CURVE_CHOICES).optional().describe("Step curve (default: the shape's; reset: back to the shape's). With Link Steps it shapes the move from this step to the next."),
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
      title: "Build or edit phaser recipe lines in a preset",
      description:
        "action create: builds PhaserRecipe lines (each: selection group, shape, 2 steps from presets with an optional curve, MAtricks, speed, phase) in a FREE preset slot. One line: give its fields at the top level; several (e.g. Dimmer + Colour in one preset): lines: [{...}, ...] (1-8). " +
        "The 2 steps of a line come from one preset pool (the line's family); one family per line is preferred (a warning names a line whose steps come from an All pool, which may mix families). The target preset may be in any pool: the pool does not filter recipe lines (a Dimmer + Colour preset in the Dimmer pool cooks both). " +
        "Checked first, nothing sent otherwise: the slot is free, the groups, shapes, presets and MAtricks exist, the Edit Recipe mode is off with an empty Part Zero, no dialog is open, the programmer is empty (read completely), RecipeStoreMode is Normal. " +
        "Line 1: an empty Store of the preset (it clears the pending Edit Recipe target, so \"Update last object?\" does not open), EditRecipe queued without blocking the bridge (if \"Update last object?\" opens anyway it is answered Cancel, never OK, and the call stops), Group / At Shape / Step / At Preset / MAtricks one command at a time with the line checked in Part Zero, Store /Merge, the mode switched off and read back, ClearAll (line 1 runs on stage from At Shape until then). A failure up to here switches the mode off, clears the programmer and deletes the preset this call created. " +
        "Then the name; lines 2+ as copies of line 1 (Copy, then Assign of their group, shape, MAtricks and step presets; what they do not set is line 1's); SPEEDX / PHASEFROMX / PHASETOX per line; curves (Set ... Property \"Curve\"); Cook /MergeLowPriority. " +
        "Read back: the line count, each line's group and MAtricks, every value cooked and integrating one line's 2 step presets, each line's speed and curves in the cooked steps, nothing uncooked, mode off, programmer and Part Zero empty. " +
        "The preset then stays the pending Edit Recipe target: a manual EditRecipe elsewhere opens \"Update last object?\" (never OK). Never Store an empty programmer into an existing phaser preset: that wipes its lines. " +
        "The cue calls the preset with a standard line (gma3_store_recipe_cues); a cue line's Speed X replaces the preset's speed. " +
        "Editing an existing phaser preset, without the programmer or the Edit Recipe mode (no exclusive needed): action set changes line `line` (default 1): selection, shape, matricks, speed_bpm, phase, steps [{preset?, curve?}, {preset?, curve?}] ({} keeps a step), name; " +
        "add_line appends a copy of line 1 retargeted with the given fields (selection and steps required; shape, MAtricks, speed and phase otherwise line 1's; steps without a curve are reset to the shape's); remove_line deletes line `line` (the later lines move up; never the only line). " +
        "Checked first: the preset and line exist, the line is a PhaserRecipe of 2 steps from presets, the 2 steps from one pool, no other line with the same 2 step presets, the references exist, no dialog, the Edit Recipe mode off. " +
        "Sent: Assign Group / Shape / MAtricks At the line, Assign Preset At each step, the curves after the shape (a new shape recomputes curves that are not custom), SPEEDX / PHASEFROMX / PHASETOX, Cook /MergeLowPriority. " +
        "Read back: the edited line as asked, every other line (group, MAtricks, shape, speed, phase, step presets and curves) and its cooked values unchanged, the edited line's values cooked at its speed, the old step presets' values gone. Cues calling the preset follow it without a re-cook (a cue line's own Speed X still replaces the speed). " +
        "preview: true runs the checks and returns the plan. Needs bridge 0.52.1.",
      inputSchema: {
        action: z.enum(["create", "set", "add_line", "remove_line"]),
        preset: z.string().describe('Target preset "P.N": create: a free slot in any pool (the pool does not filter recipe lines); set / add_line / remove_line: an existing phaser preset.'),
        line: z.number().optional().describe("set / remove_line: the line number (default 1)."),
        name: z.string().optional().describe("Preset name (otherwise the console names it after the lines)."),
        lines: z.array(z.object(lineShape)).optional().describe("Several lines (1-8), instead of the one-line fields below."),
        selection: lineShape.selection.optional(),
        shape: lineShape.shape,
        steps: lineShape.steps.optional().describe("Exactly 2 steps. create / add_line: both presets, from one preset pool. set: {} keeps a step."),
        matricks: lineShape.matricks,
        speed_bpm: lineShape.speed_bpm,
        phase: lineShape.phase,
        exclusive: z.boolean().optional().describe("create: required (true) unless preview: nobody else uses the programmer or the Edit Recipe mode meanwhile. Not used by the edit actions."),
        preview: z.boolean().optional(),
      },
    },
    async (args) => operation(() => ((args as CreateArgs).action === "create" ? createPhaserRecipe(ctx, args as CreateArgs) : editPhaserRecipe(ctx, args as EditArgs))),
  );
};
