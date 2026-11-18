/**
 * #146: Layouts, the 2D views of the Layout pool (DataPool.Layouts) where groups, sequences, macros, presets and other
 * pool objects sit as elements for touch busking.
 *
 * What is known (onPC 2.5.1.1, 2026-11-17, read-only, and MA's own resources shipped with the console):
 *
 *   - Layout 1 "Default" is class Layout with layout-level properties (PositionX/Y, DimensionW/H, RenderStyle, ...);
 *     its elements are its children.
 *   - MA's system test lib_plugins/systemtests/db/system_test_layout_copy_element.lua builds an element with
 *     `Assign Sequence 1 At <layout>` (the element becomes the layout's last child) and sets PositionX/Y, Width, Height,
 *     Action, Appearance, CustomTextText, CustomTextColor on it; system_test_helping_functions_layout.lua sets POSX,
 *     POSY, WIDTH, HEIGHT, CUSTOMTEXT*, VISIBILITYOBJECTNAME / VISIBILITYBORDER ("Visible" / "Hidden") in Lua.
 *   - The element editor (lib_menus/ui/editors/layout_element_editor.uixml) edits Object, Action, Appearance, PosX, PosY,
 *     Width, Height, CustomTextText/Size/Color/AlignmentH/AlignmentV, Visibility* and Name.
 *
 * Not probed on a console: that Assign onto an empty layout slot creates the layout (the manual says so for fixtures
 * assigned from the pool), and how each Visibility* property reads back. The tool therefore reads everything back and
 * never claims a match it did not see.
 *
 *   gma3_layouts       read-only: the Layout pool, or one layout's elements (object, position, size, text, visibility)
 *   gma3_store_layout  create (or append to, or rebuild) a layout from a list of elements and/or a grid of a range
 *
 * No new bridge op: Assign / Delete go through cmd, element properties through set (both refused while another client
 * owns input), reads through objects and children (asText false gives the element's Object as {class, name, addr}).
 */
