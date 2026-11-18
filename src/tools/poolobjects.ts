/**
 * Issue #141: gma3_pool_objects, copy, move, delete and rename pool objects with checks.
 *
 *   gma3_pool_objects  one action per item (copy | move | delete | rename) on a group, sequence, macro, MAtricks,
 *                      timecode, layout or preset; a batch form takes a list of items
 *
 * Field evidence: show rebuilds (the Halloween 2026 Creative slot rebuild, 2026-10-29) fell back to gma3_command with
 * Delete, Copy and Move lines: nothing checked that the destination was free, that a deleted object was unused, or
 * that the command did what it said.
 *
 * Built on existing bridge ops only (no bridge change): `objects` (existence, Name, Lock, References, the child count
 * of the summary), `children` (the pool's names, for the name check of poolnames.ts, and the executor scan of
 * playback.ts), `object` (whether a sequence is running) and `cmd`.
 *
 * Console facts (grandMA3 2.5 manual, keyword pages Copy, Move, Delete, Label):
 *   - Copy [Object] n At m takes /Merge, /Overwrite and /NoConfirmation. Without /NoConfirmation an occupied
 *     destination asks; the tool refuses an occupied destination unless on_taken says merge or overwrite.
 *   - Move [Object] n At m: "If the destination is already occupied, the object will be moved to the target object.
 *     The previous target object will be moved to the next object until an empty object will be occupied": a move onto
 *     an occupied slot renumbers a chain of objects, so the tool only moves into an empty slot.
 *   - Delete [Object] n takes /NoConfirmation. Label [Object] n "Name" renames.
 *   - Deleting a preset that cue data references turns those values into plain values and leaves no reference
 *     (docs/probes/cue-part-data-macos-2.5.1.md): a delete of a used object loses information silently, which is why a
 *     delete is refused while the object is in use.
 *   - A preset's References property is text "<handle int>:<count>,..." of the objects that use it
 *     (docs/probes/sb-03-presets-macos-2.5.1.md). Whether groups, sequences, macros, MAtricks, timecodes and layouts
 *     carry the same property is not probed: when it cannot be read, a delete cannot rule out a use and is refused
 *     unless force: true.
 *   - A pool keeps names unique for presets ("Orange#2", #102); copying without a new name may leave the copy with a
 *     "#2" name, which the read-back accepts and reports.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import { asRead, buildResult, commandStep, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, describe, objectName, quoteName } from "../validate.js";
import { readObjects } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { dataPoolShape, inDataPool } from "./datapool.js";
import { findReferencesWhere, lockState } from "./playback.js";
import { ON_NAME_TAKEN, checkPoolName, nameOrSuffixed, type NamePool, type OnNameTaken, type PoolNameCache } from "./poolnames.js";

export const POOL_ACTIONS = ["copy", "move", "delete", "rename"] as const;
export type PoolAction = (typeof POOL_ACTIONS)[number];
export const ON_TAKEN = ["refuse", "overwrite", "merge"] as const;
export type OnTaken = (typeof ON_TAKEN)[number];

const MAX_NUMBER = 9999;

interface PoolKind {
  keyword: string;
  /** The listing reference of the pool, for the name check. */
  listRef: (presetPool?: number) => string;
  noun: string;
  plural: string;
  /** Classes an object of this pool reads (GetClass). */
  classes: readonly string[];
  /** What a use means, for the refusal of a delete. */
  useNote: string;
}

