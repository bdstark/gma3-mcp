/**
 * Issue #148: Worlds, Filters, Appearances and Views.
 *
 *   gma3_pool_details    read-only: the filters, worlds, appearances or views of the show, decoded (a filter's
 *                        attributes by name and feature group, its value layers; an appearance's colour and image; a
 *                        view's windows)
 *   gma3_store_filter    store or update attribute filters (attributes and feature groups, value layers); batch form
 *   gma3_set_appearance  create or change an appearance (background colour, image, image mode) and assign it to pool
 *                        objects; batch form
 *
 * Built on existing bridge ops only (objects, children, set, cmd, dialog.read): no bridge change.
 *
 * Console facts (onPC 2.5.1.1, read-only probe of Festoon Demo, 2026-11-17, and the grandMA3 2.5 manual):
 *   - Filters are DataPool.Filters, worlds DataPool.Worlds, appearances ShowData.Appearances, views the current user
 *     profile's Views (ShowData.UserProfiles.Default.Views). "Filter Thru", "World Thru", "Appearance Thru" and
 *     "View Thru" resolve to the pool's objects.
 *   - A filter's (and a world's) Attributes property reads as one character per attribute definition
 *     (ShowData.LivePatch.AttributeDefinitions.Attributes, 356 in that show), "1" when the attribute passes: character i
 *     is the definition with index i + 1 ("Only Dimmer" sets only character 0, Dimmer; "Only Color" sets
 *     ColorRGB_R/G/B/W). A filter or world passing every attribute reads "All" instead (World 1).
 *   - Absolute, Relative, Timing and Phaser are the value layers a filter passes (Yes/No). HasDynamicFilterRules
 *     reads Yes when the filter carries dynamic filter rules (Changed, Cooked, ...).
 *   - The manual's Index keyword page writes one character: Set Filter 6 Property "Attributes" Index 0 "0" disables
 *     the dimmer. This tool writes the whole string with the bridge's set op and reads it back: a string the console
 *     does not take reads back different and the item fails (not probed with a write).
 *   - "Store Filter 5 "My Filter"" stores the At Filter as a new filter (2.3 release notes); the tool then writes the
 *     attributes and layers it was asked for, so the At Filter only contributes filter rules other than attributes,
 *     which the read-back reports (HasDynamicFilterRules).
 *   - Appearances: BackR, BackG, BackB, BackAlpha (0-255) are the background, ImageMode (Stretch, Bar, Crop, Tile,
 *     Center) and Image the image. "Assign Appearance 3 At Group 1" assigns one (keyword page); "Assign Image 3.5 At
 *     Group 46" opens a Select Appearance pop-up (Images page), so an image is assigned to the appearance itself, and
 *     the tool checks for an open dialog after every command. "Store Image 3.2" stores an empty pool object (pool
 *     page); that Store Appearance n does the same is not probed.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import { asRead, buildResult, commandStep, requestStep, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, describe, objectName, quoteName } from "../validate.js";
import { readObjects } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { readDialog } from "./dialog.js";
import { lockState } from "./playback.js";
import { ON_NAME_TAKEN, checkPoolName, nameOrSuffixed, type OnNameTaken, type PoolNameCache } from "./poolnames.js";

const MAX_NUMBER = 9999;
const ATTRIBUTES_REF = "ShowData.LivePatch.AttributeDefinitions.Attributes";
const FEATURE_GROUPS_REF = "ShowData.LivePatch.AttributeDefinitions.FeatureGroups";
const LAYERS = ["absolute", "relative", "timing", "phaser"] as const;
type Layer = (typeof LAYERS)[number];
const LAYER_PROPERTY: Record<Layer, string> = { absolute: "Absolute", relative: "Relative", timing: "Timing", phaser: "Phaser" };
export const IMAGE_MODES = ["Stretch", "Bar", "Crop", "Tile", "Center"] as const;

// ---------------------------------------------------------------------------
// The attribute definitions
// ---------------------------------------------------------------------------

export interface AttributeCatalog {
  /** Number of attribute definitions: the length of a filter's Attributes string. */
  count: number;
  /** Definition index (1-based) to name and feature group. */
  byIndex: Map<number, { name: string; feature?: string; group?: string }>;
  /** Lower-case attribute name to index. */
  byName: Map<string, number>;
  /** Lower-case feature group name to its name and attribute indexes. */
  groups: Map<string, { name: string; indices: number[] }>;
  /**
   * Why the feature groups' members are not known in full (an attribute whose Feature could not be read, a feature in
   * no group, a feature of a group without a readable name). Non-empty: no group is resolved or reported as complete.
   */
  groupGaps: string[];
}

interface ChildrenResult {
  total?: number;
  items?: Array<{ name?: string; index?: number; addr?: string; fields?: Record<string, unknown>; fieldErrors?: Record<string, unknown> }>;
  enumerationError?: unknown;
}

/** Every item of a listing, or an error when the listing is cut short (fail closed: a filter built from part of it would be wrong). */
async function fullListing(bridge: Gma3Bridge, ref: string, fields: string[], t: number): Promise<NonNullable<ChildrenResult["items"]>> {
  const res = (await bridge.request("children", { ref, fields, limit: 5000 }, t)) as ChildrenResult | null;
  const items = res?.items ?? [];
  if (res?.enumerationError) throw new Error(`${ref} could not be listed completely (${String(res.enumerationError)})`);
  if (typeof res?.total === "number" && res.total !== items.length) throw new Error(`${ref} listed ${items.length} of ${res.total} entries`);
  return items;
}