import { z } from "zod";
import { asRead, buildResult, commandStep, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { readObjects } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { checkPoolName, ON_NAME_TAKEN, type OnNameTaken, type PoolNameCache, nameOrSuffixed } from "./poolnames.js";

/** Pool keywords an element may show (one object per element). */
const KEYWORDS: Record<string, string> = {
  group: "Group",
  sequence: "Sequence",
  seq: "Sequence",
  macro: "Macro",
  preset: "Preset",
  matricks: "MAtricks",
  quickey: "Quickey",
  world: "World",
  view: "View",
  plugin: "Plugin",
  fixture: "Fixture",
  timecode: "Timecode",
  timer: "Timer",
};

export const MAX_ELEMENTS = 200;
const ALIGN_H = ["Left", "Center", "Right", "OutsideLeft", "OutsideRight"] as const;
const ALIGN_V = ["Top", "Center", "Bottom", "Above", "Below"] as const;
const TEXT_SIZES = ["Default", "10", "12", "14", "16", "18", "20", "24", "28", "32"] as const;

/** Highest object number per keyword: pool objects go to 9999, fixture IDs further. */
const maxNumber = (keyword: string) => (keyword === "Fixture" ? 99999999 : 9999);

/** A parsed number, refused unless it is a whole number from 1 to `max` (no Infinity or unsafe integers). */
function objectNumber(text: string, what: string, max: number): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${what}: ${text.length > 12 ? `${text.slice(0, 12)}...` : text} is not a number from 1 to ${max}`);
  return n;
}

/** A parsed element object: the command-line reference the Assign uses. */
export interface ObjectRef {
  keyword: string;
  ref: string;
}

/** "Group 5", "seq 3", "Preset 4.12", "Fixture 101" or "Fixture 101.3" -> its command-line reference. */
export function parseObject(raw: string): ObjectRef {
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`${JSON.stringify(raw)} is not one object ("Group 5", "Sequence 3", "Preset 4.12", "Fixture 101"); give one object per element, ranges go in grid.objects`);
  const keyword = KEYWORDS[m[1].toLowerCase()];
  if (!keyword) throw new Error(`${JSON.stringify(raw)}: ${m[1]} is not an object a layout element shows here (${[...new Set(Object.values(KEYWORDS))].join(", ")})`);
  const a = objectNumber(m[2], JSON.stringify(raw), keyword === "Preset" ? 9999 : maxNumber(keyword));
  const b = m[3] !== undefined ? objectNumber(m[3], JSON.stringify(raw), 9999) : undefined;
  if (keyword === "Preset") {
    if (b === undefined) throw new Error(`${JSON.stringify(raw)}: a preset is "Preset <pool>.<number>", e.g. "Preset 4.12"`);
    return { keyword, ref: `Preset ${a}.${b}` };
  }
  if (b !== undefined && keyword !== "Fixture") throw new Error(`${JSON.stringify(raw)}: ${keyword} takes a whole number`);
  return { keyword, ref: `${keyword} ${a}${b !== undefined ? `.${b}` : ""}` };
}

/** "Sequence 1 Thru 12" / "Preset 4.1 Thru 4.8" / "Group 3 + 5 + 9" -> the single references, in order. */
export function expandRange(raw: string): ObjectRef[] {
  const s = raw.trim();
  const thru = s.match(/^([A-Za-z]+)\s+(\d+)(?:\.(\d+))?\s+thru\s+(?:(\d+)\.)?(\d+)$/i);
  if (thru) {
    const keyword = KEYWORDS[thru[1].toLowerCase()];
    if (!keyword) throw new Error(`grid.objects: ${thru[1]} is not an object a layout element shows here`);
    const isPreset = keyword === "Preset";
    if (isPreset && thru[3] === undefined) throw new Error('grid.objects: a preset range is "Preset <pool>.<a> Thru <b>" (or Thru <pool>.<b>)');
    if (!isPreset && (thru[3] !== undefined || thru[4] !== undefined)) throw new Error(`grid.objects: a ${keyword} range is "${keyword} <a> Thru <b>"`);
    // Every number is a bounded safe integer before the loop below counts from one to the other.
    const max = isPreset ? 9999 : maxNumber(keyword);
    const pool = objectNumber(thru[2], "grid.objects", max);
    if (isPreset && thru[4] !== undefined && objectNumber(thru[4], "grid.objects", 9999) !== pool) throw new Error("grid.objects: a preset range stays in one preset pool");
    const from = isPreset ? objectNumber(thru[3], "grid.objects", 9999) : pool;
    const to = objectNumber(thru[5], "grid.objects", max);
    if (to < from) throw new Error("grid.objects: the range must go upwards");
    if (to - from + 1 > MAX_ELEMENTS) throw new Error(`grid.objects: at most ${MAX_ELEMENTS} objects`);
    const out: ObjectRef[] = [];
    for (let n = from; n <= to; n++) out.push({ keyword, ref: isPreset ? `Preset ${pool}.${n}` : `${keyword} ${n}` });
    return out;
  }
  if (s.includes("+")) {
    const parts = s.split("+").map((p) => p.trim());
    const first = parseObject(parts[0]);
    const pool = first.keyword === "Preset" ? first.ref.split(" ")[1].split(".")[0] : "";
    const rest = parts.slice(1).map((p) => {
      if (/^[A-Za-z]/.test(p)) return parseObject(p);
      if (first.keyword === "Preset") return parseObject(`Preset ${p.includes(".") ? p : `${pool}.${p}`}`);
      return parseObject(`${first.keyword} ${p}`);
    });
    if (1 + rest.length > MAX_ELEMENTS) throw new Error(`grid.objects: at most ${MAX_ELEMENTS} objects`);
    return [first, ...rest];
  }
  return [parseObject(s)];
}

export interface ElementArgs {
  object: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  name?: string;
  action?: string;
  appearance?: string;
  show_name?: boolean;
  show_id?: boolean;
  border?: boolean;
  bar?: boolean;
  value?: boolean;
  text_size?: string;
  text_color?: string;
  align_h?: string;
  align_v?: string;
}

interface GridArgs {
  objects: string;
  columns: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  gap?: number;
  skip_missing?: boolean;
}

export interface StoreLayoutArgs {
  layout: number;
  name?: string;
  on_name_taken?: OnNameTaken;
  elements?: ElementArgs[];
  grid?: GridArgs;
  overwrite?: boolean;
  append?: boolean;
  preview?: boolean;
}

/** Element property -> console property, how it is written and how a read-back is compared. */
interface PropSpec {
  key: keyof ElementArgs;
  prop: string;
  kind: "number" | "text" | "bool" | "color" | "enum";
}
const PROPS: PropSpec[] = [
  { key: "x", prop: "PosX", kind: "number" },
  { key: "y", prop: "PosY", kind: "number" },
  { key: "width", prop: "Width", kind: "number" },
  { key: "height", prop: "Height", kind: "number" },
  { key: "name", prop: "Name", kind: "text" },
  { key: "text", prop: "CustomTextText", kind: "text" },
  { key: "action", prop: "Action", kind: "enum" },
  { key: "appearance", prop: "Appearance", kind: "text" },
  { key: "show_name", prop: "VisibilityObjectName", kind: "bool" },
  { key: "show_id", prop: "VisibilityID", kind: "bool" },
  { key: "border", prop: "VisibilityBorder", kind: "bool" },
  { key: "bar", prop: "VisibilityBar", kind: "bool" },
  { key: "value", prop: "VisibilityValue", kind: "bool" },
  { key: "text_size", prop: "CustomTextSize", kind: "enum" },
  { key: "text_color", prop: "CustomTextColor", kind: "color" },
  { key: "align_h", prop: "CustomTextAlignmentH", kind: "enum" },
  { key: "align_v", prop: "CustomTextAlignmentV", kind: "enum" },
];
/** Read with asText false: the object as {class, name, addr}, the geometry as numbers. */
const RAW_FIELDS = ["Object", "PosX", "PosY", "Width", "Height"];
/** Read as display text. */
const TEXT_FIELDS = ["Name", "CustomTextText", "Action", "Appearance", "VisibilityObjectName", "VisibilityID", "VisibilityBorder", "VisibilityBar", "VisibilityValue", "CustomTextSize", "CustomTextColor", "CustomTextAlignmentH", "CustomTextAlignmentV"];

const written = (spec: PropSpec, v: unknown): string => {
  if (spec.kind === "bool") return v ? "Visible" : "Hidden";
  if (spec.kind === "color") return String(v).toUpperCase();
  return String(v);
};

/** "Visible" / "On" / "Yes" -> true, "Hidden" / "Off" / "No" -> false, anything else null. */
export function visibility(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (/^(visible|on|yes|true|1)$/.test(s)) return true;
  if (/^(hidden|off|no|false|0)$/.test(s)) return false;
  return null;
}

/** Whether a read-back value is the one asked for. */
export function propMatches(spec: PropSpec, want: unknown, got: unknown): boolean {
  if (got === undefined || got === null) return false;
  switch (spec.kind) {
    case "number":
      return Number(got) === Number(want);
    case "bool":
      return visibility(got) === want;
    case "color":
      return String(got).trim().replace(/^#/, "").toUpperCase() === String(want).replace(/^#/, "").toUpperCase();
    case "text":
      // The bridge trims what it reads back.
      return String(got).trim() === String(want).trim();
    default:
      return String(got).trim().toLowerCase() === String(want).trim().toLowerCase();
  }
}

/** One element as read: index, its object and properties. */
export interface ElementRead {
  index: number;
  addr?: string;
  class?: string;
  object?: { class?: string; name?: string; addr?: string } | null;
  props: Record<string, unknown>;
  fieldErrors?: Record<string, unknown>;
}

type ChildItem = { name?: string; class?: string; addr?: string; index?: number; invalid?: boolean; fields?: Record<string, unknown>; fieldErrors?: Record<string, unknown> };
type ChildList = { total?: number; items?: ChildItem[]; enumerationError?: unknown };

const PAGE = 500;

/** Read a layout's elements from `offset` on (all by default): two children reads per page, merged by position. */
export async function readElements(ctx: ToolContext, layout: number, from = 0, t = ctx.requestTimeoutMs): Promise<{ total: number; elements: ElementRead[]; complete: boolean; error?: string }> {
  const elements: ElementRead[] = [];
  let total = 0;
  for (let offset = from; ; offset += PAGE) {
    const raw = (await ctx.bridge.request("children", { ref: `Layout ${layout}`, fields: RAW_FIELDS, asText: false, limit: PAGE, offset }, t)) as ChildList;
    const text = (await ctx.bridge.request("children", { ref: `Layout ${layout}`, fields: TEXT_FIELDS, limit: PAGE, offset }, t)) as ChildList;
    for (const r of [raw, text]) {
      if (r?.enumerationError !== undefined && r.enumerationError !== null) return { total, elements, complete: false, error: `the elements of Layout ${layout} could not be listed: ${String(r.enumerationError)}` };
    }
    total = Number(raw?.total ?? 0);
    const ri = raw?.items ?? [];
    const ti = text?.items ?? [];
    if (ri.length !== ti.length || Number(text?.total ?? 0) !== total) return { total, elements, complete: false, error: `Layout ${layout} changed while it was read (${ri.length} / ${ti.length} elements)` };
    ri.forEach((item, i) => {
      const t2 = ti[i];
      const obj = item.fields?.Object as { class?: string; name?: string; addr?: string } | undefined;
      const props: Record<string, unknown> = {};
      for (const k of RAW_FIELDS.slice(1)) if (item.fields?.[k] !== undefined) props[k] = item.fields[k];
      for (const k of TEXT_FIELDS) if (t2?.fields?.[k] !== undefined) props[k] = t2.fields[k];
      const errs = { ...(item.fieldErrors ?? {}), ...(t2?.fieldErrors ?? {}) };
      elements.push({
        index: offset + i + 1,
        addr: item.addr,
        class: item.class,
        object: obj && typeof obj === "object" ? { class: obj.class, name: obj.name, addr: obj.addr } : null,
        props,
        ...(Object.keys(errs).length ? { fieldErrors: errs } : {}),
      });
    });
    if (ri.length < PAGE || offset + ri.length >= total) break;
  }
  return { total, elements, complete: elements.length === Math.max(0, total - from) };
}

const LAYOUT_POOL = { ref: "DataPool.Layouts", noun: "layout", plural: "layouts", label: (n: number) => `Layout ${n}` };

interface PlannedElement {
  source: "elements" | "grid";
  args: ElementArgs;
  ref: string;
  /** The object as the pre-check read it. */
  target?: { class?: string; name?: string; addr?: string };
}

function checkElement(e: ElementArgs, where: string, errors: string[]): void {
  for (const k of ["x", "y"] as const) if (e[k] !== undefined && (!Number.isInteger(e[k]) || Math.abs(e[k]!) > 32000)) errors.push(`${where}.${k} must be a whole number from -32000 to 32000`);
  for (const k of ["width", "height"] as const) if (e[k] !== undefined && (!Number.isInteger(e[k]) || e[k]! < 1 || e[k]! > 32000)) errors.push(`${where}.${k} must be a whole number from 1 to 32000`);
  for (const k of ["text", "name", "appearance"] as const) {
    const v = e[k];
    if (v !== undefined && (v.length > 256 || /["\u0000-\u001f]/.test(v) || (k !== "text" && v === ""))) errors.push(`${where}.${k} must be ${k === "text" ? "" : "1 to "}256 characters without quotes or control characters`);
  }
  if (e.action !== undefined && !/^[A-Za-z][A-Za-z0-9+\- ]{0,40}$/.test(e.action)) errors.push(`${where}.action must be an action name such as "Go+", "Toggle", "SelectFixtures"`);
  if (e.text_color !== undefined && !/^#?[0-9A-Fa-f]{8}$/.test(e.text_color)) errors.push(`${where}.text_color must be RRGGBBAA hex, e.g. "FFFFFFFF"`);
  if (e.text_size !== undefined && !TEXT_SIZES.includes(String(e.text_size) as (typeof TEXT_SIZES)[number])) errors.push(`${where}.text_size must be one of ${TEXT_SIZES.join(", ")}`);
  if (e.align_h !== undefined && !ALIGN_H.some((a) => a.toLowerCase() === e.align_h!.toLowerCase())) errors.push(`${where}.align_h must be one of ${ALIGN_H.join(", ")}`);
  if (e.align_v !== undefined && !ALIGN_V.some((a) => a.toLowerCase() === e.align_v!.toLowerCase())) errors.push(`${where}.align_v must be one of ${ALIGN_V.join(", ")}`);
}

/** The grid's elements: row-major from (x, y), each width x height, gap apart; y grows downwards as rows are added. */
export function gridElements(g: GridArgs, refs: ObjectRef[]): ElementArgs[] {
  const w = g.width ?? 100;
  const h = g.height ?? 100;
  const gap = g.gap ?? 10;
  const x0 = g.x ?? 0;
  const y0 = g.y ?? 0;
  return refs.map((r, i) => ({ object: r.ref, x: x0 + (i % g.columns) * (w + gap), y: y0 - Math.floor(i / g.columns) * (h + gap), width: w, height: h }));
}

export async function storeLayout(ctx: ToolContext, a: StoreLayoutArgs): Promise<OperationResult> {
  const op = "store_layout";
  const errors: string[] = [];
  if (!Number.isInteger(a.layout) || a.layout < 1 || a.layout > 9999) errors.push("layout must be an integer from 1 to 9999");
  if (a.name !== undefined && (a.name === "" || a.name.length > 128 || /["\u0000-\u001f]/.test(a.name))) errors.push("name must be 1 to 128 characters without quotes or control characters");
  if (a.overwrite && a.append) errors.push("overwrite (rebuild the layout) and append (add to it) exclude each other");
  if (!a.elements?.length && !a.grid) errors.push("give elements and/or grid: a layout is built from at least one element");
  const planned: PlannedElement[] = [];
  (a.elements ?? []).forEach((e, i) => {
    checkElement(e, `elements[${i}]`, errors);
    try {
      planned.push({ source: "elements", args: e, ref: parseObject(e.object).ref });
    } catch (err) {
      errors.push(`elements[${i}].object: ${(err as Error).message}`);
    }
  });
  let gridRefs: ObjectRef[] = [];
  if (a.grid) {
    const g = a.grid;
    if (!Number.isInteger(g.columns) || g.columns < 1 || g.columns > 100) errors.push("grid.columns must be a whole number from 1 to 100");
    checkElement({ object: "", x: g.x, y: g.y, width: g.width, height: g.height }, "grid", errors);
    if (g.gap !== undefined && (!Number.isInteger(g.gap) || g.gap < 0 || g.gap > 1000)) errors.push("grid.gap must be a whole number from 0 to 1000");
    try {
      gridRefs = expandRange(g.objects);
    } catch (err) {
      errors.push((err as Error).message);
    }
    // The positions the grid generates obey the same bounds as explicit elements (#159 review). The full range is
    // checked: skip_missing only closes the grid up, so its positions are a subset of these.
    if (!errors.length && gridRefs.length) {
      const before = errors.length;
      gridElements(g, gridRefs).forEach((e, i) => {
        if (errors.length - before < 3) checkElement(e, `grid element ${i + 1} (${e.object})`, errors);
      });
    }
  }
  if ((a.elements?.length ?? 0) + gridRefs.length > MAX_ELEMENTS) errors.push(`at most ${MAX_ELEMENTS} elements per call`);
  const target: Record<string, unknown> = { layout: a.layout, ...(a.name !== undefined ? { name: a.name } : {}) };
  if (errors.length) return validationFailure(op, target, errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    const warnings: string[] = [];
    const stop = (step: StepResult, why = "nothing was sent") => {
      steps.push(step);
      return buildResult({ operation: op, target, steps, verification: unavailable(why), warnings });
    };

    // The layout slot.
    let existing: { name?: string } | null = null;
    try {
      const r = await readObjects(ctx.bridge, `Layout ${a.layout}`, ["Name"], 1);
      const item = r?.items?.[0];
      existing = item && !item.invalid ? { name: String(item.fields?.Name ?? item.name ?? "") } : null;
    } catch (err) {
      return stop(asRead(stepFromError("check_layout", err, { op: "objects" })));
    }
    if (existing && !a.overwrite && !a.append) return stop(asRead({ name: "check_layout", status: "failed", op: "objects", error: `Layout ${a.layout} exists (${JSON.stringify(existing.name)}); pass overwrite: true to rebuild it or append: true to add elements to it, or choose a free number` }));
    steps.push(asRead({ name: "check_layout", status: "succeeded", op: "objects", detail: { exists: Boolean(existing), ...(existing ? { name: existing.name } : {}) } }));

    // The name.
    if (a.name !== undefined) {
      const cache: PoolNameCache<string> = new Map();
      const chk = await checkPoolName({ bridge: ctx.bridge, t, pool: LAYOUT_POOL, cache, number: a.layout, name: a.name, onNameTaken: a.on_name_taken ?? "refuse", warnings, keepOwn: true });
      steps.push(asRead({ name: "check_name", status: chk.status, op: "children", detail: chk.detail, ...(chk.error ? { error: chk.error } : {}) }));
      if (chk.status !== "succeeded") return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent"), warnings });
    }

    // Every object: one read each, in order.
    const missing: string[] = [];
    for (const r of gridRefs) planned.push({ source: "grid", args: { object: r.ref }, ref: r.ref });
    for (const p of planned) {
      try {
        const r = await readObjects(ctx.bridge, p.ref, ["Name"], 1);
        const item = r?.items?.[0];
        if (!item || item.invalid) missing.push(p.ref);
        else p.target = { class: item.class, name: item.name, addr: item.addr };
      } catch (err) {
        return stop(asRead(stepFromError("check_objects", err, { op: "objects" })));
      }
    }
    const missingExplicit = planned.filter((p) => p.source === "elements" && !p.target).map((p) => p.ref);
    const missingGrid = planned.filter((p) => p.source === "grid" && !p.target).map((p) => p.ref);
    if (missingExplicit.length || (missingGrid.length && !a.grid?.skip_missing)) {
      return stop(asRead({ name: "check_objects", status: "failed", op: "objects", error: `${[...missingExplicit, ...missingGrid].join(", ")} ${missingExplicit.length + missingGrid.length === 1 ? "does" : "do"} not exist${missingGrid.length ? "; pass grid.skip_missing: true to leave a range's empty numbers out" : ""}; nothing was sent`, detail: { missing: [...missingExplicit, ...missingGrid] } }));
    }
    const build = planned.filter((p) => p.target);
    // The grid is laid out over the objects that exist: a skipped number leaves no hole.
    if (a.grid) {
      const cells = build.filter((p) => p.source === "grid");
      const layoutOf = gridElements(a.grid, cells.map((p) => ({ keyword: "", ref: p.ref })));
      cells.forEach((p, i) => (p.args = layoutOf[i]));
    }
    if (missingGrid.length) warnings.push(`grid.objects: ${missingGrid.join(", ")} do not exist and were left out (skip_missing)`);
    if (!build.length) return stop(asRead({ name: "check_objects", status: "failed", op: "objects", error: "no object of the grid exists; nothing was sent" }));
    const unaddressed = build.filter((p) => !p.target?.addr).map((p) => p.ref);
    if (unaddressed.length) return stop(asRead({ name: "check_objects", status: "failed", op: "objects", error: `${unaddressed.join(", ")} read without an address, so the element could not be checked after the Assign; nothing was sent` }));
    steps.push(asRead({ name: "check_objects", status: "succeeded", op: "objects", detail: { objects: build.length, ...(missingGrid.length ? { skipped: missingGrid } : {}) } }));

    // Elements already there (append).
    let before = 0;
    if (existing && a.append) {
      try {
        const r = (await ctx.bridge.request("children", { ref: `Layout ${a.layout}`, limit: 1, offset: 0 }, t)) as ChildList;
        if (r?.enumerationError !== undefined && r.enumerationError !== null) return stop(asRead({ name: "check_elements", status: "failed", op: "children", error: `the elements of Layout ${a.layout} could not be listed: ${String(r.enumerationError)}; nothing was sent` }));
        before = Number(r?.total ?? 0);
      } catch (err) {
        return stop(asRead(stepFromError("check_elements", err, { op: "children" })));
      }
      steps.push(asRead({ name: "check_elements", status: "succeeded", op: "children", detail: { elements: before } }));
    }

    const plan = build.map((p) => `Assign ${p.ref} At Layout ${a.layout}`);
    if (a.preview) {
      return buildResult({
        operation: op,
        target,
        steps,
        verification: { status: "not_requested" },
        warnings,
        summary: `Preview: ${existing && a.overwrite ? `Delete Layout ${a.layout}, then ` : ""}${plan.length} element${plan.length === 1 ? "" : "s"} for Layout ${a.layout}; nothing was sent.`,
        extra: { preview: true, commands: [...(existing && a.overwrite ? [`Delete Layout ${a.layout} /NoConfirmation`] : []), ...plan], elements: build.map((p) => ({ ...p.args, object: p.ref })) },
      });
    }

    // Rebuild: the old layout goes first and must be gone.
    if (existing && a.overwrite) {
      const del = await commandStep(ctx.bridge, "delete_old", `Delete Layout ${a.layout} /NoConfirmation`, t);
      steps.push(del);
      if (del.status !== "succeeded") return buildResult({ operation: op, target, steps, verification: unavailable("the old layout could not be deleted; no element was added"), warnings });
      try {
        const r = await readObjects(ctx.bridge, `Layout ${a.layout}`, ["Name"], 1);
        const item = r?.items?.[0];
        if (item && !item.invalid) return stop(asRead({ name: "check_deleted", status: "failed", op: "objects", error: `Layout ${a.layout} is still there after the Delete; no element was added` }), "the old layout was not deleted");
      } catch (err) {
        return stop(asRead(stepFromError("check_deleted", err, { op: "objects" })), "whether the old layout is gone is unknown; no element was added");
      }
      steps.push(asRead({ name: "check_deleted", status: "succeeded", op: "objects" }));
    }

    // One Assign per element; the new element must be the layout's last child, showing the object, before its
    // properties are set. Anything else stops the call: the layout's state is no longer the planned one.
    let count = before;
    let stopped: string | undefined;
    const placed: Array<{ p: PlannedElement; index: number }> = [];
    for (let i = 0; i < build.length && !stopped; i++) {
      const p = build[i];
      const name = `element_${i + 1}`;
      const assign = await commandStep(ctx.bridge, `${name}_assign`, plan[i], t);
      if (assign.status !== "succeeded") {
        steps.push(assign);
        stopped = `the Assign of ${p.ref} did not succeed`;
        break;
      }
      let last: ElementRead | undefined;
      let total = 0;
      try {
        const r = await readElements(ctx, a.layout, count, t);
        total = r.total;
        if (!r.complete) throw new Error(r.error ?? "the new element could not be read");
        last = r.elements[r.elements.length - 1];
      } catch (err) {
        steps.push(assign, asRead(stepFromError(`${name}_check`, err, { op: "children" })));
        stopped = `the element for ${p.ref} could not be read after the Assign`;
        break;
      }
      if (total !== count + 1 || !last || last.object?.addr !== p.target!.addr) {
        steps.push(assign, asRead({ name: `${name}_check`, status: "failed", op: "children", error: `after Assign ${p.ref} Layout ${a.layout} has ${total} elements (expected ${count + 1}) and its last shows ${last?.object ? `${last.object.class ?? "?"} ${JSON.stringify(last.object.name ?? "")}` : "nothing"}, not ${p.ref}; the call stops here`, detail: { total, expected: count + 1, last } }));
        stopped = `the Assign of ${p.ref} did not add exactly one element showing it`;
        break;
      }
      count = total;
      placed.push({ p, index: total });
      // The Assign is its own (succeeded) step, so a property write that fails after it leaves a partial outcome,
      // never a failed one that hides the element it added (#159 review).
      steps.push({ ...assign, name: `${name}_assign`, detail: { object: p.ref, element: total } });
      // Properties: one set each on the element's address; the set op reads each back.
      const sets: Record<string, unknown> = {};
      const setErrors: string[] = [];
      for (const spec of PROPS) {
        const v = p.args[spec.key];
        if (v === undefined || spec.key === "object") continue;
        try {
          const res = (await ctx.bridge.request("set", { ref: last.addr, property: spec.prop, value: written(spec, v) }, t)) as { value?: unknown; readOk?: boolean };
          sets[spec.prop] = res?.value ?? null;
        } catch (err) {
          const s = stepFromError("set", err);
          setErrors.push(`${spec.prop}: ${s.error}`);
          if (s.status === "unknown") stopped = `the console did not answer setting ${spec.prop} of ${p.ref}'s element`;
        }
        if (stopped) break;
      }
      if (Object.keys(sets).length || setErrors.length) {
        steps.push({
          name: `${name}_set`,
          status: setErrors.length ? (stopped ? "unknown" : "failed") : "succeeded",
          op: "set",
          detail: { object: p.ref, element: total, ...(Object.keys(sets).length ? { set: sets } : {}) },
          ...(setErrors.length ? { error: setErrors.join("; ") } : {}),
        });
      }
    }

    // The layout's name.
    if (a.name !== undefined && !stopped) {
      try {
        const res = (await ctx.bridge.request("set", { ref: `Layout ${a.layout}`, property: "Name", value: a.name }, t)) as { value?: unknown };
        steps.push({ name: "name", status: "succeeded", op: "set", detail: { read: res?.value ?? null } });
      } catch (err) {
        steps.push(stepFromError("name", err, { op: "set" }));
      }
    }

    // Read back the whole layout and compare every placed element.
    const checked = `Layout ${a.layout} has ${before + build.length} elements; each new one shows its object (by address) and every asked property${a.name !== undefined ? "; the layout carries the name" : ""}`;
    let verification: Verification;
    let readBack: ElementRead[] | undefined;
    let layoutName: string | undefined;
    try {
      const r = await readElements(ctx, a.layout, 0, t);
      if (!r.complete) throw new Error(r.error ?? "incomplete read");
      readBack = r.elements;
      const ln = await readObjects(ctx.bridge, `Layout ${a.layout}`, ["Name"], 1);
      layoutName = ln?.items?.[0] ? String(ln.items[0].fields?.Name ?? ln.items[0].name ?? "") : undefined;
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "children", detail: { elements: r.total } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "children" })));
    }
    if (!readBack) verification = unavailable("the layout could not be read back", checked);
    else {
      const mismatches: string[] = [];
      if (readBack.length !== before + placed.length) mismatches.push(`Layout ${a.layout} has ${readBack.length} elements, expected ${before + placed.length}`);
      for (const { p, index } of placed) {
        const el = readBack[index - 1];
        if (!el) {
          mismatches.push(`element ${index} (${p.ref}) is missing`);
          continue;
        }
        if (el.object?.addr !== p.target!.addr) mismatches.push(`element ${index} shows ${el.object?.name ?? "nothing"}, not ${p.ref}`);
        for (const spec of PROPS) {
          const want = p.args[spec.key];
          if (want === undefined || spec.key === "object") continue;
          const got = el.props[spec.prop];
          if (el.fieldErrors?.[spec.prop] !== undefined) mismatches.push(`element ${index} (${p.ref}) ${spec.prop} could not be read (${String(el.fieldErrors[spec.prop])})`);
          else if (!propMatches(spec, want, got)) mismatches.push(`element ${index} (${p.ref}) ${spec.prop} reads ${JSON.stringify(got ?? null)}, asked ${JSON.stringify(written(spec, want))}`);
        }
      }
      if (a.name !== undefined) {
        const ok = layoutName !== undefined && (a.on_name_taken === "allow_suffix" ? nameOrSuffixed(layoutName, a.name) : layoutName.trim() === a.name);
        if (!ok) mismatches.push(`the layout is named ${JSON.stringify(layoutName ?? null)}, asked ${JSON.stringify(a.name)}`);
        else if (layoutName !== a.name) warnings.push(`the console named the layout ${JSON.stringify(layoutName)} (the name was taken)`);
      }
      if (stopped) mismatches.push(`stopped after ${placed.length} of ${build.length} elements: ${stopped}`);
      verification = mismatches.length ? { status: "mismatched", checked, detail: mismatches.join("; ") } : { status: "matched", checked };
    }
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings,
      summary: verification.status === "matched" ? `Layout ${a.layout}${layoutName ? ` "${layoutName}"` : ""}: ${placed.length} element${placed.length === 1 ? "" : "s"} added and read back.` : undefined,
      extra: { layout: a.layout, added: placed.length, ...(readBack ? { elements: readBack.length } : {}) },
    });
  });
}