const KINDS: Record<string, PoolKind> = {
  group: { keyword: "Group", listRef: () => "DataPool.Groups", noun: "group", plural: "groups", classes: ["Group"], useNote: "recipe lines and executors that use it lose their selection" },
  sequence: { keyword: "Sequence", listRef: () => "DataPool.Sequences", noun: "sequence", plural: "sequences", classes: ["Sequence"], useNote: "its executors are left empty and its cues are gone" },
  macro: { keyword: "Macro", listRef: () => "DataPool.Macros", noun: "macro", plural: "macros", classes: ["Macro"], useNote: "executors, cue commands and macros that call it stop working" },
  matricks: { keyword: "MAtricks", listRef: () => "DataPool.MAtricks", noun: "MAtricks", plural: "MAtricks", classes: ["MAtrick", "MAtricks"], useNote: "recipe lines that use it lose their MAtricks" },
  timecode: { keyword: "Timecode", listRef: () => "DataPool.Timecodes", noun: "timecode", plural: "timecodes", classes: ["Timecode"], useNote: "executors that play it are left empty" },
  layout: { keyword: "Layout", listRef: () => "DataPool.Layouts", noun: "layout", plural: "layouts", classes: ["Layout"], useNote: "views that show it are left empty" },
  preset: {
    keyword: "Preset",
    listRef: (p) => `Preset ${p}`,
    noun: "preset",
    plural: "presets",
    classes: ["Preset"],
    useNote: "cue values and presets that reference it keep their values as plain values without the reference (onPC 2.5.1), and recipe lines lose their values",
  },
};

const ALIASES: Record<string, string> = { group: "group", sequence: "sequence", seq: "sequence", macro: "macro", matricks: "matricks", timecode: "timecode", layout: "layout", preset: "preset" };

/** Objects this tool refuses, with the tool to use instead. */
const ELSEWHERE: Record<string, string> = {
  tag: "tags have their own tools: gma3_store_tag (rename) and gma3_delete_tag",
  cue: "cues: gma3_delete_cue, gma3_store_cues, gma3_edit_cues",
  fixture: "fixtures are patched: gma3_patch_set, gma3_patch_remove",
  plugin: "plugins are not handled by this tool",
  page: "executors and pages: gma3_assign_to_executor",
  executor: "executors and pages: gma3_assign_to_executor",
};

export interface PoolObject {
  kind: string;
  keyword: string;
  /** The preset pool, for presets. */
  pool?: number;
  no: number;
  /** "Group 5", "Preset 4.12". */
  ref: string;
}

const refOf = (kind: string, no: number, pool?: number): string => (pool !== undefined ? `${KINDS[kind].keyword} ${pool}.${no}` : `${KINDS[kind].keyword} ${no}`);

function poolNumber(field: string, text: string, what: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new ValidationError(`${field}: the ${what} must be a number from 1 to ${MAX_NUMBER}`, field);
  return n;
}

