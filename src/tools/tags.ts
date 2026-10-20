/**
 * SU-21: tags (SETUP.md SU-21, docs/probes/su-21-tags-macos-2.5.1.md), through the bridge's tags / tags.of /
 * tags.protect ops (0.36.0) and the command line.
 *
 *   gma3_tags            read the tag pool (filtered and paged): each tag's settings and the objects that carry it
 *                        (reverse lookup), or the tags given objects carry
 *   gma3_store_tag       create or rename tags
 *   gma3_delete_tag      delete tags, reporting the objects each was removed from and re-reading them
 *   gma3_assign_tag      Assign [Off] Tag n At <objects> (data_pool for another data pool), with protect per reference,
 *                        read back on every object
 *   gma3_configure_tag   type (kill), Forward Commands, pool action, appearance and note, checked and read back
 *   tagPlayback          gma3_playback on a tag target: the tag's sequences resolved first, each read back
 *
 * Console facts (onPC 2.5.1, the probe and the implementation probe of 2026-10-19):
 *   - The pool is show-wide (ShowData().Tags), sparse. Commands here always address a tag by number: a name is
 *     resolved first, and a name that more than one tag has is refused.
 *   - Assign Tag with a tag that does not exist (by number or name) answers OK and does nothing, and Store Tag on an
 *     existing tag answers OK and keeps its name: every write checks the tag first and reads back.
 *   - A cue's tag lands on its Part 0 (the cue has no TAGS). Fixtures cannot carry tags (Illegal object).
 *     Assign [Off] Tag n At DataPool 2 Sequence m reaches the sequence of that data pool only.
 *   - Names lose commas; names go through objectName() like every other tool, so a comma is refused before sending.
 *     Names are unique: a name another tag has is stored with "#2" appended, so it is refused before sending.
 *   - Set Tag n Property "TagType" / "Action" answers "Illegal value" / "Not allowed" outside the enums (tag:Set in Lua
 *     ignores the value silently). Appearance is assigned with Assign Appearance a At Tag n and cleared with
 *     Set Tag n Property "Appearance" "".
 *   - Kill Instant: starting a tagged sequence turns the other tagged sequences off at once; Kill Delayed: after the
 *     started cue's in-fade. A reference with Protect keeps running. Go+ Tag n on a kill tag leaves one sequence
 *     running. On a sequence a kill tag has acted on, that tag's TAGS entry holds other text instead of the protect
 *     flag, so the flag reads as unknown there (protect still applies, and can be written).
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import { asRead, buildResult, commandStep, requestStep, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, describe, objectName, safeRef } from "../validate.js";
import { dataPoolShape, inDataPool } from "./datapool.js";
import { FRAME_DELAY_MS, playbackState } from "./livestate.js";

export const NEEDS_BRIDGE = "the console runs an older bridge plugin without the tag ops (bridge 0.36.0); update the plugin";
export const TAG_TYPES = ["None", "Kill Instant", "Kill Delayed"] as const;
/** The TagActionToken enum on 2.5.1: what the tag's pool button does. */
export const TAG_ACTIONS = ["Pool Default", "None", "Go+", "Off", "Toggle", "Flash", "Temp", "Top", "Pause", "List Reference"] as const;
const MAX_TAG = 9999;
/** Objects read back per call (an assignment over a larger range is several calls). */
const MAX_OBJECTS = 1000;
/** References re-read after a delete to prove the tag left them. */
const MAX_DELETE_CHECKS = 200;
/** References read for a delete or a tag playback (pages of 2000). */
const MAX_REFS = 10000;
const KILL_NOTE =
  "Kill Instant turns the other tagged sequences off when one starts; Kill Delayed does so after the started cue's in-fade; a reference with protect keeps running (live, onPC 2.5.1).";

export interface TagEntry {
  tag?: number;
  name?: string;
  protect?: boolean;
  flagUnreadable?: boolean;
  handle?: string;
  raw?: string;
}

export interface TagObject {
  class?: string;
  name?: string;
  no?: number;
  addr?: string;
  addrNative?: string;
  dataPool?: { no?: number; name?: string };
  sequence?: number;
  cue?: number;
  part?: number;
  macro?: number;
  protect?: boolean;
  flagUnreadable?: boolean;
  tags?: TagEntry[];
  carriesTags?: boolean;
  fromCue?: boolean;
  error?: string;
  before?: boolean;
  changed?: boolean;
}

export interface TagInfo {
  no: number;
  name: string;
  tagType?: string;
  forwardCommands?: boolean;
  action?: string;
  appearance?: { no?: number; name?: string };
  note?: string;
  lock?: boolean;
  count?: number;
  addr?: string;
  tags?: TagEntry[];
  references?: TagObject[];
  referencesTotal?: number;
  referencesOffset?: number;
  referencesIncomplete?: boolean;
  referencesError?: string;
}

export interface TagsRead {
  items: TagInfo[];
  missing: Array<number | string>;
  total: number;
  offset: number;
  incomplete: boolean;
}

const unknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/.test(err.message);
const errText = (err: unknown) => (unknownOp(err) ? NEEDS_BRIDGE : err instanceof Error ? err.message : String(err));

/** A tag given by number (1-9999) or by its exact name. */
export function tagKey(field: string, v: unknown): number | string {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 1 || v > MAX_TAG) throw new ValidationError(`${field} must be a tag number from 1 to ${MAX_TAG} or a tag name (got ${describe(v)})`, field);
    return v;
  }
  if (typeof v === "string") {
    if (v.trim() === "" || v.length > 200 || /["\x00-\x1f\x7f]/.test(v)) throw new ValidationError(`${field} must be a tag name (1-200 characters, no double quote or control characters)`, field);
    return v.trim();
  }
  throw new ValidationError(`${field} must be a tag number or a tag name (got ${describe(v)})`, field);
}

const tagNo = (field: string, v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TAG) throw new ValidationError(`${field} must be a tag number from 1 to ${MAX_TAG} (got ${describe(v)})`, field);
  return v;
};