/** gma3_layouts: the pool, or one layout's elements. */
export async function readLayouts(ctx: ToolContext, a: { layout?: number; offset?: number }): Promise<unknown> {
  if (a.layout === undefined) {
    const r = (await ctx.bridge.request("children", { ref: "DataPool.Layouts", fields: ["No", "Name"], limit: 10000 })) as ChildList;
    if (r?.enumerationError !== undefined && r.enumerationError !== null) throw new Error(`the Layout pool could not be listed: ${String(r.enumerationError)}`);
    return {
      layouts: (r.items ?? []).filter((i) => !i.invalid).map((i) => ({ no: Number(i.fields?.No ?? i.index), name: String(i.fields?.Name ?? i.name ?? ""), elements: (i as { childCount?: number }).childCount ?? null })),
      total: r.total ?? null,
    };
  }
  const exists = await readObjects(ctx.bridge, `Layout ${a.layout}`, ["Name"], 1);
  const item = exists?.items?.[0];
  if (!item || item.invalid) return { layout: a.layout, found: false };
  const r = await readElements(ctx, a.layout, a.offset ?? 0);
  return {
    layout: a.layout,
    found: true,
    name: String(item.fields?.Name ?? item.name ?? ""),
    total: r.total,
    complete: r.complete,
    ...(r.error ? { error: r.error } : {}),
    elements: r.elements,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const elementShape = z.object({
  object: z.string().describe('One object: "Group 5", "Sequence 3", "Macro 2", "Preset 4.12", "MAtricks 1", "Quickey 4", "World 1", "View 2", "Plugin 1", "Fixture 101", "Timecode 1", "Timer 1".'),
  x: z.number().int().optional().describe("PosX in layout units."),
  y: z.number().int().optional().describe("PosY in layout units (MA's own tools place rows downwards with smaller y)."),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  text: z.string().optional().describe("CustomTextText: a label on the element."),
  name: z.string().optional().describe("The element's own name."),
  action: z.string().optional().describe('What a tap does, e.g. "Go+", "Toggle", "Flash", "SelectFixtures" (default: the layout\'s default for the object).'),
  appearance: z.string().optional().describe("An appearance by name."),
  show_name: z.boolean().optional().describe("VisibilityObjectName."),
  show_id: z.boolean().optional().describe("VisibilityID."),
  border: z.boolean().optional().describe("VisibilityBorder."),
  bar: z.boolean().optional().describe("VisibilityBar."),
  value: z.boolean().optional().describe("VisibilityValue."),
  text_size: z.string().optional().describe(`CustomTextSize: ${TEXT_SIZES.join(", ")}.`),
  text_color: z.string().optional().describe('CustomTextColor, RRGGBBAA hex ("FFFFFFFF").'),
  align_h: z.string().optional().describe(`CustomTextAlignmentH: ${ALIGN_H.join(", ")}.`),
  align_v: z.string().optional().describe(`CustomTextAlignmentV: ${ALIGN_V.join(", ")}.`),
});

export const registerLayoutTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_layouts",
    {
      title: "List layouts and their elements",
      description:
        "Read-only. Without layout: the Layout pool (number, name, element count). With layout: its elements in order: index, the object each shows ({class, name, addr}), PosX, PosY, Width, Height, Name, CustomTextText, Action, Appearance, Visibility* and text settings, as the console reads them. Build layouts with gma3_store_layout.",
      inputSchema: {
        layout: z.number().int().min(1).max(9999).optional().describe("One layout's elements."),
        offset: z.number().int().min(0).optional().describe("Start at this element (0-based)."),
      },
    },
    async (args) => {
      try {
        return json(await readLayouts(ctx, args as { layout?: number; offset?: number }));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_store_layout",
    {
      title: "Build a layout view",
      description:
        `Build Layout <layout> (the 2D touch views of the Layout pool) from elements, each one pool object (group, sequence, macro, preset, MAtricks, quickey, world, view, plugin, fixture, timecode, timer) with optional position, size, label text, tap action, appearance, visibility and text settings; and/or grid: { objects: "Sequence 1 Thru 12", columns, x, y, width, height, gap } lays a range out row by row. At most ${MAX_ELEMENTS} elements per call. ` +
        "Pre-checks (nothing sent on failure): every object exists (grid.skip_missing leaves a range's empty numbers out), the layout slot is free unless overwrite: true (Delete Layout, then rebuild: its own settings are lost) or append: true (add after its elements), and the name is free in the pool (on_name_taken). " +
        "Each element is one Assign <object> At Layout <layout>; the new element must be the layout's last and show that object (by address) before its properties are set, else the call stops. Read-back: every element's object and asked properties, and the name. preview: true lists the commands and sends nothing. Read layouts with gma3_layouts.",
      inputSchema: {
        layout: z.number().int().min(1).max(9999).describe("Layout pool number."),
        name: z.string().optional().describe("The layout's name."),
        on_name_taken: z.enum(ON_NAME_TAKEN).optional().describe('Another layout has the name: "refuse" (default) or "allow_suffix".'),
        elements: z.array(elementShape).max(MAX_ELEMENTS).optional().describe("Elements in order."),
        grid: z
          .object({
            objects: z.string().describe('A range: "Sequence 1 Thru 12", "Preset 4.1 Thru 4.8", "Group 1 + 3 + 5".'),
            columns: z.number().int().describe("Elements per row."),
            x: z.number().int().optional().describe("Left of the first element (default 0)."),
            y: z.number().int().optional().describe("PosY of the first row (default 0); later rows go downwards (smaller y)."),
            width: z.number().int().optional().describe("Element width (default 100)."),
            height: z.number().int().optional().describe("Element height (default 100)."),
            gap: z.number().int().optional().describe("Space between elements (default 10)."),
            skip_missing: z.boolean().optional().describe("Leave out numbers of the range that are empty (default false: refuse)."),
          })
          .optional()
          .describe("Lay a range out as a grid, after the elements."),
        overwrite: z.boolean().optional().describe("Delete the existing layout and build it anew (default false: refuse)."),
        append: z.boolean().optional().describe("Add the elements to the existing layout."),
        preview: z.boolean().optional().describe("Report the commands; send nothing."),
      },
    },
    async (args) => operation(() => storeLayout(ctx, args as StoreLayoutArgs)),
  );
};