/** "Group 5", "Sequence 3", "Seq 3", "Macro 12", "MAtricks 2", "Timecode 1", "Layout 4", "Preset 4.12". */
export function parsePoolObject(field: string, value: unknown): PoolObject {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field} must be a pool object such as "Group 5", "Sequence 3", "Macro 12" or "Preset 4.12" (got ${describe(value)})`, field);
  const s = value.trim().replace(/\s+/g, " ");
  if (/\b(thru|through)\b|[+]/i.test(s)) throw new ValidationError(`${field}: one object per item (got ${JSON.stringify(s)}); give several items in objects for several objects`, field);
  const m = s.match(/^([A-Za-z]+) (\d+)(?:\.(\d+))?$/);
  if (!m) throw new ValidationError(`${field} must be a pool object such as "Group 5", "Sequence 3", "Macro 12" or "Preset 4.12" (got ${JSON.stringify(s)})`, field);
  const word = m[1].toLowerCase();
  const kind = ALIASES[word];
  if (!kind) {
    const other = ELSEWHERE[word];
    throw new ValidationError(`${field}: ${other ?? `${JSON.stringify(m[1])} is not a pool this tool handles (Group, Sequence, Macro, MAtricks, Timecode, Layout, Preset)`}`, field);
  }
  if (kind === "preset") {
    if (m[3] === undefined) throw new ValidationError(`${field}: a preset is given as "Preset <pool>.<number>", e.g. "Preset 4.12" (got ${JSON.stringify(s)})`, field);
    const pool = poolNumber(field, m[2], "preset pool");
    const no = poolNumber(field, m[3], "preset number");
    return { kind, keyword: "Preset", pool, no, ref: refOf(kind, no, pool) };
  }
  if (m[3] !== undefined) throw new ValidationError(`${field}: ${KINDS[kind].keyword} takes one number (got ${JSON.stringify(s)})`, field);
  const no = poolNumber(field, m[2], `${KINDS[kind].noun} number`);
  return { kind, keyword: KINDS[kind].keyword, no, ref: refOf(kind, no) };
}

/** The destination of a copy or move: a number in the same pool, or for a preset "4.20" (same preset pool). */
export function parseDestination(field: string, value: unknown, src: PoolObject): PoolObject {
  let no: number;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > MAX_NUMBER) throw new ValidationError(`${field} must be a number from 1 to ${MAX_NUMBER} (got ${value})`, field);
    no = value;
  } else if (typeof value === "string" && value.trim()) {
    const parsed = /^\d+$/.test(value.trim()) ? undefined : parsePoolObject(field, /^[A-Za-z]/.test(value.trim()) ? value : `${src.keyword} ${value.trim()}`);
    if (parsed) {
      if (parsed.kind !== src.kind) throw new ValidationError(`${field}: ${src.ref} can only be copied or moved within its own pool (got ${parsed.ref})`, field);
      if (parsed.pool !== src.pool) throw new ValidationError(`${field}: ${src.ref} can only be copied or moved within preset pool ${src.pool} (got ${parsed.ref})`, field);
      no = parsed.no;
    } else no = poolNumber(field, value.trim(), "destination number");
  } else throw new ValidationError(`${field} is required: the destination number in the same pool${src.kind === "preset" ? ` (or "${src.pool}.<number>")` : ""}`, field);
  if (no === src.no) throw new ValidationError(`${field}: the destination is ${src.ref} itself`, field);
  return { ...src, no, ref: refOf(src.kind, no, src.pool) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ObjectState {
  exists: boolean;
  name?: string;
  class?: string;
  addr?: string;
  childCount?: number;
  locked?: boolean | null;
  /** Number of entries of the console's References property; null when it could not be read. */
  references?: number | null;
  referencesError?: string;
}

/** The References text ("<handle int>:<count>,...") as its number of entries, or null when it is not text. */
export function referenceCount(v: unknown): number | null {
  if (typeof v !== "string") return null;
  return v.split(",").filter((x) => x.trim() !== "").length;
}

async function readState(bridge: Gma3Bridge, ref: string, withRefs: boolean): Promise<ObjectState> {
  const fields = withRefs ? ["Name", "Lock", "References"] : ["Name", "Lock"];
  const res = await readObjects(bridge, ref, fields, 1);
  const item = res?.items?.[0];
  if (!item || item.invalid) return { exists: false };
  const f = item.fields ?? {};
  const errs = (item.fieldErrors ?? {}) as Record<string, unknown>;
  const out: ObjectState = {
    exists: true,
    name: typeof f.Name === "string" ? f.Name : item.name,
    class: item.class,
    addr: item.addr,
    childCount: typeof item.childCount === "number" ? item.childCount : undefined,
    locked: errs.Lock !== undefined ? null : lockState(f.Lock),
  };
  if (withRefs) {
    const n = errs.References !== undefined ? null : referenceCount(f.References);
    out.references = n;
    if (n === null) out.referencesError = errs.References !== undefined ? String(errs.References) : "the References property was not returned";
  }
  return out;
}

const present = (s: ObjectState) => ({
  exists: s.exists,
  ...(s.name !== undefined ? { name: s.name } : {}),
  ...(s.childCount !== undefined ? { children: s.childCount } : {}),
  ...(s.locked ? { locked: true } : {}),
});

async function readStep<T>(name: string, op: string, fn: () => Promise<T>): Promise<{ step: StepResult; value?: T }> {
  try {
    const value = await fn();
    return { step: asRead({ name, status: "succeeded", op, detail: value }), value };
  } catch (err) {
    return { step: asRead(stepFromError(name, err, { op })) };
  }
}

const refuse = (name: string, error: string, detail?: unknown): StepResult => asRead({ name, status: "failed", error, ...(detail !== undefined ? { detail } : {}) });

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

export interface PoolObjectArgs {
  action?: unknown;
  object?: unknown;
  to?: unknown;
  name?: unknown;
  on_taken?: unknown;
  on_name_taken?: unknown;
  force?: unknown;
  preview?: unknown;
  verify?: unknown;
  data_pool?: unknown;
}

export async function poolObject(ctx0: ToolContext, raw: PoolObjectArgs): Promise<OperationResult> {
  const v = new Validator();
  const action = v.check(() => {
    if (typeof raw.action !== "string" || !(POOL_ACTIONS as readonly string[]).includes(raw.action)) throw new ValidationError(`action must be one of ${POOL_ACTIONS.join(", ")} (got ${describe(raw.action)})`, "action");
    return raw.action as PoolAction;
  });
  const src = v.check(() => parsePoolObject("object", raw.object));
  const opName = `${action ?? "pool"}_object`;
  const target: Record<string, unknown> = { action: raw.action, object: raw.object, ...(raw.to !== undefined ? { to: raw.to } : {}), ...(raw.data_pool !== undefined ? { dataPool: raw.data_pool } : {}) };
  let dest: PoolObject | undefined;
  let name: string | undefined;
  let onTaken: OnTaken = "refuse";
  if (action && src) {
    if (action === "copy" || action === "move") dest = v.check(() => parseDestination("to", raw.to, src));
    else if (raw.to !== undefined) v.fail(`to is only for copy and move (action ${action})`);
    if (action === "rename") name = v.check(() => objectName("name", raw.name));
    else if (action === "copy") name = v.check(() => objectName("name", raw.name, { optional: true }));
    else if (raw.name !== undefined) v.fail(`name is only for rename and copy (action ${action})`);
    if (raw.on_taken !== undefined) {
      if (action !== "copy") v.fail(`on_taken is only for copy: a move never goes onto an occupied slot (the console would renumber the objects after it)`);
      else if (typeof raw.on_taken !== "string" || !(ON_TAKEN as readonly string[]).includes(raw.on_taken)) v.fail(`on_taken must be one of ${ON_TAKEN.join(", ")} (got ${describe(raw.on_taken)})`);
      else onTaken = raw.on_taken as OnTaken;
    }
    if (raw.force !== undefined && action !== "delete") v.fail("force is only for delete");
  }
  if (raw.force !== undefined && typeof raw.force !== "boolean") v.fail("force must be true or false");
  const onNameTaken: OnNameTaken = raw.on_name_taken === "allow_suffix" ? "allow_suffix" : "refuse";
  if (raw.on_name_taken !== undefined && !(ON_NAME_TAKEN as readonly string[]).includes(String(raw.on_name_taken))) v.fail(`on_name_taken must be one of ${ON_NAME_TAKEN.join(", ")}`);
  let ctx = ctx0;
  try {
    ctx = inDataPool(ctx0, raw);
  } catch (err) {
    v.fail(err instanceof Error ? err.message : String(err));
  }
  if (!v.ok || !action || !src) return validationFailure(opName, target, v.errors);

  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const kind = KINDS[src.kind];
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const force = raw.force === true;
  const warnings: string[] = [];

  const body = async (): Promise<OperationResult> => {
    const steps: StepResult[] = [];
    const done = (extra: Record<string, unknown> = {}, verification?: Verification, summary?: string) => buildResult({ operation: opName, target, steps, warnings, verification, summary, extra });

    // The source: it must exist and be of the pool's class; a delete also reads its References.
    const s = await readStep("read_object", "objects", () => readState(bridge, src.ref, action === "delete"));
    steps.push(s.step);
    const before = s.value;
    if (!before) return done();
    if (!before.exists) {
      steps.push(refuse("check_object", `${src.ref} does not exist; nothing was sent`));
      return done();
    }
    if (before.class && !kind.classes.includes(before.class)) {
      steps.push(refuse("check_object", `${src.ref} reads as a ${before.class}, not a ${kind.noun}; nothing was sent`));
      return done({ object: present(before) });
    }
    if (action !== "copy") {
      if (before.locked === null || before.locked === undefined) {
        steps.push(refuse("check_lock", `the Lock of ${src.ref} could not be read; nothing was sent`));
        return done({ object: present(before) });
      }
      if (before.locked) {
        steps.push(refuse("check_lock", `${src.ref} is locked: the console answers "Object locked" to ${action === "rename" ? "a rename (or ignores it)" : `a ${action}`}. Unlock it first if it may be changed; nothing was sent`));
        return done({ object: present(before) });
      }
    }

    // The destination of a copy or move.
    let destBefore: ObjectState | undefined;
    if (dest) {
      const d = await readStep("read_destination", "objects", () => readState(bridge, dest!.ref, false));
      steps.push(d.step);
      if (!d.value) return done({ object: present(before) });
      destBefore = d.value;
      if (destBefore.exists) {
        const held = `${dest.ref} is taken${destBefore.name ? ` ("${destBefore.name}")` : ""}`;
        if (action === "move") {
          steps.push(refuse("check_destination", `${held}: Move onto an occupied slot moves that object on to the next number, and so on until a free one, renumbering every object in between. Move into a free number (gma3_pool_usage free finds one); nothing was sent`));
          return done({ object: present(before), destination: present(destBefore) });
        }
        if (onTaken === "refuse") {
          steps.push(refuse("check_destination", `${held}; pass on_taken "overwrite" to replace it or "merge" to merge into it; nothing was sent`));
          return done({ object: present(before), destination: present(destBefore) });
        }
        if (destBefore.locked !== false) {
          steps.push(refuse("check_destination", destBefore.locked ? `${dest.ref} is locked; nothing was sent` : `the Lock of ${dest.ref} could not be read; nothing was sent`));
          return done({ object: present(before), destination: present(destBefore) });
        }
        warnings.push(`${dest.ref} ("${destBefore.name ?? ""}") is ${onTaken === "overwrite" ? "overwritten" : "merged into"} (on_taken "${onTaken}")`);
      } else if (onTaken !== "refuse") warnings.push(`${dest.ref} is free, so on_taken "${onTaken}" has nothing to ${onTaken === "overwrite" ? "overwrite" : "merge into"}`);
      steps.push(asRead({ name: "check_destination", status: "succeeded", detail: { taken: destBefore.exists } }));
    }

    // The new name: not another object's of the pool.
    if (name !== undefined) {
      if (action === "rename" && before.name === name) {
        steps.push(asRead({ name: "check_name", status: "succeeded", detail: { unchanged: true } }));
        return done({ object: present(before) }, { status: "matched", checked: `${src.ref} is already named "${name}"` }, `${src.ref} is already named "${name}"; nothing was sent.`);
      }
      const pool: NamePool = { ref: kind.listRef(src.pool), noun: kind.noun, plural: kind.plural, label: (no) => refOf(src.kind, no, src.pool) };
      const cache: PoolNameCache<string> = new Map();
      const r = await checkPoolName({ bridge, t, pool, cache, number: action === "copy" ? dest!.no : src.no, name, onNameTaken, warnings });
      steps.push(asRead({ name: "check_name", status: r.status, op: "children", detail: r.detail, ...(r.error ? { error: r.error } : {}) }));
      if (r.status !== "succeeded") return done({ object: present(before) });
    }

    // A delete: refused while the object is in use, unless force.
    let usage: Record<string, unknown> | undefined;
    if (action === "delete") {
      const uses: string[] = [];
      const unknowns: string[] = [];
      const ex = await findReferencesWhere(bridge, (a) => a === before.addr, t, { failClosed: true });
      const execs = ex.executors.map((e) => e.ref);
      if (!before.addr) unknowns.push(`${src.ref} has no readable address, so the executors that hold it cannot be found`);
      else if (!ex.complete) unknowns.push(`the executor scan was incomplete (${ex.error ?? "unknown reason"})`);
      if (execs.length) uses.push(`it is assigned to executor(s) ${execs.join(", ")}`);
      if (before.references === null || before.references === undefined) unknowns.push(`the console's reference list (References) of ${src.ref} could not be read (${before.referencesError ?? "not returned"}), so a use by cues, recipes, MAtricks or other objects cannot be ruled out`);
      else if (before.references > 0) uses.push(`the console lists ${before.references} object(s) that reference it (its References property)`);
      let running: boolean | null = null;
      if (src.kind === "sequence") {
        try {
          const o = (await bridge.request("object", { ref: src.ref, properties: false }, t)) as { hasActivePlayback?: unknown } | null;
          running = typeof o?.hasActivePlayback === "boolean" ? o.hasActivePlayback : null;
        } catch {
          running = null;
        }
        if (running) uses.push("it is running");
        else if (running === null) unknowns.push(`whether ${src.ref} is running could not be read`);
      }
      usage = { executors: execs, references: before.references ?? null, ...(src.kind === "sequence" ? { running } : {}), executorScanComplete: ex.complete };
      const problems = [...uses, ...unknowns];
      if (problems.length && !force) {
        steps.push(refuse("check_usage", `${src.ref} ${uses.length ? "is in use" : "may be in use"}: ${problems.join("; ")}. Deleting it means ${kind.useNote}. Pass force: true to delete it anyway; nothing was sent`, usage));
        return done({ object: present(before), usage });
      }
      if (problems.length) warnings.push(`deleted with force: ${problems.join("; ")}`);
      steps.push(asRead({ name: "check_usage", status: "succeeded", op: "children", detail: usage }));
    }
    if (action === "move" || action === "delete" || action === "rename") warnings.push(`commands that name ${src.ref} by ${action === "rename" ? "its old name" : "number"} (macro lines, cue commands, other command text) are not changed`);

    // The commands.
    const commands: Array<{ name: string; command: string }> = [];
    if (action === "copy") {
      const mode = destBefore?.exists ? (onTaken === "overwrite" ? " /Overwrite" : " /Merge") : "";
      commands.push({ name: "copy", command: `Copy ${src.ref} At ${dest!.ref}${mode} /NoConfirmation` });
      if (name !== undefined) commands.push({ name: "label", command: `Label ${dest!.ref} ${quoteName(name)}` });
    } else if (action === "move") commands.push({ name: "move", command: `Move ${src.ref} At ${dest!.ref}` });
    else if (action === "delete") commands.push({ name: "delete", command: `Delete ${src.ref} /NoConfirmation` });
    else commands.push({ name: "label", command: `Label ${src.ref} ${quoteName(name!)}` });

    const extra: Record<string, unknown> = { object: present(before), ...(destBefore ? { destination: present(destBefore) } : {}), ...(usage ? { usage } : {}) };
    if (preview) {
      return done({ ...extra, preview: true, plan: commands.map((c) => bridge.sentCommand?.(c.command) ?? c.command) }, undefined, `Preview only; nothing was sent (${commands.length} command(s) planned).`);
    }
    for (const c of commands) {
      const step = await commandStep(bridge, c.name, c.command, t);
      steps.push(step);
      if (step.status !== "succeeded") return done(extra);
    }
    if (!verify) return done(extra);

    // Read back.
    const checks: string[] = [];
    const problems: string[] = [];
    /** `got` is `want`, or with suffixOk the console's "#n" rename of a taken name (reported as a warning). */
    const nameCheck = (ref: string, got: string | undefined, want: string, suffixOk: boolean) => {
      if (got === want) return;
      if (suffixOk && got && nameOrSuffixed(got, want)) {
        warnings.push(`${ref} was named "${got}": the pool already had "${want}"`);
        return;
      }
      problems.push(`${ref} reads the name "${got ?? ""}", not "${want}"`);
    };
    let unavailable: string | undefined;
    try {
      if (action === "delete") {
        const after = await readState(bridge, src.ref, false);
        checks.push(`${src.ref} is gone`);
        if (after.exists) problems.push(`${src.ref} still exists${after.name ? ` ("${after.name}")` : ""}`);
        extra.after = present(after);
      } else if (action === "rename") {
        const after = await readState(bridge, src.ref, false);
        checks.push(`${src.ref} is named "${name}"${onNameTaken === "allow_suffix" ? " (or a \"#n\" suffix of it, on_name_taken allow_suffix)" : ""}`);
        if (!after.exists) problems.push(`${src.ref} no longer exists`);
        else nameCheck(src.ref, after.name, name!, onNameTaken === "allow_suffix");
        extra.after = present(after);
      } else {
        const atDest = await readState(bridge, dest!.ref, false);
        const atSrc = await readState(bridge, src.ref, false);
        extra.after = { [dest!.ref]: present(atDest), [src.ref]: present(atSrc) };
        // Only a merge keeps the destination's own name; a copy into a free number or an overwrite carries the source's
        // name (a "#n" suffix the console gave a duplicate is accepted), and a move keeps it exactly (#155 review).
        const keepsOwnName = action === "copy" && destBefore?.exists === true && onTaken === "merge" && name === undefined;
        const wantName = name ?? (keepsOwnName ? undefined : before.name);
        checks.push(`${dest!.ref} exists${wantName ? ` named "${wantName}"` : keepsOwnName ? " (a merge keeps its name)" : ""}`);
        if (!atDest.exists) problems.push(`${dest!.ref} does not exist`);
        else if (name !== undefined) nameCheck(dest!.ref, atDest.name, name, onNameTaken === "allow_suffix");
        else if (wantName) {
          nameCheck(dest!.ref, atDest.name, wantName, action === "copy");
          if (action === "copy" && atDest.name === wantName) warnings.push(`${dest!.ref} has the same name as ${src.ref} ("${wantName}"): two ${kind.plural} under one name make a lookup by name ambiguous; give name for the copy, or rename it`);
        }
        const mergeOrKeep = action === "copy" && destBefore?.exists && onTaken === "merge";
        if (atDest.exists && !mergeOrKeep && before.childCount !== undefined && atDest.childCount !== undefined) {
          checks.push(`${dest!.ref} holds ${before.childCount} child object(s) like ${src.ref}`);
          if (atDest.childCount !== before.childCount) problems.push(`${dest!.ref} holds ${atDest.childCount} child object(s), ${src.ref} held ${before.childCount}`);
        }
        if (action === "move") {
          checks.push(`${src.ref} is free`);
          if (atSrc.exists) problems.push(`${src.ref} still exists${atSrc.name ? ` ("${atSrc.name}")` : ""}`);
        } else {
          checks.push(`${src.ref} is unchanged`);
          if (!atSrc.exists) problems.push(`${src.ref} no longer exists`);
          else if (atSrc.name !== before.name) problems.push(`${src.ref} now reads the name "${atSrc.name ?? ""}"`);
        }
      }
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "objects" }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "objects" })));
      unavailable = err instanceof Error ? err.message : String(err);
    }
    const checked = checks.join("; ");
    const verification: Verification = unavailable !== undefined ? { status: "unavailable", checked, detail: unavailable } : problems.length ? { status: "mismatched", checked, detail: problems.join("; ") } : { status: "matched", checked };
    return done(extra, verification);
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const DESCRIPTION =
  'Copy, move, delete or rename a pool object: a group, sequence, macro, MAtricks, timecode, layout or preset ("Group 5", "Sequence 3", "Macro 12", "MAtricks 2", "Timecode 1", "Layout 4", "Preset 4.12"). Every action reads the object first and refuses (nothing sent) when it is missing or locked. ' +
  'copy: Copy <object> At <to> /NoConfirmation into the same pool; an occupied destination is refused unless on_taken is "overwrite" or "merge"; name labels the copy. ' +
  "move: Move <object> At <to>, only into a free number (the console would push an occupant and every object after it on). " +
  "delete: Delete <object> /NoConfirmation, refused while it is in use: assigned to an executor (every page is scanned), referenced by other objects (the console's References list: cues, recipes, MAtricks, ...), or running (a sequence); a reference list that cannot be read also refuses; force: true deletes anyway and lists the uses as warnings. Deleting a used preset turns cue values that referenced it into plain values. " +
  'rename: Label <object> "name". A new name another object of the pool has is refused (on_name_taken "allow_suffix" stores it anyway). ' +
  "Read back: the destination exists with the name and child count of the source (a move leaves the source free, a copy leaves it unchanged), a deleted slot is empty, a rename reads the new name. Commands that name the object by number or old name are not changed. preview: true reads and returns the commands without sending them. Ranges are refused: use the batch form. Tags, cues and fixtures have their own tools. " +
  BATCH_NOTE;