/** A note: up to 2000 characters, no double quote or control character. "" clears it. */
function noteText(field: string, v: unknown): string {
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string ("" clears the note)`, field);
  if (v.length > 2000) throw new ValidationError(`${field} is longer than 2000 characters`, field);
  if (/["\x00-\x1f\x7f]/.test(v)) throw new ValidationError(`${field} must not contain a double quote or control characters`, field);
  return v;
}

/** Objects to tag, as a command-line reference with numbers ("Sequence 950 Thru 952", "Sequence 950 Cue 1", "Macro 950.1"). */
function targetRef(field: string, v: unknown): string {
  const ref = safeRef(field, v);
  if (ref.includes(";")) throw new ValidationError(`${field} must be one object reference, without ;`, field);
  if (ref.length > 200) throw new ValidationError(`${field} is longer than 200 characters`, field);
  if (/^(fixture|channel|subfixture)\b/i.test(ref)) throw new ValidationError(`${field}: fixtures cannot carry tags (the console answers Illegal object); tag a group, sequence, cue, macro, preset or tag`, field);
  return ref;
}

/** Where an object sits, in command-line form ("Sequence 950 Cue 1 Part 0", "Macro 950.1"). */
export function objectLabel(o: TagObject): string {
  if (o.class === "Part") return `Sequence ${o.sequence} Cue ${o.cue} Part ${o.part}`;
  if (o.class === "Cue") return `Sequence ${o.sequence} Cue ${o.cue}`;
  if (o.class === "MacroLine") return `Macro ${o.macro}.${o.no}`;
  return `${o.class ?? "Object"} ${o.no ?? o.addr ?? "?"}`;
}

/**
 * A reference that reads the object again: its address, or for a part or a macro line the command-line form in its
 * data pool (a part's address holds a negative cue index, "14.14.1.7.950.-1.0", which is not resolved as an address).
 */
export function refOf(o: TagObject): string | undefined {
  if (o.class === "Part" || o.class === "MacroLine") return `${o.dataPool?.no !== undefined ? `DataPool ${o.dataPool.no} ` : ""}${objectLabel(o)}`;
  return o.addr;
}

const entryOut = (e: TagEntry) => (e.tag !== undefined ? { tag: e.tag, name: e.name, protect: e.protect ?? null, ...(e.flagUnreadable ? { protectUnreadable: true } : {}) } : e);
const tagList = (entries: TagEntry[] | undefined) => (entries ?? []).map(entryOut);

/** An object for a result: where it is, its name and data pool, and (optionally) its protect flag or tags. */
function presentObject(o: TagObject, extra: Record<string, unknown> = {}) {
  return {
    object: objectLabel(o),
    class: o.class,
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.dataPool?.name !== undefined ? { dataPool: o.dataPool.name, dataPoolNo: o.dataPool.no } : {}),
    ...(o.addr !== undefined ? { addr: o.addr } : {}),
    ...(o.protect !== undefined ? { protect: o.protect } : o.flagUnreadable ? { protect: null, protectUnreadable: true } : {}),
    ...extra,
  };
}

/** A tag for a result: its settings, and its references when read. */
function presentTag(t: TagInfo) {
  return {
    tag: t.no,
    name: t.name,
    type: t.tagType ?? null,
    forwardCommands: t.forwardCommands ?? null,
    action: t.action ?? null,
    appearance: t.appearance ?? null,
    note: t.note ?? "",
    references: t.referencesTotal ?? t.count ?? null,
    ...(t.tags?.length ? { tags: tagList(t.tags) } : {}),
    ...(t.references ? { objects: t.references.map((r) => presentObject(r)), objectsOffset: t.referencesOffset ?? 0, objectsIncomplete: t.referencesIncomplete === true } : {}),
    ...(t.referencesError ? { referencesError: t.referencesError } : {}),
  };
}

export interface ReadTagsArgs {
  tags?: Array<number | string>;
  from?: number;
  to?: number;
  class?: string;
  references?: boolean;
  offset?: number;
  limit?: number;
  refOffset?: number;
  refLimit?: number;
}

export async function readTags(bridge: Gma3Bridge, args: ReadTagsArgs, t?: number): Promise<TagsRead> {
  const r = (await bridge.request("tags", { ...args }, t)) as Partial<TagsRead>;
  const items = r.items ?? [];
  return { items, missing: r.missing ?? [], total: r.total ?? items.length, offset: r.offset ?? 0, incomplete: r.incomplete === true };
}

/** Every reference of one tag (optionally of one class), page by page; null when the tag does not exist. */
export async function readAllRefs(bridge: Gma3Bridge, no: number, t?: number, cls?: string): Promise<{ tag: TagInfo; refs: TagObject[]; total: number } | null> {
  const refs: TagObject[] = [];
  let tag: TagInfo | undefined;
  let total = 0;
  for (let off = 0; off < MAX_REFS; off += 2000) {
    const r = await readTags(bridge, { tags: [no], refOffset: off, refLimit: 2000, ...(cls ? { class: cls } : {}) }, t);
    tag = r.items[0];
    if (!tag) return null;
    if (tag.referencesError) throw new Error(`Tag ${no}: ${tag.referencesError}`);
    refs.push(...(tag.references ?? []));
    total = tag.referencesTotal ?? refs.length;
    if (!tag.referencesIncomplete) break;
  }
  return { tag: tag!, refs, total };
}

export async function readTagsOf(bridge: Gma3Bridge, ref: string, t?: number): Promise<TagObject[]> {
  const r = (await bridge.request("tags.of", { ref }, t)) as { items?: TagObject[] };
  return r.items ?? [];
}

/**
 * Find one tag by number or exact name. A name is looked up in the whole pool so that two tags with the same name are
 * refused instead of guessed (the console addresses every tag of that name).
 */
export async function findTag(bridge: Gma3Bridge, key: number | string, t?: number): Promise<{ tag?: TagInfo; error?: string }> {
  if (typeof key === "number") {
    const r = await readTags(bridge, { tags: [key], references: false }, t);
    return r.items[0] ? { tag: r.items[0] } : { error: `Tag ${key} does not exist` };
  }
  const all = await readTags(bridge, { references: false, limit: 1000 }, t);
  const hits = all.items.filter((x) => x.name === key);
  if (hits.length === 0) return { error: `no tag is named ${JSON.stringify(key)}` };
  if (hits.length > 1) return { error: `${hits.length} tags are named ${JSON.stringify(key)} (${hits.map((h) => `Tag ${h.no}`).join(", ")}); give the number` };
  return { tag: hits[0] };
}

/** A read step around a bridge read, with the old-bridge hint. */
async function readStepOf<T>(name: string, op: string, fn: () => Promise<T>): Promise<{ step: StepResult; value?: T }> {
  try {
    const value = await fn();
    return { step: asRead({ name, status: "succeeded", op }), value };
  } catch (err) {
    const step = asRead(stepFromError(name, err, { op }));
    if (unknownOp(err)) step.error = `${step.error}: ${NEEDS_BRIDGE}`;
    return { step };
  }
}

const refused = (name: string, error: string): StepResult => asRead({ name, status: "failed", error });

/** The data-pool context of a call, or the reason its data_pool is refused. */
function poolContext(ctx: ToolContext, raw: { data_pool?: unknown }, v: Validator): ToolContext {
  try {
    return inDataPool(ctx, raw);
  } catch (err) {
    v.fail(err instanceof Error ? err.message : String(err));
    return ctx;
  }
}

// ---------------------------------------------------------------------------
// gma3_tags (read-only)
// ---------------------------------------------------------------------------

interface ReadToolArgs {
  tags?: unknown;
  from?: unknown;
  to?: unknown;
  class?: unknown;
  references?: unknown;
  offset?: unknown;
  limit?: unknown;
  references_offset?: unknown;
  references_limit?: unknown;
  of?: unknown;
  data_pool?: unknown;
}

const intIn = (v: Validator, field: string, x: unknown, lo: number, hi: number) => {
  if (x !== undefined && (typeof x !== "number" || !Number.isInteger(x) || x < lo || x > hi)) v.fail(`${field} must be an integer from ${lo} to ${hi}`);
};

export async function readTagsTool(ctx: ToolContext, raw: ReadToolArgs): Promise<unknown> {
  const t = ctx.requestTimeoutMs;
  const v = new Validator();
  let keys: Array<number | string> | undefined;
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.length === 0 || raw.tags.length > 1000) v.fail("tags must list 1-1000 tag numbers or names");
    else keys = raw.tags.map((k, i) => v.check(() => tagKey(`tags[${i}]`, k)) ?? 0);
  }
  intIn(v, "from", raw.from, 1, MAX_TAG);
  intIn(v, "to", raw.to, 1, MAX_TAG);
  intIn(v, "offset", raw.offset, 0, 100000);
  intIn(v, "limit", raw.limit, 1, 1000);
  intIn(v, "references_offset", raw.references_offset, 0, 1000000);
  intIn(v, "references_limit", raw.references_limit, 1, 2000);
  if (raw.class !== undefined && (typeof raw.class !== "string" || !/^[A-Za-z]+$/.test(raw.class))) v.fail("class must be an object class such as Sequence, Group, Macro, MacroLine, Part, Preset or Tag");
  const of = raw.of === undefined ? undefined : v.check(() => safeRef("of", raw.of));
  if (of !== undefined && [keys, raw.from, raw.to, raw.class, raw.offset, raw.limit, raw.references_offset, raw.references_limit].some((x) => x !== undefined)) v.fail("of reads the tags of objects; give it alone (with data_pool)");
  if (of === undefined && raw.data_pool !== undefined) v.fail("data_pool applies to of (the objects); the tag pool is show-wide");
  const c = poolContext(ctx, raw, v);
  if (!v.ok) throw new Error(v.errors.join("; "));
  try {
    if (of !== undefined) {
      const items = await readTagsOf(c.bridge, of, t);
      return {
        of,
        objects: items.map((o) => presentObject(o, o.error ? { error: o.error } : o.carriesTags === false ? { carriesTags: false } : { tags: tagList(o.tags), ...(o.fromCue ? { fromCue: true } : {}) })),
        note: "A cue's tags are on its Part 0 (Assign Tag ... At Sequence n Cue m puts them there). protect is the reference's Protect flag; protectUnreadable: a kill tag that has acted on the sequence replaced the flag's text (Protect still applies).",
      };
    }
    const r = await readTags(
      c.bridge,
      {
        ...(keys ? { tags: keys } : {}),
        ...(raw.from !== undefined ? { from: raw.from as number } : {}),
        ...(raw.to !== undefined ? { to: raw.to as number } : {}),
        ...(raw.class !== undefined ? { class: raw.class as string } : {}),
        references: raw.references !== false,
        ...(raw.offset !== undefined ? { offset: raw.offset as number } : {}),
        ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}),
        ...(raw.references_offset !== undefined ? { refOffset: raw.references_offset as number } : {}),
        ...(raw.references_limit !== undefined ? { refLimit: raw.references_limit as number } : {}),
      },
      t,
    );
    return {
      total: r.total,
      offset: r.offset,
      count: r.items.length,
      incomplete: r.incomplete,
      tags: r.items.map(presentTag),
      ...(r.missing.length ? { missing: r.missing } : {}),
      ...(raw.class !== undefined ? { class: raw.class } : {}),
      note: `Tags are show-wide (one pool for every data pool). objects lists the objects that carry each tag (tag:GetReferences), one page each (objectsIncomplete: more with references_offset); incomplete: more tags with offset. A cue's tag is on its Part 0. ${KILL_NOTE} Forward Commands decides whether a command on the tag (Go+ Tag n, Off Tag n) reaches the tagged objects.`,
    };
  } catch (err) {
    throw new Error(errText(err));
  }
}