/** The attribute definitions with their feature groups (attributes name their feature; a feature group lists its features). */
export async function readCatalog(bridge: Gma3Bridge, t: number): Promise<AttributeCatalog> {
  const attrs = await fullListing(bridge, ATTRIBUTES_REF, ["Name", "Feature"], t);
  const groupItems = await fullListing(bridge, FEATURE_GROUPS_REF, ["Name"], t);
  const featureGroup = new Map<string, string>();
  const groups = new Map<string, { name: string; indices: number[] }>();
  const groupGaps: string[] = [];
  for (const g of groupItems) {
    const gname = g.fieldErrors?.Name === undefined && typeof g.fields?.Name === "string" && g.fields.Name ? g.fields.Name : undefined;
    if (!gname || !g.addr) throw new Error(`a feature group of ${FEATURE_GROUPS_REF} has no readable name or address`);
    groups.set(gname.toLowerCase(), { name: gname, indices: [] });
    let features: NonNullable<ChildrenResult["items"]>;
    try {
      features = await fullListing(bridge, g.addr, ["Name"], t);
    } catch (err) {
      groupGaps.push(`the features of feature group ${gname} could not be listed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    for (const f of features) {
      const fname = f.fieldErrors?.Name === undefined && typeof f.fields?.Name === "string" && f.fields.Name ? f.fields.Name : undefined;
      if (fname) featureGroup.set(fname.toLowerCase(), gname);
      else groupGaps.push(`a feature of feature group ${gname} has no readable name`);
    }
  }
  const byIndex = new Map<number, { name: string; feature?: string; group?: string }>();
  const byName = new Map<string, number>();
  for (const a of attrs) {
    const name = typeof a.fields?.Name === "string" ? a.fields.Name : a.name;
    if (typeof a.index !== "number" || !name) throw new Error(`an attribute definition of ${ATTRIBUTES_REF} has no readable index or name`);
    const feature = a.fieldErrors?.Feature === undefined && typeof a.fields?.Feature === "string" && a.fields.Feature ? a.fields.Feature : undefined;
    const group = feature ? featureGroup.get(feature.toLowerCase()) : undefined;
    // Its group is unknown, so any group may be missing it (#161 review).
    if (!feature) groupGaps.push(`the feature of attribute ${name} could not be read${a.fieldErrors?.Feature !== undefined ? ` (${String(a.fieldErrors.Feature)})` : ""}`);
    else if (!group) groupGaps.push(`the feature ${feature} of attribute ${name} is in no feature group that could be read`);
    byIndex.set(a.index, { name, ...(feature ? { feature } : {}), ...(group ? { group } : {}) });
    byName.set(name.toLowerCase(), a.index);
    if (group) groups.get(group.toLowerCase())?.indices.push(a.index);
  }
  const count = Math.max(attrs.length, ...byIndex.keys());
  return { count, byIndex, byName, groups, groupGaps };
}

/** The Attributes text as the set of passing definition indexes: "All" is every one; null when it is not that form. */
export function decodeAttributes(text: unknown, count: number): Set<number> | null {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (/^all$/i.test(s)) return new Set(Array.from({ length: count }, (_, i) => i + 1));
  if (!/^[01]+$/.test(s) || s.length !== count) return null;
  const out = new Set<number>();
  for (let i = 0; i < s.length; i++) if (s[i] === "1") out.add(i + 1);
  return out;
}

export function encodeAttributes(indices: Set<number>, count: number): string {
  let s = "";
  for (let i = 1; i <= count; i++) s += indices.has(i) ? "1" : "0";
  return s;
}

/** A decoded attribute set for a reader: "all", or the feature groups it covers fully and the names. */
export function describeAttributes(set: Set<number>, cat: AttributeCatalog, max = 60): Record<string, unknown> | "all" {
  if (set.size === cat.count) return "all";
  // Without every member of every group known, no group is claimed as fully passed.
  const full = cat.groupGaps.length ? [] : [...cat.groups.values()].filter((g) => g.indices.length > 0 && g.indices.every((i) => set.has(i))).map((g) => g.name);
  const names = [...set].sort((a, b) => a - b).map((i) => cat.byIndex.get(i)?.name ?? `#${i}`);
  return { count: set.size, ...(full.length ? { featureGroups: full } : {}), attributes: names.slice(0, max), ...(names.length > max ? { truncated: true } : {}) };
}

/** Attribute and feature-group names to indexes; unknown names are errors. */
export function resolveAttributes(cat: AttributeCatalog, attributes: string[], groups: string[], exclude: string[]): { indices: Set<number>; errors: string[] } {
  const indices = new Set<number>();
  const errors: string[] = [];
  if (groups.length && cat.groupGaps.length) {
    const gaps = cat.groupGaps.slice(0, 5).join("; ") + (cat.groupGaps.length > 5 ? `; and ${cat.groupGaps.length - 5} more` : "");
    errors.push(`the members of the feature groups cannot be established in full (${gaps}), so feature_groups could leave attributes out; name the attributes instead`);
    groups = [];
  }
  for (const g of groups) {
    const hit = cat.groups.get(g.trim().toLowerCase());
    if (!hit) errors.push(`feature group ${JSON.stringify(g)} does not exist (the show has ${[...cat.groups.values()].map((x) => x.name).join(", ")})`);
    else if (!hit.indices.length) errors.push(`feature group ${JSON.stringify(hit.name)} has no attribute definitions whose feature could be read`);
    else hit.indices.forEach((i) => indices.add(i));
  }
  const byName = (n: string, what: string) => {
    const i = cat.byName.get(n.trim().toLowerCase());
    if (i === undefined) errors.push(`${what} ${JSON.stringify(n)} is not an attribute definition of the show`);
    return i;
  };
  for (const a of attributes) {
    const i = byName(a, "attribute");
    if (i !== undefined) indices.add(i);
  }
  for (const a of exclude) {
    const i = byName(a, "exclude:");
    if (i !== undefined) indices.delete(i);
  }
  return { indices, errors };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const leadingNumber = (v: unknown): number | undefined => {
  const m = String(v ?? "").match(/^\s*(\d+)/);
  return m ? Number(m[1]) : undefined;
};
const yesNo = (v: unknown): boolean | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "yes" ? true : s === "no" ? false : null;
};

interface PoolState {
  exists: boolean;
  /** How many objects the reference resolved to (a name can match several). */
  total?: number;
  name?: string;
  addr?: string;
  locked?: boolean | null;
  fields: Record<string, unknown>;
  fieldErrors: Record<string, unknown>;
}

async function readOne(bridge: Gma3Bridge, ref: string, fields: string[], asText = true): Promise<PoolState> {
  const res = await readObjects(bridge, ref, ["Name", "Lock", ...fields], 1, asText ? {} : { asText: false });
  const item = res?.items?.[0];
  if (!item || item.invalid) return { exists: false, fields: {}, fieldErrors: {} };
  const f = (item.fields ?? {}) as Record<string, unknown>;
  const errs = (item.fieldErrors ?? {}) as Record<string, unknown>;
  const nm = typeof f.Name === "string" ? f.Name : typeof f.Name === "object" && f.Name ? String((f.Name as { name?: unknown }).name ?? "") : item.name;
  return { exists: true, total: typeof res?.total === "number" ? res.total : undefined, name: nm, addr: item.addr, locked: errs.Lock !== undefined ? null : lockState(f.Lock), fields: f, fieldErrors: errs };
}

const refuse = (name: string, error: string, detail?: unknown): StepResult => asRead({ name, status: "failed", error, ...(detail !== undefined ? { detail } : {}) });

async function readStepOf<T>(name: string, op: string, fn: () => Promise<T>, detail?: (v: T) => unknown): Promise<{ step: StepResult; value?: T }> {
  try {
    const value = await fn();
    return { step: asRead({ name, status: "succeeded", op, ...(detail ? { detail: detail(value) } : {}) }), value };
  } catch (err) {
    return { step: asRead(stepFromError(name, err, { op })) };
  }
}

/** A dialog the console left open after a command: nothing more is sent, and gma3_dialog answers it. */
async function dialogStep(bridge: Gma3Bridge, name: string, t: number): Promise<StepResult> {
  try {
    const d = await readDialog(bridge, t);
    if (!d.open) return asRead({ name, status: "succeeded", op: "dialog.read", detail: { open: false } });
    const m = d.modal || undefined;
    return refuse(name, `a dialog is open on the console${m && (m.title || m.text) ? ` (${JSON.stringify(m.title || m.text)})` : ""}; nothing more was sent: read and answer it with gma3_dialog`, d);
  } catch (err) {
    return asRead(stepFromError(name, err, { op: "dialog.read" }));
  }
}

type Planned = { name: string; command?: string; set?: { ref: string; property: string; value: string }; dialogCheck?: boolean };

/** Send the plan in order; stops at the first step that did not succeed. */
/**
 * Whether the value a set op read back is the one written: an Attributes mask by its exact text ("All" for a mask of only
 * 1s), numbers by value, other text case aside (Yes/No, an image mode).
 */
export function setTaken(property: string, want: string, got: unknown): boolean {
  if (typeof got !== "string" && typeof got !== "number" && typeof got !== "boolean") return false;
  const g = String(got).trim();
  // An Attributes mask is a positional bit string, never a number: exact text, or All for a mask of only 1s (#163 review).
  if (/^attributes$/i.test(property)) return /^all$/i.test(g) ? /^1+$/.test(want) : g === want.trim();
  if (/^-?\d+(\.\d+)?$/.test(want)) return g !== "" && Number(g) === Number(want);
  return g.toLowerCase() === want.trim().toLowerCase();
}

/**
 * A set step judged by what the console read back right after the write: a value it did not take (the console keeps
 * the old one without an error) or a read-back that failed is a failed step, so nothing after it is sent (#161 review:
 * an ignored BackR must not let the Assign run).
 */
const interpretSet = (name: string, set: { ref: string; property: string; value: string }) => (res: unknown): StepResult => {
  const r = (res ?? {}) as { value?: unknown; readOk?: unknown; readError?: unknown };
  const base = { name, op: "set", detail: res };
  if (r.value === undefined || r.value === null) {
    const why = r.readOk === true ? "reads empty" : `could not be read back${typeof r.readError === "string" ? ` (${r.readError})` : ""}`;
    // The write reached the console; what it holds now is not known: unknown, which also stops a batch.
    return { ...base, status: r.readOk === true ? "failed" : "unknown", error: `${set.property} of ${set.ref} ${why} after the write, so whether the console took ${JSON.stringify(set.value.length > 40 ? `${set.value.slice(0, 37)}...` : set.value)} is unknown; nothing more was sent` };
  }
  if (!setTaken(set.property, set.value, r.value)) {
    const shown = (v: string) => JSON.stringify(v.length > 40 ? `${v.slice(0, 37)}...` : v);
    return { ...base, status: "failed", error: `the console did not take ${set.property} = ${shown(set.value)} on ${set.ref}: it reads ${shown(String(r.value))}; nothing more was sent` };
  }
  return { ...base, status: "succeeded" };
};

async function sendPlan(bridge: Gma3Bridge, plan: Planned[], steps: StepResult[], t: number): Promise<boolean> {
  for (const p of plan) {
    const step = p.command
      ? await commandStep(bridge, p.name, p.command, t)
      : await requestStep(bridge, p.name, "set", { ref: p.set!.ref, property: p.set!.property, value: p.set!.value }, interpretSet(p.name, p.set!), t);
    steps.push(step);
    if (step.status !== "succeeded") return false;
    if (p.dialogCheck) {
      const d = await dialogStep(bridge, `${p.name}_dialog`, t);
      steps.push(d);
      if (d.status !== "succeeded") return false;
    }
  }
  return true;
}

const planText = (bridge: Gma3Bridge, plan: Planned[]) => plan.map((p) => (p.command ? bridge.sentCommand?.(p.command) ?? p.command : `set ${p.set!.ref} ${p.set!.property} = ${p.set!.value.length > 40 ? `"${p.set!.value.slice(0, 37)}..." (${p.set!.value.length} characters)` : JSON.stringify(p.set!.value)}`));

function poolNumber(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_NUMBER) throw new ValidationError(`${field} must be a whole number from 1 to ${MAX_NUMBER} (got ${describe(value)})`, field);
  return value;
}

function nameList(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x.trim())) throw new ValidationError(`${field} must be a list of names (got ${describe(value)})`, field);
  return value as string[];
}