const objectShape = {
  action: z.enum(POOL_ACTIONS).optional(),
  object: z.string(),
  to: z.union([z.number().int(), z.string()]).optional(),
  name: z.string().optional(),
  on_taken: z.enum(ON_TAKEN).optional(),
  on_name_taken: z.enum(ON_NAME_TAKEN).optional(),
  force: z.boolean().optional(),
};

export const registerPoolObjectTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_pool_objects",
    {
      title: "Copy, move, delete or rename pool objects",
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(POOL_ACTIONS).optional().describe("copy, move, delete or rename. Required (in the batch form it may be given once for all items)."),
        object: z.string().optional().describe('The object: "Group 5", "Sequence 3", "Macro 12", "MAtricks 2", "Timecode 1", "Layout 4", "Preset 4.12". Required unless objects is given.'),
        to: z.union([z.number().int(), z.string()]).optional().describe('copy and move: the destination number in the same pool (a preset also as "4.20", same preset pool).'),
        name: z.string().optional().describe("rename: the new name (required). copy: a name for the copy (default: the source's name)."),
        on_taken: z.enum(ON_TAKEN).optional().describe('copy onto an occupied destination: "refuse" (default), "overwrite" (/Overwrite) or "merge" (/Merge).'),
        on_name_taken: z.enum(ON_NAME_TAKEN).optional().describe('A name another object of the pool has: "refuse" (default) or "allow_suffix".'),
        force: z.boolean().optional().describe("delete: delete even when the object is (or may be) in use; the uses are listed as warnings."),
        preview: z.boolean().optional().describe("Read and plan only; nothing is sent."),
        verify: z.boolean().optional().describe("Read back (default true)."),
        ...dataPoolShape,
        objects: z.array(z.object(objectShape)).optional().describe("Batch form: several items, each {action?, object, to?, name?, on_taken?, on_name_taken?, force?}."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).objects !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "pool_objects",
              listKey: "objects",
              identityKeys: ["object", "to", "name"],
              label: (it) => `${String(it.action ?? "?")} ${String(it.object)}${it.to !== undefined ? ` At ${String(it.to)}` : ""}`,
              key: (it) => canonicalRef(it.object),
              keys: destinationKeys,
              check: batchCheck,
              run: (it, c) => poolObject(c, it as PoolObjectArgs),
            })
          : poolObject(ctx, args as PoolObjectArgs),
      ),
  );
};