// ---------------------------------------------------------------------------
// gma3_store_tag
// ---------------------------------------------------------------------------

interface StoreArgs {
  tag?: unknown;
  name?: unknown;
  if_exists?: unknown;
  verify?: unknown;
}

export async function storeTag(ctx: ToolContext, raw: StoreArgs): Promise<OperationResult> {
  const v = new Validator();
  const no = v.check(() => tagNo("tag", raw.tag));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const ifExists = raw.if_exists ?? "refuse";
  if (ifExists !== "refuse" && ifExists !== "rename") v.fail("if_exists must be refuse or rename");
  if (ifExists === "rename" && raw.name === undefined) v.fail("if_exists: rename needs a name");
  const target: Record<string, unknown> = { tag: raw.tag, name: raw.name ?? null };
  if (!v.ok || no === undefined) return validationFailure("store_tag", target, v.errors);
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const verify = raw.verify !== false;

  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const pre = await readStepOf("read_tag", "tags", () => readTags(bridge, { tags: [no], references: false }, t));
    steps.push(pre.step);
    if (!pre.value) return buildResult({ operation: "store_tag", target, steps });
    const existing = pre.value.items[0];
    if (name !== undefined && existing?.name !== name) {
      // The console keeps tag names unique: a second "Encore" is stored as "Encore#2" (live 2026-10-19).
      const other = await readStepOf("read_names", "tags", () => findTag(bridge, name, t));
      steps.push(other.step);
      if (!other.value) return buildResult({ operation: "store_tag", target, steps });
      const holder = other.value.tag ?? (/^\d+ tags are named/.test(other.value.error ?? "") ? ({ no: -1 } as TagInfo) : undefined);
      if (holder && holder.no !== no) {
        steps.push(refused("check", `${holder.no > 0 ? `Tag ${holder.no}` : "another tag"} is already named ${JSON.stringify(name)}; the console would store this one as ${JSON.stringify(`${name}#2`)}. Choose another name`));
        return buildResult({ operation: "store_tag", target, steps });
      }
    }
    let action: "create" | "rename" | "none";
    if (existing) {
      if (ifExists !== "rename") {
        steps.push(refused("check", `Tag ${no} exists (${JSON.stringify(existing.name)}, ${existing.count ?? 0} reference(s)); Store would keep it unchanged. Pass if_exists: "rename" to rename it, or choose a free number`));
        return buildResult({ operation: "store_tag", target, steps, extra: { existing: presentTag(existing) } });
      }
      action = existing.name === name ? "none" : "rename";
    } else action = "create";
    if (action === "rename") steps.push(await commandStep(bridge, "label", `Label Tag ${no} "${name}"`, t));
    else if (action === "create") steps.push(await commandStep(bridge, "store", name !== undefined ? `Store Tag ${no} "${name}" /NoConfirmation` : `Store Tag ${no} /NoConfirmation`, t));
    else steps.push(asRead({ name: "label", status: "succeeded", detail: `Tag ${no} is already named ${JSON.stringify(existing!.name)}; nothing sent` }));

    let verification: Verification = { status: "not_requested" };
    let stored: TagInfo | undefined;
    if (verify && steps.at(-1)!.status !== "failed") {
      const checked = name !== undefined ? `Tag ${no} exists, named ${JSON.stringify(name)}` : `Tag ${no} exists`;
      try {
        stored = (await readTags(bridge, { tags: [no], references: false }, t)).items[0];
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "tags" }));
        if (!stored) verification = { status: "mismatched", checked, detail: `Tag ${no} does not exist` };
        else if (name !== undefined && stored.name !== name) verification = { status: "mismatched", checked, actual: stored.name, detail: `Tag ${no} is named ${JSON.stringify(stored.name)}` };
        else verification = { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "tags" })));
        verification = { status: "unavailable", checked, detail: errText(err) };
      }
    }
    return buildResult({
      operation: "store_tag",
      target,
      steps,
      verification,
      extra: { action, tag: no, name: stored?.name ?? name ?? null, ...(existing ? { previousName: existing.name } : {}) },
    });
  });
}