// ---------------------------------------------------------------------------
// gma3_pool_details
// ---------------------------------------------------------------------------

export const DETAIL_KINDS = ["filters", "worlds", "appearances", "views"] as const;
type DetailKind = (typeof DETAIL_KINDS)[number];
const KEYWORD: Record<DetailKind, string> = { filters: "Filter", worlds: "World", appearances: "Appearance", views: "View" };
const MAX_VIEWS_WITH_WINDOWS = 30;

const hex2 = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n.toString(16).padStart(2, "0") : undefined;
};

export async function poolDetails(ctx: ToolContext, raw: { kind?: unknown; range?: unknown; limit?: unknown; windows?: unknown }): Promise<OperationResult> {
  const v = new Validator();
  const kind = v.check(() => {
    if (typeof raw.kind !== "string" || !(DETAIL_KINDS as readonly string[]).includes(raw.kind)) throw new ValidationError(`kind must be one of ${DETAIL_KINDS.join(", ")} (got ${describe(raw.kind)})`, "kind");
    return raw.kind as DetailKind;
  });
  let range: string | undefined;
  if (kind) {
    // Whitespace inside a quoted name is part of the name (#161 review).
    range = typeof raw.range === "string" && raw.range.trim() ? raw.range.trim().replace(/("[^"]*")|\s+/g, (m, q) => q ?? " ") : `${KEYWORD[kind]} Thru`;
    if (!new RegExp(`^${KEYWORD[kind]}\\b`, "i").test(range)) v.fail(`range must name ${KEYWORD[kind].toLowerCase()}s, e.g. "${KEYWORD[kind]} 1 Thru 20" (got ${JSON.stringify(range)})`);
  }
  const limit = raw.limit === undefined ? 200 : typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= 1000 ? raw.limit : (v.fail("limit must be a whole number from 1 to 1000"), 200);
  const target = { kind: raw.kind, range };
  if (!v.ok || !kind || !range) return validationFailure("pool_details", target, v.errors);

  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const steps: StepResult[] = [];
  const warnings: string[] = [];
  const fields: Record<DetailKind, string[]> = {
    filters: ["No", "Name", "Lock", "Attributes", "Absolute", "Relative", "Timing", "Phaser", "HasDynamicFilterRules"],
    worlds: ["No", "Name", "Lock", "Attributes", "SelectionData"],
    appearances: ["No", "Name", "Image", "ImageMode", "BackR", "BackG", "BackB", "BackAlpha"],
    views: ["No", "Name", "Appearance"],
  };
  const list = await readStepOf("read_pool", "objects", () => readObjects(bridge, range!, fields[kind], limit));
  steps.push(list.step);
  if (!list.value && list.step.status !== "succeeded") return buildResult({ operation: "pool_details", target, steps, warnings });
  const res = list.value;
  const items = res?.items ?? [];
  let cat: AttributeCatalog | undefined;
  if ((kind === "filters" || kind === "worlds") && items.some((it) => typeof it.fields?.Attributes === "string" && /^[01]+$/.test(String(it.fields.Attributes).trim()))) {
    const c = await readStepOf("read_attribute_definitions", "children", () => readCatalog(bridge, t), (x) => ({ attributes: x.count, featureGroups: x.groups.size }));
    steps.push(c.step);
    cat = c.value;
    if (!cat) warnings.push("the attribute definitions could not be read, so attribute filters are given as their raw text");
  }
  const out: Array<Record<string, unknown>> = [];
  let windowsRead = 0;
  for (const it of items) {
    if (it.invalid) continue;
    const f = (it.fields ?? {}) as Record<string, unknown>;
    const errs = ((it as { fieldErrors?: Record<string, unknown> }).fieldErrors ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { no: leadingNumber(f.No) ?? it.index, name: typeof f.Name === "string" ? f.Name : it.name };
    // A field the console could not read is reported as such, never as a default (#161 review).
    const unreadable = Object.keys(errs);
    if (unreadable.length) {
      row.unreadable = unreadable;
      warnings.push(`${KEYWORD[kind]} ${String(row.no)}: ${unreadable.join(", ")} could not be read`);
    }
    if (lockState(f.Lock)) row.locked = true;
    if (kind === "filters" || kind === "worlds") {
      const count = cat?.count ?? (typeof f.Attributes === "string" ? f.Attributes.trim().length : 0);
      const set = errs.Attributes !== undefined ? null : decodeAttributes(f.Attributes, count);
      row.attributes = errs.Attributes !== undefined ? null : set && cat ? describeAttributes(set, cat) : set && set.size === count ? "all" : f.Attributes ?? null;
      if (kind === "filters") {
        row.layers = Object.fromEntries(LAYERS.map((l) => [l, yesNo(f[LAYER_PROPERTY[l]])]));
        const dyn = yesNo(f.HasDynamicFilterRules);
        if (dyn) row.dynamicRules = true;
        else if (dyn === null) row.dynamicRules = null;
      } else if (errs.SelectionData !== undefined || (f.SelectionData !== undefined && typeof f.SelectionData !== "string")) row.fixtures = null;
      else if (f.SelectionData === undefined) row.fixtures = null;
      else if (f.SelectionData.trim()) row.fixtures = "a selection (SelectionData)";
      else row.fixtures = "all";
    } else if (kind === "appearances") {
      const [r, g, b] = [hex2(f.BackR), hex2(f.BackG), hex2(f.BackB)];
      if (r && g && b) row.background = `#${r}${g}${b}`;
      if (f.BackAlpha !== undefined) row.backgroundAlpha = Number(f.BackAlpha);
      if (typeof f.Image === "string" && f.Image) row.image = f.Image;
      if (typeof f.ImageMode === "string") row.imageMode = f.ImageMode;
    } else {
      if (typeof f.Appearance === "string" && f.Appearance) row.appearance = f.Appearance;
      if (raw.windows !== false && it.addr && windowsRead < MAX_VIEWS_WITH_WINDOWS) {
        windowsRead++;
        try {
          // A listing cut short or raised (enumerationError) is unreadable, never an empty view (#161 review).
          const items = await fullListing(bridge, it.addr, ["Name", "X", "Y", "W", "H"], t);
          const num = (x: (typeof items)[number], k: string) => (x.fieldErrors?.[k] !== undefined || x.fields?.[k] === undefined || x.fields?.[k] === "" || Number.isNaN(Number(x.fields?.[k])) ? null : Number(x.fields?.[k]));
          row.windows = items.map((x) => ({ window: x.fields?.Name ?? x.name, x: num(x, "X"), y: num(x, "Y"), w: num(x, "W"), h: num(x, "H") }));
          if (items.some((x) => ["X", "Y", "W", "H"].some((k) => num(x, k) === null))) warnings.push(`view ${String(row.no)}: the position of some windows could not be read (null)`);
        } catch (err) {
          row.windows = null;
          warnings.push(`the windows of view ${String(row.no)} could not be read (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    out.push(row);
  }
  if (kind === "views" && raw.windows !== false && items.length > MAX_VIEWS_WITH_WINDOWS) warnings.push(`windows are listed for the first ${MAX_VIEWS_WITH_WINDOWS} views only; narrow range for the others`);
  if (kind === "views") warnings.push("views belong to the current user profile");
  const total = typeof res?.total === "number" ? res.total : out.length;
  const extra: Record<string, unknown> = { kind, count: out.length, total, [kind]: out, ...(total > out.length ? { truncated: true, note: `${out.length} of ${total}; raise limit or narrow range` } : {}) };
  return buildResult({ operation: "pool_details", target, steps, warnings, extra, summary: `${out.length} ${kind} read from ${range}.` });
}

// ---------------------------------------------------------------------------
// gma3_store_filter
// ---------------------------------------------------------------------------

export const FILTER_ON_TAKEN = ["refuse", "update"] as const;

export interface StoreFilterArgs {
  filter?: unknown;
  name?: unknown;
  attributes?: unknown;
  feature_groups?: unknown;
  exclude?: unknown;
  layers?: unknown;
  on_taken?: unknown;
  on_name_taken?: unknown;
  preview?: unknown;
  verify?: unknown;
}

export async function storeFilter(ctx: ToolContext, raw: StoreFilterArgs): Promise<OperationResult> {
  const v = new Validator();
  const no = v.check(() => poolNumber("filter", raw.filter));
  const name = v.check(() => objectName("name", raw.name, { optional: true }));
  const attributes = v.check(() => nameList("attributes", raw.attributes)) ?? [];
  const groups = v.check(() => nameList("feature_groups", raw.feature_groups)) ?? [];
  const exclude = v.check(() => nameList("exclude", raw.exclude)) ?? [];
  const attrsGiven = raw.attributes !== undefined || raw.feature_groups !== undefined;
  const layers: Partial<Record<Layer, boolean>> = {};
  if (raw.layers !== undefined) {
    if (!raw.layers || typeof raw.layers !== "object" || Array.isArray(raw.layers)) v.fail("layers must be an object such as {absolute: true, relative: false, timing: true, phaser: false}");
    else
      for (const [k, x] of Object.entries(raw.layers as Record<string, unknown>)) {
        if (!(LAYERS as readonly string[]).includes(k)) v.fail(`layers: ${JSON.stringify(k)} is not one of ${LAYERS.join(", ")}`);
        else if (typeof x !== "boolean") v.fail(`layers.${k} must be true or false`);
        else layers[k as Layer] = x;
      }
  }
  if (raw.exclude !== undefined && !attrsGiven) v.fail("exclude removes attributes from attributes and feature_groups: give one of those too");
  const onTaken = raw.on_taken === undefined ? "refuse" : (FILTER_ON_TAKEN as readonly string[]).includes(String(raw.on_taken)) ? (raw.on_taken as "refuse" | "update") : (v.fail(`on_taken must be one of ${FILTER_ON_TAKEN.join(", ")}`), "refuse");
  if (raw.on_name_taken !== undefined && !(ON_NAME_TAKEN as readonly string[]).includes(String(raw.on_name_taken))) v.fail(`on_name_taken must be one of ${ON_NAME_TAKEN.join(", ")}`);
  const onNameTaken: OnNameTaken = raw.on_name_taken === "allow_suffix" ? "allow_suffix" : "refuse";
  const target = { filter: raw.filter, ...(name !== undefined ? { name } : {}) };
  if (v.ok && !attrsGiven && onTaken !== "update") v.fail("a new filter needs attributes or feature_groups (the attributes it passes)");
  if (v.ok && !attrsGiven && !Object.keys(layers).length && name === undefined) v.fail("nothing to change: give attributes, feature_groups, layers or name");
  if (!v.ok || no === undefined) return validationFailure("store_filter", target, v.errors);

  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const ref = `Filter ${no}`;
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const warnings: string[] = [];

  const body = async (): Promise<OperationResult> => {
    const steps: StepResult[] = [];
    const done = (extra: Record<string, unknown> = {}, verification?: Verification, summary?: string) => buildResult({ operation: "store_filter", target, steps, warnings, verification, summary, extra });

    let cat: AttributeCatalog | undefined;
    let want: Set<number> | undefined;
    const c = await readStepOf("read_attribute_definitions", "children", () => readCatalog(bridge, t), (x) => ({ attributes: x.count, featureGroups: [...x.groups.values()].map((g) => g.name) }));
    steps.push(c.step);
    if (!c.value) return done();
    cat = c.value;
    if (attrsGiven) {
      const r = resolveAttributes(cat, attributes, groups, exclude);
      if (r.errors.length) {
        steps.push(refuse("check_attributes", `${r.errors.join("; ")}; nothing was sent`));
        return done();
      }
      if (!r.indices.size) {
        steps.push(refuse("check_attributes", "the filter would pass no attribute at all; nothing was sent"));
        return done();
      }
      want = r.indices;
      steps.push(asRead({ name: "check_attributes", status: "succeeded", detail: describeAttributes(want, cat) }));
    }

    const s = await readStepOf("read_filter", "objects", () => readOne(bridge, ref, ["Attributes", "Absolute", "Relative", "Timing", "Phaser", "HasDynamicFilterRules"]));
    steps.push(s.step);
    const before = s.value;
    if (!before) return done();
    const shown = (p: PoolState) => (p.exists ? { exists: true, name: p.name, ...(p.locked ? { locked: true } : {}) } : { exists: false });
    if (before.exists) {
      if (onTaken === "refuse") {
        steps.push(refuse("check_filter", `${ref} is taken ("${before.name ?? ""}"); pass on_taken "update" to change it in place, or choose a free number (gma3_pool_details kind filters lists them); nothing was sent`));
        return done({ filter: shown(before) });
      }
      if (before.locked !== false) {
        steps.push(refuse("check_filter", before.locked ? `${ref} is locked; nothing was sent` : `the Lock of ${ref} could not be read; nothing was sent`));
        return done({ filter: shown(before) });
      }
      steps.push(asRead({ name: "check_filter", status: "succeeded", detail: { taken: true, update: true } }));
    } else {
      if (onTaken === "update") warnings.push(`${ref} is free, so it is stored new (on_taken "update" had nothing to update)`);
      steps.push(asRead({ name: "check_filter", status: "succeeded", detail: { taken: false } }));
    }
    const creating = !before.exists;
    // A new filter's attributes are always chosen: Store takes the At Filter's (#161 review).
    if (creating && !want) {
      steps.push(refuse("check_attributes", `${ref} is free, so it would be stored new from the At Filter: give attributes or feature_groups for it; nothing was sent`));
      return done({ filter: shown(before) });
    }

    if (name !== undefined && !(before.exists && before.name === name)) {
      const cache: PoolNameCache<string> = new Map();
      const r = await checkPoolName({ bridge, t, pool: { ref: "DataPool.Filters", noun: "filter", plural: "filters", label: (n) => `Filter ${n}` }, cache, number: no, name, onNameTaken, warnings, keepOwn: true });
      steps.push(asRead({ name: "check_name", status: r.status, op: "children", detail: r.detail, ...(r.error ? { error: r.error } : {}) }));
      if (r.status !== "succeeded") return done({ filter: shown(before) });
    }

    // A new filter starts from the At Filter: every layer is written, passing unless layers says otherwise.
    const wantLayers: Partial<Record<Layer, boolean>> = creating ? Object.fromEntries(LAYERS.map((l) => [l, layers[l] ?? true])) : layers;
    const plan: Planned[] = [];
    if (creating) plan.push({ name: "store", command: `Store ${ref}${name !== undefined ? ` ${quoteName(name)}` : ""} /NoConfirmation`, dialogCheck: true });
    else if (name !== undefined && before.name !== name) plan.push({ name: "label", command: `Label ${ref} ${quoteName(name)}` });
    if (want) plan.push({ name: "set_attributes", set: { ref, property: "Attributes", value: encodeAttributes(want, cat.count) } });
    for (const l of LAYERS) if (wantLayers[l] !== undefined) plan.push({ name: `set_${l}`, set: { ref, property: LAYER_PROPERTY[l], value: wantLayers[l] ? "Yes" : "No" } });

    const extra: Record<string, unknown> = { filter: shown(before), ...(want ? { attributes: describeAttributes(want, cat) } : {}), ...(Object.keys(wantLayers).length ? { layers: wantLayers } : {}) };
    if (preview) return done({ ...extra, preview: true, plan: planText(bridge, plan) }, undefined, `Preview only; nothing was sent (${plan.length} step(s) planned).`);

    // No dialog may be open: a Store would answer it or be swallowed by it.
    const d0 = await dialogStep(bridge, "check_dialog", t);
    steps.push(d0);
    if (d0.status !== "succeeded") return done(extra);
    if (!(await sendPlan(bridge, plan, steps, t))) return done(extra);
    if (!verify) return done(extra);

    const checks: string[] = [];
    const problems: string[] = [];
    let unavailable: string | undefined;
    try {
      const after = await readOne(bridge, ref, ["Attributes", "Absolute", "Relative", "Timing", "Phaser", "HasDynamicFilterRules"]);
      extra.after = shown(after);
      if (!after.exists) problems.push(`${ref} does not exist`);
      else {
        if (name !== undefined) {
          checks.push(`named "${name}"`);
          if (after.name !== name && !(onNameTaken === "allow_suffix" && after.name && nameOrSuffixed(after.name, name))) problems.push(`it reads the name "${after.name ?? ""}"`);
          else if (after.name !== name) warnings.push(`${ref} was named "${after.name}": the pool already had "${name}"`);
        }
        if (want) {
          checks.push(`passes exactly the ${want.size} attribute(s) asked for`);
          const got = decodeAttributes(after.fields.Attributes, cat!.count);
          if (after.fieldErrors.Attributes !== undefined) throw new Error(`its Attributes could not be read (${String(after.fieldErrors.Attributes)})`);
          if (!got) problems.push(`its Attributes read ${JSON.stringify(after.fields.Attributes)}, not a form this tool can compare`);
          else {
            const missing = [...want].filter((i) => !got.has(i)).map((i) => cat!.byIndex.get(i)?.name ?? `#${i}`);
            const extraA = [...got].filter((i) => !want!.has(i)).map((i) => cat!.byIndex.get(i)?.name ?? `#${i}`);
            if (missing.length) problems.push(`it does not pass ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""}`);
            if (extraA.length) problems.push(`it also passes ${extraA.slice(0, 10).join(", ")}${extraA.length > 10 ? ` and ${extraA.length - 10} more` : ""}`);
          }
        }
        for (const l of LAYERS) {
          if (wantLayers[l] === undefined) continue;
          checks.push(`${LAYER_PROPERTY[l]} ${wantLayers[l] ? "Yes" : "No"}`);
          const got = yesNo(after.fields[LAYER_PROPERTY[l]]);
          if (got === null) throw new Error(`its ${LAYER_PROPERTY[l]} could not be read`);
          if (got !== wantLayers[l]) problems.push(`${LAYER_PROPERTY[l]} reads ${got ? "Yes" : "No"}`);
        }
        if (yesNo(after.fields.HasDynamicFilterRules)) warnings.push(`${ref} has dynamic filter rules (Changed, Cooked, ...)${creating ? ", taken over from the At Filter by Store" : ""}: they filter on top of the attributes; edit the filter on the console to remove them`);
      }
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "objects" }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "objects" })));
      unavailable = err instanceof Error ? err.message : String(err);
    }
    const checked = `${ref} ${checks.join("; ")}`;
    const verification: Verification = unavailable !== undefined ? { status: "unavailable", checked, detail: unavailable } : problems.length ? { status: "mismatched", checked, detail: problems.join("; ") } : { status: "matched", checked };
    return done(extra, verification);
  };
  return preview ? body() : ctx.mutations.run(body);
}