/** The object an item names, canonical ("Seq 05" and "Sequence 5" are one object); the raw text when it does not parse. */
export function canonicalRef(object: unknown): string {
  try {
    return parsePoolObject("object", object).ref.toLowerCase();
  } catch {
    return String(object).trim().replace(/\s+/g, " ").toLowerCase();
  }
}

/** A copy's or move's destination (canonical), tracked like the source: a later item on it is skipped once the copy or move failed. */
export function destinationKeys(it: Record<string, unknown>): string[] {
  if ((it.action !== "copy" && it.action !== "move") || it.to === undefined) return [];
  try {
    return [parseDestination("to", it.to, parsePoolObject("object", it.object)).ref.toLowerCase()];
  } catch {
    return [];
  }
}

/** Across items: one delete or move per object, and one copy or move per destination (canonical references). */
export function batchCheck(items: Array<Record<string, unknown>>): string[] {
  const changing = items.filter((it) => it.action === "delete" || it.action === "move").map((it) => canonicalRef(it.object));
  const dests = items
    .filter((it) => (it.action === "copy" || it.action === "move") && it.to !== undefined)
    .map((it) => {
      try {
        return parseDestination("to", it.to, parsePoolObject("object", it.object)).ref.toLowerCase();
      } catch {
        return undefined;
      }
    })
    .filter((x): x is string => x !== undefined);
  return [
    ...duplicates(changing).map((x) => `${x} is deleted or moved by more than one item`),
    ...duplicates(dests).map((x) => `${x} is the destination of more than one item`),
  ];
}