// ---------------------------------------------------------------------------
// gma3_delete_tag
// ---------------------------------------------------------------------------

interface DeleteArgs {
  tag?: unknown;
  verify?: unknown;
}

export async function deleteTag(ctx: ToolContext, raw: DeleteArgs): Promise<OperationResult> {
  const v = new Validator();
  const key = v.check(() => tagKey("tag", raw.tag));
  const target: Record<string, unknown> = { tag: raw.tag };
  if (!v.ok || key === undefined) return validationFailure("delete_tag", target, v.errors);
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const verify = raw.verify !== false;

  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const found = await readStepOf("read_tag", "tags", () => findTag(bridge, key, t));
    steps.push(found.step);
    if (!found.value) return buildResult({ operation: "delete_tag", target, steps });
    if (!found.value.tag) {
      steps.push(refused("check", `${found.value.error}; nothing to delete`));
      return buildResult({ operation: "delete_tag", target, steps });
    }
    const no = found.value.tag.no;
    const before = await readStepOf("read_references", "tags", () => readAllRefs(bridge, no, t));
    steps.push(before.step);
    if (!before.value) return buildResult({ operation: "delete_tag", target, steps });
    const { tag, refs, total } = before.value;
    const cmd = await commandStep(bridge, "delete", `Delete Tag ${no} /NoConfirmation`, t);
    steps.push(cmd);

    let verification: Verification = { status: "not_requested" };
    const after = new Map<number, { carries: boolean | null; error?: string }>();
    if (verify && cmd.status !== "failed") {
      const checked = `Tag ${no} is gone and none of the ${total} object(s) that carried it still lists it`;
      try {
        const gone = (await readTags(bridge, { tags: [no], references: false }, t)).items.length === 0;
        const still: string[] = [];
        for (const [i, r] of refs.slice(0, MAX_DELETE_CHECKS).entries()) {
          const ref = refOf(r);
          if (!ref) continue;
          try {
            const objs = await readTagsOf(bridge, ref, t);
            const carries = objs.some((o) => (o.tags ?? []).some((e) => e.tag === no || e.handle !== undefined));
            after.set(i, { carries });
            if (carries) still.push(objectLabel(r));
          } catch (err) {
            after.set(i, { carries: null, error: errText(err) });
          }
        }
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "tags.of" }));
        const unchecked = refs.length - [...after.values()].filter((x) => x.carries !== null).length + (total - refs.length);
        const problems = [...(gone ? [] : [`Tag ${no} still exists`]), ...(still.length ? [`still listed by ${still.join(", ")}`] : [])];
        verification = problems.length
          ? { status: "mismatched", checked, detail: problems.join("; ") }
          : unchecked > 0
            ? { status: "unavailable", checked, detail: `Tag ${no} is gone; ${total - unchecked} of ${total} former references were re-read` }
            : { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "tags" })));
        verification = { status: "unavailable", checked, detail: errText(err) };
      }
    }
    return buildResult({
      operation: "delete_tag",
      target,
      steps,
      verification,
      extra: {
        deleted: presentTag(tag),
        removedFromCount: total,
        removedFrom: refs.map((r, i) => presentObject(r, after.has(i) ? { stillCarries: after.get(i)!.carries, ...(after.get(i)!.error ? { readError: after.get(i)!.error } : {}) } : {})),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// gma3_assign_tag
// ---------------------------------------------------------------------------

interface AssignArgs {
  tag?: unknown;
  target?: unknown;
  off?: unknown;
  protect?: unknown;
  data_pool?: unknown;
  verify?: unknown;
}

const entryOf = (o: TagObject, no: number) => (o.tags ?? []).find((e) => e.tag === no);

export async function assignTag(base: ToolContext, raw: AssignArgs): Promise<OperationResult> {
  const off = raw.off === true;
  const op = off ? "unassign_tag" : "assign_tag";
  const v = new Validator();
  const key = v.check(() => tagKey("tag", raw.tag));
  const ref = v.check(() => targetRef("target", raw.target));
  if (raw.protect !== undefined && typeof raw.protect !== "boolean") v.fail("protect must be true or false");
  if (off && raw.protect !== undefined) v.fail("protect applies to an assignment, not to off");
  const ctx = poolContext(base, raw, v);
  const protect = raw.protect as boolean | undefined;
  const target: Record<string, unknown> = { tag: raw.tag, target: raw.target, ...(raw.data_pool !== undefined ? { data_pool: raw.data_pool } : {}), ...(off ? { off: true } : {}), ...(protect !== undefined ? { protect } : {}) };
  if (!v.ok || key === undefined || ref === undefined) return validationFailure(op, target, v.errors);
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const verify = raw.verify !== false;

  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const found = await readStepOf("read_tag", "tags", () => findTag(bridge, key, t));
    steps.push(found.step);
    if (!found.value) return buildResult({ operation: op, target, steps });
    const tag = found.value.tag;
    if (!tag) {
      steps.push(refused("check", `${found.value.error}; the console would answer OK to Assign Tag and change nothing. Create it with gma3_store_tag first`));
      return buildResult({ operation: op, target, steps });
    }
    const no = tag.no;
    const pre = await readStepOf("read_objects", "tags.of", () => readTagsOf(bridge, ref, t));
    steps.push(pre.step);
    if (!pre.value) return buildResult({ operation: op, target, steps, extra: { tag: { tag: no, name: tag.name } } });
    const before = pre.value;
    const bad = before.filter((o) => o.error || o.carriesTags === false);
    if (bad.length) {
      steps.push(refused("check", `${bad.map((o) => `${objectLabel(o)} (${o.class}) ${o.error ?? "cannot carry tags"}`).join("; ")}; nothing was sent`));
      return buildResult({ operation: op, target, steps, extra: { tag: { tag: no, name: tag.name } } });
    }
    if (before.length > MAX_OBJECTS) {
      steps.push(refused("check", `${ref} names ${before.length} objects; at most ${MAX_OBJECTS} per call`));
      return buildResult({ operation: op, target, steps });
    }

    steps.push(await commandStep(bridge, off ? "assign_off" : "assign", `Assign ${off ? "Off " : ""}Tag ${no} At ${ref}`, t));
    if (protect !== undefined && steps.at(-1)!.status === "succeeded") {
      const s = await requestStep(
        bridge,
        "protect",
        "tags.protect",
        { ref, tag: no, protect },
        (res) => {
          const r = res as { items?: TagObject[] };
          const errs = (r.items ?? []).filter((o) => o.error);
          return errs.length
            ? { name: "protect", status: "failed", op: "tags.protect", error: errs.map((o) => `${objectLabel(o)}: ${o.error}`).join("; "), detail: r.items }
            : { name: "protect", status: "succeeded", op: "tags.protect", detail: { changed: (r.items ?? []).filter((o) => o.changed).length } };
        },
        t,
      );
      if (s.status === "failed" && /unknown op/.test(s.error ?? "")) s.error = `${s.error}: ${NEEDS_BRIDGE}`;
      steps.push(s);
    }

    let verification: Verification = { status: "not_requested" };
    let after: TagObject[] | undefined;
    if (verify && steps.some((s) => s.op === "cmd" && s.status !== "failed")) {
      const checked = `${off ? "none" : "every one"} of the ${before.length} object(s) lists Tag ${no}${protect !== undefined ? ` with protect ${protect}` : ""}`;
      try {
        after = await readTagsOf(bridge, ref, t);
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "tags.of" }));
        const wrong = after.filter((o) => {
          const e = entryOf(o, no);
          if (off) return e !== undefined;
          return e === undefined || (protect !== undefined && e.protect !== protect);
        });
        verification = wrong.length ? { status: "mismatched", checked, detail: wrong.map((o) => `${objectLabel(o)} reads ${JSON.stringify(tagList(o.tags))}`).join("; ") } : { status: "matched", checked };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "tags.of" })));
        verification = { status: "unavailable", checked, detail: errText(err) };
      }
    }
    const rows = (after ?? before).map((o, i) => {
      const was = entryOf(before[i] ?? {}, no) !== undefined;
      const e = entryOf(o, no);
      return presentObject(o, {
        ...(after ? { carries: e !== undefined, ...(e ? { protect: e.protect ?? null, ...(e.flagUnreadable ? { protectUnreadable: true } : {}) } : {}), changed: was !== (e !== undefined) } : { carried: was }),
        tags: tagList(o.tags),
      });
    });
    const warnings = before.some((o) => o.fromCue) ? ["a cue carries its tags on its Part 0: the objects list the parts"] : [];
    const changed = after ? rows.filter((r) => (r as { changed?: boolean }).changed).length : null;
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings,
      extra: { tag: { tag: no, name: tag.name }, objects: rows, ...(changed !== null ? { changedCount: changed } : {}) },
    });
  });
}