// ---------------------------------------------------------------------------
// gma3_set_appearance
// ---------------------------------------------------------------------------

export interface SetAppearanceArgs {
  object?: unknown;
  appearance?: unknown;
  create?: unknown;
  on_taken?: unknown;
  on_name_taken?: unknown;
  preview?: unknown;
  verify?: unknown;
}

interface AppearanceSpec {
  name?: string;
  rgb?: [number, number, number];
  alpha?: number;
  image?: string;
  imageMode?: string;
}

/** "#RRGGBB" or "RRGGBB". */
export function parseColor(field: string, value: unknown): [number, number, number] {
  const m = typeof value === "string" ? value.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i) : null;
  if (!m) throw new ValidationError(`${field} must be a colour as "#RRGGBB" (got ${describe(value)})`, field);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** One pool object for an assignment (no ranges, no lists). */
export function parseTargetObject(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field} must be one object such as "Group 3", "Sequence 5" or "Macro 2" (got ${describe(value)})`, field);
  // Whitespace is collapsed outside a quoted name only: "Front  Wash" and "Front Wash" are two names (#161 review).
  const s = value.trim().replace(/("[^"]*")|\s+/g, (m, q) => q ?? " ");
  if (/\b(thru|through)\b|[+;]/i.test(s.replace(/"[^"]*"/g, ""))) throw new ValidationError(`${field}: one object per item (got ${JSON.stringify(s)}); use the batch form for several`, field);
  if (!/^[A-Za-z]+ (\d+(\.\d+)*|"[^"]+")$/.test(s)) throw new ValidationError(`${field} must be an object keyword and number such as "Group 3" or "Preset 4.12" (got ${JSON.stringify(s)})`, field);
  if (/[*?]/.test(s)) throw new ValidationError(`${field}: wildcards ("*", "?") can match several objects; name one object (got ${JSON.stringify(s)})`, field);
  if (/^appearance /i.test(s)) throw new ValidationError(`${field}: an appearance is not assigned to an appearance; give the object that should show it`, field);
  return s;
}

export async function setAppearance(ctx: ToolContext, raw: SetAppearanceArgs): Promise<OperationResult> {
  const v = new Validator();
  const object = raw.object === undefined ? undefined : v.check(() => parseTargetObject("object", raw.object));
  let appRef: string | undefined;
  let appNo: number | undefined;
  if (typeof raw.appearance === "number") appNo = v.check(() => poolNumber("appearance", raw.appearance));
  else if (typeof raw.appearance === "string" && raw.appearance.trim()) {
    const s = raw.appearance.trim();
    if (/^\d+$/.test(s)) appNo = v.check(() => poolNumber("appearance", Number(s)));
    else if (s.includes('"')) v.fail('appearance: a name without double quotes, or a number');
    else appRef = `Appearance ${quoteName(s)}`;
  } else v.fail(`appearance is required: a number, or the name of an existing appearance (got ${describe(raw.appearance)})`);
  if (appNo !== undefined) appRef = `Appearance ${appNo}`;
  let spec: AppearanceSpec | undefined;
  if (raw.create !== undefined) {
    if (!raw.create || typeof raw.create !== "object" || Array.isArray(raw.create)) v.fail("create must be an object {name?, color?, alpha?, image?, image_mode?}");
    else {
      const c = raw.create as Record<string, unknown>;
      spec = {};
      for (const k of Object.keys(c)) if (!["name", "color", "alpha", "image", "image_mode"].includes(k)) v.fail(`create.${k} is not a setting (name, color, alpha, image, image_mode)`);
      spec.name = v.check(() => objectName("create.name", c.name, { optional: true }));
      if (c.color !== undefined) spec.rgb = v.check(() => parseColor("create.color", c.color));
      if (c.alpha !== undefined) {
        if (typeof c.alpha !== "number" || !Number.isFinite(c.alpha) || c.alpha < 0 || c.alpha > 100) v.fail("create.alpha must be a percentage from 0 to 100");
        else spec.alpha = Math.round((c.alpha / 100) * 255);
      } else if (c.color !== undefined) spec.alpha = 255;
      if (c.image !== undefined) {
        if (typeof c.image !== "string" || !/^Image \d+\.\d+$/i.test(c.image.trim())) v.fail('create.image must be an image as "Image <pool>.<number>": 1 gobos, 2 symbols, 3 images (e.g. "Image 3.2")');
        else spec.image = c.image.trim().replace(/^image/i, "Image");
      }
      if (c.image_mode !== undefined) {
        const m = IMAGE_MODES.find((x) => x.toLowerCase() === String(c.image_mode).toLowerCase());
        if (!m) v.fail(`create.image_mode must be one of ${IMAGE_MODES.join(", ")}`);
        else spec.imageMode = m;
      }
      if (!Object.keys(c).length) v.fail("create needs at least one of name, color, alpha, image, image_mode");
      if (appNo === undefined && appRef !== undefined) v.fail("create: give appearance as a number (the slot to create or update)");
    }
  }
  if (object === undefined && spec === undefined && v.ok) v.fail("nothing to do: give object (to assign the appearance) and/or create");
  const onTaken = raw.on_taken === undefined ? "refuse" : (FILTER_ON_TAKEN as readonly string[]).includes(String(raw.on_taken)) ? (raw.on_taken as "refuse" | "update") : (v.fail(`on_taken must be one of ${FILTER_ON_TAKEN.join(", ")}`), "refuse");
  if (raw.on_taken !== undefined && spec === undefined) v.fail("on_taken is only for create");
  if (raw.on_name_taken !== undefined && !(ON_NAME_TAKEN as readonly string[]).includes(String(raw.on_name_taken))) v.fail(`on_name_taken must be one of ${ON_NAME_TAKEN.join(", ")}`);
  const onNameTaken: OnNameTaken = raw.on_name_taken === "allow_suffix" ? "allow_suffix" : "refuse";
  const target = { ...(object ? { object } : {}), appearance: raw.appearance };
  if (!v.ok || !appRef) return validationFailure("set_appearance", target, v.errors);

  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const preview = raw.preview === true;
  const verify = raw.verify !== false;
  const warnings: string[] = [];
  const APP_FIELDS = ["Image", "ImageMode", "BackR", "BackG", "BackB", "BackAlpha"];

  const body = async (): Promise<OperationResult> => {
    const steps: StepResult[] = [];
    const done = (extra: Record<string, unknown> = {}, verification?: Verification, summary?: string) => buildResult({ operation: "set_appearance", target, steps, warnings, verification, summary, extra });

    // The object that shows it.
    let objBefore: PoolState | undefined;
    if (object) {
      const o = await readStepOf("read_object", "objects", () => readOne(bridge, object, ["Appearance"]));
      steps.push(o.step);
      if (!o.value) return done();
      objBefore = o.value;
      if (!objBefore.exists) {
        steps.push(refuse("check_object", `${object} does not exist; nothing was sent`));
        return done();
      }
      // The assignment is sent with the reference as given: it must name exactly the object that is checked (#161 review).
      if (objBefore.total !== 1) {
        steps.push(refuse("check_object", objBefore.total === undefined ? `how many objects ${object} names could not be read; nothing was sent` : `${object} names ${objBefore.total} objects; give one object (by number); nothing was sent`));
        return done();
      }
      if (objBefore.locked !== false) {
        steps.push(refuse("check_object", objBefore.locked ? `${object} is locked; nothing was sent` : `the Lock of ${object} could not be read; nothing was sent`));
        return done();
      }
    }

    // The appearance.
    const a = await readStepOf("read_appearance", "objects", () => readOne(bridge, appRef!, APP_FIELDS));
    steps.push(a.step);
    if (!a.value) return done();
    const appBefore = a.value;
    if (appBefore.exists && appBefore.total !== 1) {
      steps.push(refuse("check_appearance", appBefore.total === undefined ? `how many appearances ${appRef} names could not be read; nothing was sent` : `${appRef} names ${appBefore.total} appearances; give it by number; nothing was sent`));
      return done();
    }
    if (!spec && !appBefore.exists) {
      steps.push(refuse("check_appearance", `${appRef} does not exist; give create to make it; nothing was sent`));
      return done();
    }
    if (spec && appBefore.exists) {
      if (onTaken === "refuse") {
        steps.push(refuse("check_appearance", `${appRef} is taken ("${appBefore.name ?? ""}"); pass on_taken "update" to change it, or choose a free number (gma3_pool_details kind appearances lists them); nothing was sent`));
        return done();
      }
      if (appBefore.locked !== false) {
        steps.push(refuse("check_appearance", appBefore.locked ? `${appRef} is locked; nothing was sent` : `the Lock of ${appRef} could not be read; nothing was sent`));
        return done();
      }
    }
    steps.push(asRead({ name: "check_appearance", status: "succeeded", detail: { exists: appBefore.exists, ...(appBefore.name ? { name: appBefore.name } : {}) } }));

    // The image.
    let imageName: string | undefined;
    if (spec?.image) {
      const i = await readStepOf("read_image", "objects", () => readOne(bridge, spec!.image!, []));
      steps.push(i.step);
      if (!i.value) return done();
      if (!i.value.exists) {
        steps.push(refuse("check_image", `${spec.image} does not exist (gma3_image_add imports one); nothing was sent`));
        return done();
      }
      imageName = i.value.name;
    }

    if (spec?.name !== undefined && appNo !== undefined && !(appBefore.exists && appBefore.name === spec.name)) {
      const cache: PoolNameCache<string> = new Map();
      const r = await checkPoolName({ bridge, t, pool: { ref: "ShowData.Appearances", noun: "appearance", plural: "appearances", label: (n) => `Appearance ${n}` }, cache, number: appNo, name: spec.name, onNameTaken, warnings, keepOwn: true });
      steps.push(asRead({ name: "check_name", status: r.status, op: "children", detail: r.detail, ...(r.error ? { error: r.error } : {}) }));
      if (r.status !== "succeeded") return done();
    }

    const plan: Planned[] = [];
    if (spec) {
      if (!appBefore.exists) plan.push({ name: "store", command: `Store ${appRef} /NoConfirmation`, dialogCheck: true });
      if (spec.name !== undefined && appBefore.name !== spec.name) plan.push({ name: "label", command: `Label ${appRef} ${quoteName(spec.name)}` });
      if (spec.rgb) (["BackR", "BackG", "BackB"] as const).forEach((p, i) => plan.push({ name: `set_${p.toLowerCase()}`, set: { ref: appRef!, property: p, value: String(spec!.rgb![i]) } }));
      if (spec.alpha !== undefined) plan.push({ name: "set_backalpha", set: { ref: appRef!, property: "BackAlpha", value: String(spec.alpha) } });
      if (spec.image) plan.push({ name: "assign_image", command: `Assign ${spec.image} At ${appRef}`, dialogCheck: true });
      if (spec.imageMode) plan.push({ name: "set_imagemode", set: { ref: appRef!, property: "ImageMode", value: spec.imageMode } });
    }
    if (object) plan.push({ name: "assign", command: `Assign ${appRef} At ${object}`, dialogCheck: true });

    const extra: Record<string, unknown> = { appearance: { exists: appBefore.exists, ...(appBefore.name ? { name: appBefore.name } : {}) }, ...(objBefore ? { object: { name: objBefore.name, appearanceBefore: objBefore.fields.Appearance ?? null } } : {}) };
    if (preview) return done({ ...extra, preview: true, plan: planText(bridge, plan) }, undefined, `Preview only; nothing was sent (${plan.length} step(s) planned).`);
    const d0 = await dialogStep(bridge, "check_dialog", t);
    steps.push(d0);
    if (d0.status !== "succeeded") return done(extra);
    if (!(await sendPlan(bridge, plan, steps, t))) return done(extra);
    if (!verify) return done(extra);

    const checks: string[] = [];
    const problems: string[] = [];
    let unavailable: string | undefined;
    try {
      const after = await readOne(bridge, appRef!, APP_FIELDS);
      extra.after = { exists: after.exists, ...(after.name ? { name: after.name } : {}) };
      if (!after.exists) problems.push(`${appRef} does not exist`);
      else if (spec) {
        const num = (p: string) => (after.fieldErrors[p] !== undefined ? undefined : Number(after.fields[p]));
        if (spec.name !== undefined) {
          checks.push(`${appRef} is named "${spec.name}"`);
          if (after.name !== spec.name) {
            if (onNameTaken === "allow_suffix" && after.name && nameOrSuffixed(after.name, spec.name)) warnings.push(`${appRef} was named "${after.name}": the pool already had "${spec.name}"`);
            else problems.push(`${appRef} reads the name "${after.name ?? ""}"`);
          }
        }
        const nums: Array<[string, number | undefined]> = [...(spec.rgb ? (["BackR", "BackG", "BackB"] as const).map((p, i) => [p, spec!.rgb![i]] as [string, number]) : []), ...(spec.alpha !== undefined ? [["BackAlpha", spec.alpha] as [string, number]] : [])];
        for (const [p, w] of nums) {
          checks.push(`${p} ${w}`);
          const g = num(p);
          if (g === undefined || Number.isNaN(g)) throw new Error(`${p} of ${appRef} could not be read`);
          if (g !== w) problems.push(`${p} reads ${g}`);
        }
        if (spec.imageMode) {
          checks.push(`ImageMode ${spec.imageMode}`);
          if (String(after.fields.ImageMode ?? "").toLowerCase() !== spec.imageMode.toLowerCase()) problems.push(`ImageMode reads ${JSON.stringify(after.fields.ImageMode ?? null)}`);
        }
        if (spec.image) {
          checks.push(`its image is ${spec.image}${imageName ? ` ("${imageName}")` : ""}`);
          if (!imageName) throw new Error(`the name of ${spec.image} was not read, so the image of ${appRef} cannot be compared`);
          if (String(after.fields.Image ?? "") !== imageName) problems.push(`its Image reads ${JSON.stringify(after.fields.Image ?? null)}`);
        }
      }
      if (object && after.exists) {
        checks.push(`${object} shows ${appRef}`);
        // By handle: two appearances may share a name.
        const o = await readOne(bridge, object, ["Appearance"], false);
        const h = o.fields.Appearance as { addr?: unknown; name?: unknown } | undefined;
        if (!o.exists) problems.push(`${object} no longer exists`);
        else if (o.fieldErrors.Appearance !== undefined) throw new Error(`the Appearance of ${object} could not be read (${String(o.fieldErrors.Appearance)})`);
        else if (!h || typeof h !== "object" || typeof h.addr !== "string") problems.push(`${object} reads no appearance`);
        else if (!after.addr) throw new Error(`the address of ${appRef} was not read, so the assignment cannot be compared`);
        else if (h.addr !== after.addr) problems.push(`${object} shows ${typeof h.name === "string" ? `"${h.name}"` : "another appearance"}`);
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

const DETAILS_DESCRIPTION =
  "Read-only. The show's filters, worlds, appearances or views (kind), decoded: a filter's or world's attributes (all, or the feature groups it passes fully and the attribute names), a filter's value layers (absolute, relative, timing, phaser) and whether it has dynamic filter rules; an appearance's background colour (#RRGGBB, alpha 0-255), image and image mode; a view's windows and their grid position (views of the current user profile). range narrows it (\"Filter 1 Thru 20\"; default every object of the pool).";

const STORE_FILTER_DESCRIPTION =
  'Store an attribute filter, or update one in place: the attributes it passes, by attribute name ("ColorRGB_R") and/or feature group ("Color", "Position"), minus exclude, and its value layers (absolute, relative, timing, phaser; a new filter passes all four unless layers says otherwise). A new filter is Store Filter <n> "name" /NoConfirmation (from the At Filter) and then gets its Attributes and layers written; a taken number is refused unless on_taken "update". Unknown names, a name another filter has (on_name_taken "allow_suffix" allows it), a locked filter and an open dialog are refused before anything is sent. Read back: the filter passes exactly the attributes asked for and the layers read as asked; dynamic filter rules the At Filter carried are reported. preview: true plans without sending. Filters are used with Store /Filter, sequences and presets (input/output filters) and sheet masks. ' +
  BATCH_NOTE;

const SET_APPEARANCE_DESCRIPTION =
  'Assign an appearance to a pool object ("Assign Appearance <n> At Group 3"), and/or create or change the appearance (create: {name, color "#RRGGBB", alpha percent (default 100 with a color), image "Image 3.2", image_mode Stretch|Bar|Crop|Tile|Center}). A new appearance is Store Appearance <n> /NoConfirmation; an existing one is changed only with on_taken "update". The image is assigned to the appearance (Assign Image 3.2 At Appearance <n>). A missing or locked object or appearance, a missing image, a taken name and an open dialog are refused before anything is sent; a dialog that opens after a command stops the rest. Read back: the background colour, alpha, image and image mode as asked, and the object shows this appearance (compared by handle). preview: true plans without sending. ' +
  BATCH_NOTE;

const filterShape = {
  filter: z.number().int(),
  name: z.string().optional(),
  attributes: z.array(z.string()).optional(),
  feature_groups: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  layers: z.object({ absolute: z.boolean().optional(), relative: z.boolean().optional(), timing: z.boolean().optional(), phaser: z.boolean().optional() }).optional(),
  on_taken: z.enum(FILTER_ON_TAKEN).optional(),
  on_name_taken: z.enum(ON_NAME_TAKEN).optional(),
};

const createShape = z
  .object({ name: z.string().optional(), color: z.string().optional(), alpha: z.number().optional(), image: z.string().optional(), image_mode: z.string().optional() })
  .describe('Create or change the appearance: {name?, color? "#RRGGBB", alpha? percent, image? "Image 3.2", image_mode? Stretch|Bar|Crop|Tile|Center}.');

const appearanceShape = {
  object: z.string().optional(),
  appearance: z.union([z.number().int(), z.string()]),
  create: createShape.optional(),
  on_taken: z.enum(FILTER_ON_TAKEN).optional(),
  on_name_taken: z.enum(ON_NAME_TAKEN).optional(),
};

/** The appearance an item names, canonical (20, "20", " 020 " are one; a name case aside). */
export function appearanceRef(it: Record<string, unknown>): string {
  const s = String(it.appearance).trim();
  return `appearance ${/^\d+$/.test(s) ? String(Number(s)) : s.replace(/^"|"$/g, "").toLowerCase()}`;
}

/** The object an item names, canonical: numbers without leading zeros outside a quoted name, keyword case aside. */
export function objectRef(object: unknown): string {
  let s: string;
  try {
    s = parseTargetObject("object", object);
  } catch {
    s = String(object).trim();
  }
  return s.replace(/("[^"]*")|\d+/g, (m, q) => q ?? String(Number(m))).replace(/^\w+/, (w) => w.toLowerCase());
}

/** The appearance an item writes (canonical), when it creates or changes one. */
export function appearanceKey(it: Record<string, unknown>): string | undefined {
  return it.create === undefined ? undefined : appearanceRef(it);
}

export const registerWorldFilterTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_pool_details",
    {
      title: "Read filters, worlds, appearances or views",
      description: DETAILS_DESCRIPTION,
      inputSchema: {
        kind: z.enum(DETAIL_KINDS).describe("filters, worlds, appearances or views."),
        range: z.string().optional().describe('A range of that pool, e.g. "Filter 1 Thru 20" (default: the whole pool).'),
        limit: z.number().int().optional().describe("Most objects returned (default 200, max 1000)."),
        windows: z.boolean().optional().describe("views: list each view's windows (default true, first 30 views)."),
      },
    },
    async (args) => operation(() => poolDetails(ctx, args)),
  );

  server.registerTool(
    "gma3_store_filter",
    {
      title: "Store or update attribute filters",
      description: STORE_FILTER_DESCRIPTION,
      inputSchema: {
        filter: z.number().int().optional().describe("The filter number. Required unless filters is given."),
        name: z.string().optional().describe("The filter's name."),
        attributes: z.array(z.string()).optional().describe('Attribute names it passes, e.g. ["Dimmer", "ColorRGB_R"].'),
        feature_groups: z.array(z.string()).optional().describe('Feature groups it passes in full, e.g. ["Color", "Position"].'),
        exclude: z.array(z.string()).optional().describe("Attribute names taken out of attributes and feature_groups."),
        layers: filterShape.layers.describe("Value layers it passes: {absolute, relative, timing, phaser} (a new filter: true unless false here)."),
        on_taken: z.enum(FILTER_ON_TAKEN).optional().describe('A taken number: "refuse" (default) or "update" (change that filter in place).'),
        on_name_taken: z.enum(ON_NAME_TAKEN).optional().describe('A name another filter has: "refuse" (default) or "allow_suffix".'),
        preview: z.boolean().optional().describe("Read and plan only; nothing is sent."),
        verify: z.boolean().optional().describe("Read back (default true)."),
        filters: z.array(z.object(filterShape)).optional().describe("Batch form: several filters, each {filter, name?, attributes?, feature_groups?, exclude?, layers?, on_taken?, on_name_taken?}."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).filters !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "store_filter",
              listKey: "filters",
              identityKeys: ["filter", "name"],
              label: (it) => `Filter ${String(it.filter)}`,
              key: (it) => `filter ${String(it.filter)}`,
              check: (items) => duplicates(items.map((it) => `Filter ${String(it.filter)}`)).map((x) => `${x} is in more than one item`),
              run: (it, c) => storeFilter(c, it as StoreFilterArgs),
            })
          : storeFilter(ctx, args as StoreFilterArgs),
      ),
  );

  server.registerTool(
    "gma3_set_appearance",
    {
      title: "Create appearances and assign them to pool objects",
      description: SET_APPEARANCE_DESCRIPTION,
      inputSchema: {
        object: z.string().optional().describe('The object that shows the appearance: "Group 3", "Sequence 5", "Macro 2", "Preset 4.12", ...'),
        appearance: z.union([z.number().int(), z.string()]).optional().describe("The appearance: a number, or the name of an existing one. Required unless assignments is given."),
        create: createShape.optional(),
        on_taken: z.enum(FILTER_ON_TAKEN).optional().describe('create on a taken appearance number: "refuse" (default) or "update" (change it).'),
        on_name_taken: z.enum(ON_NAME_TAKEN).optional().describe('A name another appearance has: "refuse" (default) or "allow_suffix".'),
        preview: z.boolean().optional().describe("Read and plan only; nothing is sent."),
        verify: z.boolean().optional().describe("Read back (default true)."),
        assignments: z.array(z.object(appearanceShape)).optional().describe("Batch form: several items, each {object?, appearance, create?, on_taken?, on_name_taken?}."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).assignments !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "set_appearance",
              listKey: "assignments",
              identityKeys: ["object", "appearance"],
              label: (it) => `${it.object !== undefined ? `${String(it.object)} <- ` : ""}Appearance ${String(it.appearance)}`,
              key: (it) => (it.object !== undefined ? objectRef(it.object) : appearanceKey(it)),
              keys: (it) => {
                const k = appearanceKey(it);
                return k && it.object !== undefined ? [k] : [];
              },
              // An assignment uses the appearance: it is skipped when an earlier item creating or changing it failed (#161 review).
              depends: (it) => (it.create === undefined ? [appearanceRef(it)] : []),
              check: (items) => duplicates(items.map(appearanceKey).filter((x): x is string => x !== undefined)).map((x) => `${x} is created or changed by more than one item`),
              run: (it, c) => setAppearance(c, it as SetAppearanceArgs),
            })
          : setAppearance(ctx, args as SetAppearanceArgs),
      ),
  );
};