// ---------------------------------------------------------------------------
// gma3_configure_tag
// ---------------------------------------------------------------------------

interface ConfigureArgs {
  tag?: unknown;
  type?: unknown;
  forward_commands?: unknown;
  action?: unknown;
  appearance?: unknown;
  note?: unknown;
  verify?: unknown;
}

export async function configureTag(ctx: ToolContext, raw: ConfigureArgs): Promise<OperationResult> {
  const v = new Validator();
  const key = v.check(() => tagKey("tag", raw.tag));
  const type = raw.type;
  if (type !== undefined && !(TAG_TYPES as readonly unknown[]).includes(type)) v.fail(`type must be one of ${TAG_TYPES.join(", ")} (got ${describe(type)}); the console ignores other values`);
  if (raw.forward_commands !== undefined && typeof raw.forward_commands !== "boolean") v.fail("forward_commands must be true or false");
  if (raw.action !== undefined && !(TAG_ACTIONS as readonly unknown[]).includes(raw.action)) v.fail(`action must be one of ${TAG_ACTIONS.join(", ")} (got ${describe(raw.action)})`);
  if (raw.appearance !== undefined && raw.appearance !== null && (typeof raw.appearance !== "number" || !Number.isInteger(raw.appearance) || raw.appearance < 1 || raw.appearance > 10000)) v.fail("appearance must be an appearance number, or null to clear it");
  const note = raw.note === undefined ? undefined : v.check(() => noteText("note", raw.note));
  const settings = { type, forward_commands: raw.forward_commands, action: raw.action, appearance: raw.appearance, note: raw.note };
  if (Object.values(settings).every((x) => x === undefined)) v.fail("give at least one of type, forward_commands, action, appearance, note");
  const target: Record<string, unknown> = { tag: raw.tag, ...Object.fromEntries(Object.entries(settings).filter(([, x]) => x !== undefined)) };
  if (!v.ok || key === undefined) return validationFailure("configure_tag", target, v.errors);
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const verify = raw.verify !== false;

  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const found = await readStepOf("read_tag", "tags", () => findTag(bridge, key, t));
    steps.push(found.step);
    if (!found.value) return buildResult({ operation: "configure_tag", target, steps });
    const tag = found.value.tag;
    if (!tag) {
      steps.push(refused("check", found.value.error ?? "the tag does not exist"));
      return buildResult({ operation: "configure_tag", target, steps });
    }
    const no = tag.no;
    if (typeof raw.appearance === "number") {
      const a = await readStepOf("read_appearance", "objects", async () => (await bridge.request("objects", { ref: `Appearance ${raw.appearance}`, fields: [], limit: 1 }, t)) as { items?: Array<{ invalid?: boolean }> });
      const missing = (a.step.status === "failed" && /no objects? found/i.test(a.step.error ?? "")) || (a.value !== undefined && (!a.value.items?.length || a.value.items[0].invalid));
      if (missing) {
        steps.push(refused("read_appearance", `Appearance ${raw.appearance} does not exist`));
        return buildResult({ operation: "configure_tag", target, steps });
      }
      steps.push(a.step);
      if (!a.value) return buildResult({ operation: "configure_tag", target, steps });
    }
    const commands: Array<[string, string]> = [];
    const prop = (p: string, val: string) => `Set Tag ${no} Property "${p}" "${val}"`;
    if (type !== undefined) commands.push(["type", prop("TagType", type as string)]);
    if (raw.forward_commands !== undefined) commands.push(["forward_commands", prop("ForwardCommands", raw.forward_commands ? "Yes" : "No")]);
    if (raw.action !== undefined) commands.push(["action", prop("Action", raw.action as string)]);
    if (raw.appearance !== undefined) commands.push(["appearance", raw.appearance === null ? prop("Appearance", "") : `Assign Appearance ${raw.appearance} At Tag ${no}`]);
    if (note !== undefined) commands.push(["note", prop("Note", note)]);
    let sent = 0;
    for (const [name, cmd] of commands) {
      const s = await commandStep(bridge, name, cmd, t);
      steps.push(s);
      sent++;
      if (s.status !== "succeeded") break;
    }
    for (const [name] of commands.slice(sent)) steps.push({ name, status: "skipped", error: "not attempted: an earlier step did not succeed" });

    let verification: Verification = { status: "not_requested" };
    let after: TagInfo | undefined;
    if (verify && steps.some((s) => s.op === "cmd" && s.status !== "failed")) {
      const expected: Record<string, unknown> = {
        ...(type !== undefined ? { type } : {}),
        ...(raw.forward_commands !== undefined ? { forwardCommands: raw.forward_commands } : {}),
        ...(raw.action !== undefined ? { action: raw.action } : {}),
        ...(raw.appearance !== undefined ? { appearance: raw.appearance } : {}),
        ...(note !== undefined ? { note } : {}),
      };
      const checked = `Tag ${no} reads ${JSON.stringify(expected)}`;
      try {
        after = (await readTags(bridge, { tags: [no], references: false }, t)).items[0];
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "tags" }));
        const actual: Record<string, unknown> = after ? { type: after.tagType, forwardCommands: after.forwardCommands, action: after.action, appearance: after.appearance?.no ?? null, note: after.note ?? "" } : {};
        const bad = Object.entries(expected).filter(([k, want]) => actual[k] !== want).map(([k, want]) => `${k}: expected ${JSON.stringify(want)}, read ${JSON.stringify(actual[k] ?? null)}`);
        verification = !after ? { status: "mismatched", checked, detail: `Tag ${no} no longer exists` } : bad.length ? { status: "mismatched", checked, expected, actual, detail: bad.join("; ") } : { status: "matched", checked, expected, actual };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "tags" })));
        verification = { status: "unavailable", checked, detail: errText(err) };
      }
    }
    return buildResult({
      operation: "configure_tag",
      target,
      steps,
      verification,
      extra: { tag: no, name: tag.name, before: presentTag(tag), ...(after ? { after: presentTag(after) } : {}) },
    });
  });
}

// ---------------------------------------------------------------------------
// gma3_playback on a tag
// ---------------------------------------------------------------------------

/** A playback target that is one tag: `Tag 5` or `Tag "Encore"`. */
export function tagTarget(target: string): number | string | undefined {
  const m = target.match(/^\s*Tag\s+(?:(\d+)|"([^"]+)")\s*$/i);
  if (!m) return undefined;
  return m[1] !== undefined ? Number(m[1]) : m[2];
}

/**
 * A playback command on a tag (the caller holds the mutation lock). The tag's sequences are resolved through
 * GetReferences before the command is sent (an unknown tag or name sends nothing), the command addresses the tag by
 * number, and each sequence's state is read a frame later.
 */
export async function tagPlayback(ctx: ToolContext, keyword: string, target: string, fade?: number): Promise<Record<string, unknown>> {
  const key = tagTarget(target);
  if (key === undefined) throw new Error(`${target} is not a tag target (Tag n or Tag "name")`);
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  let found: { tag?: TagInfo; error?: string };
  try {
    found = await findTag(bridge, key, t);
  } catch (err) {
    throw new Error(`${target}: the tag could not be read, nothing was sent: ${errText(err)}`);
  }
  if (!found.tag) throw new Error(`${found.error}; nothing was sent`);
  const all = await readAllRefs(bridge, found.tag.no, t, "Sequence").catch((err: unknown) => {
    throw new Error(`Tag ${found.tag!.no}: its sequences could not be read, nothing was sent: ${errText(err)}`);
  });
  if (!all) throw new Error(`Tag ${found.tag.no} no longer exists; nothing was sent`);
  const command = `${keyword} Tag ${all.tag.no}${fade !== undefined ? ` Fade ${fade}` : ""}`;
  const res = (await bridge.request("cmd", { command }, t)) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, FRAME_DELAY_MS));
  const sequences = [];
  for (const s of all.refs) {
    try {
      const o = (await bridge.request("object", { ref: s.addr ?? objectLabel(s), properties: false }, t)) as Record<string, unknown>;
      sequences.push({ ...presentObject(s), ...playbackState(o) });
    } catch (err) {
      sequences.push({ ...presentObject(s), notRead: errText(err) });
    }
  }
  const warnings = [
    ...(all.tag.forwardCommands === false ? [`Forward Commands is off on Tag ${all.tag.no}: playback commands on the tag do not reach its sequences`] : []),
    ...(all.tag.tagType && all.tag.tagType !== "None" && /^(Go\+|Toggle|On|Top|Load)$/i.test(keyword) ? [`Tag ${all.tag.no} is ${all.tag.tagType}: starting its sequences together leaves only one running (the kill turns the others off)`] : []),
    ...(all.total > all.refs.length ? [`only the first ${all.refs.length} of ${all.total} sequences were read back`] : []),
    ...(all.total === 0 ? [`Tag ${all.tag.no} is on no sequence`] : []),
  ];
  return {
    ...res,
    playbackState: {
      target,
      tag: { tag: all.tag.no, name: all.tag.name, type: all.tag.tagType ?? null, forwardCommands: all.tag.forwardCommands ?? null },
      sequences,
      readAfterMs: FRAME_DELAY_MS,
    },
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const tagKeySchema = z.union([z.number(), z.string()]);

export const registerTagTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_tags",
    {
      title: "Read tags and the objects that carry them",
      description:
        "Read-only. The show's tags (one show-wide pool): number, name, type (None / Kill Instant / Kill Delayed), Forward Commands, pool action, appearance, note, reference count, and the objects that carry each tag (class, name, data pool, address, protect), from the console's reverse lookup. " +
        'Answers "which sequences are tagged Encore" in one call: tags: ["Encore"], class: "Sequence". Tags are paged (offset/limit, default 100) and so are each tag\'s objects (references_offset/references_limit, default 200), with totals and incomplete flags. ' +
        "With of: \"<objects>\" it reads the tags given objects carry instead (a cue's tags are on its Part 0). gma3_get_object, gma3_objects and gma3_list_children also return an object's TAGS as [{tag, name, protect}]. Needs bridge 0.36.0.",
      inputSchema: {
        tags: z.array(tagKeySchema).optional().describe("Tags to read, by number or exact name (default every tag)."),
        from: z.number().int().optional().describe("Lowest tag number to read."),
        to: z.number().int().optional().describe("Highest tag number to read."),
        class: z.string().optional().describe("Only objects of this class: Sequence, Group, Macro, MacroLine, Part (a cue), Preset, Tag."),
        references: z.boolean().optional().describe("List the objects that carry each tag (default true)."),
        offset: z.number().int().optional().describe("Tags to skip (paging; default 0)."),
        limit: z.number().int().optional().describe("Tags per page (default 100, at most 1000)."),
        references_offset: z.number().int().optional().describe("Objects to skip in each tag's list (default 0)."),
        references_limit: z.number().int().optional().describe("Objects per tag (default 200, at most 2000)."),
        of: z.string().optional().describe('Read the tags these objects carry instead ("Sequence 1 Thru 10", "Sequence 5 Cue 2", "Macro 3.1").'),
        ...dataPoolShape,
      },
    },
    async (args) => {
      try {
        return json(await readTagsTool(ctx, args as ReadToolArgs));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_store_tag",
    {
      title: "Create or rename tags",
      description:
        'Create a tag (Store Tag n "name") or rename it (if_exists: "rename"), then read it back. An existing number is refused unless if_exists is rename (Store on an existing tag changes nothing). ' +
        "Names follow the rules of every object name: characters the console removes (a comma among them) are refused before anything is sent. Tags are show-wide. Delete with gma3_delete_tag. Needs bridge 0.36.0. " +
        BATCH_NOTE,
      inputSchema: {
        tag: z.number().int().optional().describe("Tag number (1-9999). Required unless tags is given."),
        name: z.string().optional().describe("The name."),
        if_exists: z.enum(["refuse", "rename"]).optional().describe("When the number holds a tag: refuse (default) or rename it to name."),
        verify: z.boolean().optional().describe("Read back (default true)."),
        tags: z
          .array(z.object({ tag: z.number().int(), name: z.string().optional(), if_exists: z.enum(["refuse", "rename"]).optional() }))
          .optional()
          .describe("Batch form: several tags, each {tag, name}."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).tags !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "store_tag",
              listKey: "tags",
              identityKeys: ["tag", "name"],
              label: (it) => `Tag ${String(it.tag)}`,
              key: (it) => `Tag ${String(it.tag)}`,
              check: (items) => duplicates(items.map((it) => String(it.tag))).map((x) => `Tag ${x} appears more than once in tags`),
              run: (it, c) => storeTag(c, it as StoreArgs),
            })
          : storeTag(ctx, args as StoreArgs),
      ),
  );

  server.registerTool(
    "gma3_delete_tag",
    {
      title: "Delete tags",
      description:
        "Delete a tag (by number or exact name; a name more than one tag has is refused). It leaves every object that carries it: removedFrom lists them (from the console's reverse lookup, before the delete) and each is re-read afterwards (stillCarries), and the slot is read back empty. Needs bridge 0.36.0. " +
        BATCH_NOTE,
      inputSchema: {
        tag: tagKeySchema.optional().describe("Tag number or exact name. Required unless tags is given."),
        verify: z.boolean().optional().describe("Read back (default true)."),
        tags: z.array(z.object({ tag: tagKeySchema })).optional().describe("Batch form: several tags, each {tag}."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).tags !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "delete_tag",
              listKey: "tags",
              identityKeys: ["tag"],
              label: (it) => `Tag ${typeof it.tag === "string" ? JSON.stringify(it.tag) : String(it.tag)}`,
              key: (it) => `Tag ${String(it.tag)}`,
              check: (items) => duplicates(items.map((it) => String(it.tag))).map((x) => `Tag ${x} appears more than once in tags`),
              run: (it, c) => deleteTag(c, it as DeleteArgs),
            })
          : deleteTag(ctx, args as DeleteArgs),
      ),
  );

  server.registerTool(
    "gma3_assign_tag",
    {
      title: "Assign or remove a tag on objects",
      description:
        "Assign a tag to objects, or remove it (off: true), with Assign [Off] Tag n At <objects>, and read back every object's tags. The tag is given by number or exact name and must exist (the console answers OK to an unknown tag and changes nothing); a name is resolved to its number first, and a name more than one tag has is refused. " +
        'target is a command-line reference with numbers: "Sequence 950 Thru 952", "Group 5", "Macro 3", "Macro 3.1" (a line), "Sequence 5 Cue 2" (the tag lands on the cue\'s Part 0 and is reported there), "Preset 4.1", "Tag 7". data_pool addresses the objects of another data pool. Fixtures cannot carry tags. ' +
        `protect sets the Protect flag of each reference: ${KILL_NOTE} Needs bridge 0.36.0. ` +
        BATCH_NOTE,
      inputSchema: {
        tag: tagKeySchema.optional().describe("Tag number or exact name. Required unless assignments is given (it may then be a default)."),
        target: z.string().optional().describe("The objects. Required unless assignments is given."),
        off: z.boolean().optional().describe("Remove the tag from the objects instead."),
        protect: z.boolean().optional().describe("Set the Protect flag of these references (default: left as it is)."),
        verify: z.boolean().optional().describe("Read back (default true)."),
        ...dataPoolShape,
        assignments: z
          .array(z.object({ tag: tagKeySchema.optional(), target: z.string(), off: z.boolean().optional(), protect: z.boolean().optional(), data_pool: z.number().int().min(1).max(9999).optional() }))
          .optional()
          .describe("Batch form: several {tag, target, off, protect, data_pool}; tag and data_pool may be given once for all."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).assignments !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "assign_tag",
              listKey: "assignments",
              identityKeys: ["target", "off", "protect"],
              label: (it) => `${it.off === true ? "off " : ""}Tag ${typeof it.tag === "string" ? JSON.stringify(it.tag) : String(it.tag)} At ${it.data_pool !== undefined ? `DataPool ${String(it.data_pool)} ` : ""}${String(it.target)}`,
              key: (it) => `${it.data_pool !== undefined ? `DataPool ${String(it.data_pool)} ` : ""}${String(it.target)}`,
              run: (it, c) => assignTag(c, it as AssignArgs),
            })
          : assignTag(ctx, args as AssignArgs),
      ),
  );

  server.registerTool(
    "gma3_configure_tag",
    {
      title: "Configure a tag (kill type, forwarding, action, appearance, note)",
      description:
        `Set a tag's type (${TAG_TYPES.join(", ")}), Forward Commands (whether Go+ Tag n / Off Tag n reach the tagged objects), pool action (${TAG_ACTIONS.join(", ")}), appearance (a number, or null to clear) and note, then read each one back. ${KILL_NOTE} ` +
        "Set the type before the sequences run (the manual: otherwise it works once they have been started). Values outside these lists are refused before anything is sent. Needs bridge 0.36.0. " +
        BATCH_NOTE,
      inputSchema: {
        tag: tagKeySchema.optional().describe("Tag number or exact name. Required unless tags is given."),
        type: z.enum(TAG_TYPES).optional().describe("Tag type."),
        forward_commands: z.boolean().optional().describe("Forward commands on the tag to the tagged objects."),
        action: z.enum(TAG_ACTIONS).optional().describe("What the tag's pool button does (Pool Default: the pool's setting)."),
        appearance: z.number().int().nullable().optional().describe("Appearance number, or null to clear."),
        note: z.string().optional().describe('Note text ("" clears it; no double quotes).'),
        verify: z.boolean().optional().describe("Read back (default true)."),
        tags: z
          .array(z.object({ tag: tagKeySchema, type: z.enum(TAG_TYPES).optional(), forward_commands: z.boolean().optional(), action: z.enum(TAG_ACTIONS).optional(), appearance: z.number().int().nullable().optional(), note: z.string().optional() }))
          .optional()
          .describe("Batch form: several tags with their settings; a setting given once applies to every item."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).tags !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "configure_tag",
              listKey: "tags",
              identityKeys: ["tag"],
              label: (it) => `Tag ${typeof it.tag === "string" ? JSON.stringify(it.tag) : String(it.tag)}`,
              key: (it) => `Tag ${String(it.tag)}`,
              check: (items) => duplicates(items.map((it) => String(it.tag))).map((x) => `Tag ${x} appears more than once in tags`),
              run: (it, c) => configureTag(c, it as ConfigureArgs),
            })
          : configureTag(ctx, args as ConfigureArgs),
      ),
  );
};
