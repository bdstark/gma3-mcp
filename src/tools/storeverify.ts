/**
 * Stored-value verification after a cue store (gma3_store_cue, gma3_store_cue_part, gma3_store_cues).
 *
 * Before the store, the programmer values the console is expected to store are captured; after it, the cue part is
 * read with GetPresetData (storedvalues.ts) and every expected value must be there with the same value.
 *
 * Console facts (onPC 2.5.1, live 2026-11-14, docs/probes/cue-part-data-macos-2.5.1.md):
 *   - What a Store takes from the programmer follows the operator's store preferences: `ChannelFilter`
 *     ("Active For Selected" stored only the selected fixture's active values) and `StoreSource` ("Programmer").
 *     The cue store commands send no option that overrides them, so the expectation follows the preference:
 *       Active               every active programmer value
 *       Active For Selected  the active values of the selected (sub)fixtures
 *       All                  every programmer value, active or not
 *       All For Selected     every programmer value of the selected (sub)fixtures
 *     Any other ChannelFilter or StoreSource (or unreadable preferences): the stored values are still compared with
 *     the programmer where both have them, but completeness is not judged (verification unavailable, never matched).
 *   - A programmer value is active while its activeValue or activePhaser mask is set; a Store deactivates what it
 *     stored (102 read activeValue 0 after the store, 101 kept 2).
 *   - preset.read on a cue part returns the stored rows keyed by fixture ID (`fixture` "101") with the value in
 *     percent and a phaser's steps; they matched the programmer exactly. A cell without its own FID is matched by its
 *     subfixture index (`sfIndex` / `subfixtureIndex`), which is not verified live.
 *   - The programmer read's absPreset is not reliable for a hard value (it named a preset for a Zoom set by value), so
 *     preset references are not compared; values and phaser steps are.
 * Values the cue held before (merge) or other content are not judged: only that every expected value is stored.
 */
import type { Gma3Bridge } from "../bridge.js";
import type { Verification } from "../results.js";
import { unavailable } from "../results.js";
import { readPartRows } from "./storedvalues.js";
import type { PresetRow } from "./presets.js";

/** Values compare within this many percent of the attribute range (as the programmer read-backs do). */
export const VALUE_TOLERANCE = 0.5;
const SHOWN = 20;

type Model = "active" | "active_selected" | "all" | "all_selected";

interface ProgRow {
  fid?: string | null;
  subfixtureIndex?: number;
  attribute?: string;
  value?: number | null;
  relative?: number | null;
  stepCount?: number;
  steps?: Array<{ absolute?: number | null; relative?: number | null; width?: number | null; trans?: number | null; accel?: number | null; decel?: number | null }>;
  masks?: { activeValue?: number; activePhaser?: number; individual?: number };
}

export interface StoreExpectation {
  channelFilter: string | null;
  storeSource: string | null;
  /** How the preference is modelled; null when it is not (completeness is then not judged). */
  model: Model | null;
  /** The programmer values the store is expected to take. */
  rows: ProgRow[];
  /** False when the programmer could not be read completely (completeness is then not judged). */
  complete: boolean;
  /** Why the expectation is limited. */
  reason?: string;
  /** The capture failed outright (no comparison possible). */
  error?: string;
  /**
   * With `leftOut`: the programmer values a "... For Selected" filter keeps out of the store because their fixture is
   * not selected (count and the first labels). Absent when not asked, not applicable or not readable.
   */
  leftOut?: { count: number; shown: string[] };
  /** With `leftOut` asked for: why the values a "... For Selected" filter keeps out could not be counted. */
  leftOutUnknown?: string;
}

/** The ChannelFilter / StoreSource pair as an expectation model, or null when it is not modelled. */
export function storeModel(channelFilter: string | null, storeSource: string | null): Model | null {
  if (!storeSource || !/^\s*programmer\s*$/i.test(storeSource)) return null;
  const f = (channelFilter ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (f === "active") return "active";
  if (f === "active for selected") return "active_selected";
  if (f === "all") return "all";
  if (f === "all for selected") return "all_selected";
  return null;
}

const isActive = (r: ProgRow) => (r.masks?.activeValue ?? 0) !== 0 || (r.masks?.activePhaser ?? 0) !== 0;

/** Every programmer row of a scope, page by page. */
async function readProgrammer(bridge: Gma3Bridge, scope: "all" | "selection", t: number): Promise<{ rows: ProgRow[]; complete: boolean }> {
  const rows: ProgRow[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const r = (await bridge.request("programmer", { scope, limit: 5000, offset, maxChannels: 50000 }, t)) as { rows?: ProgRow[]; total?: number; coverage?: { complete?: boolean } };
    const got = Array.isArray(r?.rows) ? r.rows : [];
    rows.push(...got);
    if (r?.coverage?.complete === false) return { rows, complete: false };
    offset += got.length;
    if (!got.length || typeof r?.total !== "number" || offset >= r.total) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/** The operator's store preferences as preset.context reads them. Never throws. */
export async function readStorePreferences(bridge: Gma3Bridge, t: number): Promise<{ channelFilter: string | null; storeSource: string | null; reason?: string }> {
  try {
    const c = (await bridge.request("preset.context", {}, t)) as { preferences?: Record<string, unknown>; preferencesReadable?: boolean };
    if (!c?.preferencesReadable) return { channelFilter: null, storeSource: null, reason: "the store preferences could not be read" };
    const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
    return { channelFilter: str(c.preferences?.ChannelFilter), storeSource: str(c.preferences?.StoreSource) };
  } catch (err) {
    return { channelFilter: null, storeSource: null, reason: `the store preferences could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * The warning a store result carries when the operator's ChannelFilter is not "Active", the setting the plugin's cue
 * tools expect (decided 2026-11-14): with it a store takes every active programmer value whatever is selected.
 * `multiLook`: the tool selects each look in turn (gma3_store_cues, gma3_build_chase).
 */
export function channelFilterWarning(channelFilter: string | null, opts: { multiLook?: boolean } = {}): string | undefined {
  if (channelFilter === null) return undefined;
  const f = channelFilter.trim().toLowerCase().replace(/\s+/g, " ");
  if (f === "active") return undefined;
  const what =
    f === "active for selected"
      ? `a store takes only the selected fixtures' values${opts.multiLook ? ", so a cue with several looks keeps only its last look" : ""}`
      : f === "all" || f === "all for selected"
        ? "a store also takes inactive programmer values, including values an earlier store deactivated"
        : "the plugin does not model what a store then takes";
  return `Store preference ChannelFilter is ${JSON.stringify(channelFilter)}: ${what}. The plugin's cue tools expect "Active" (set it in the user profile's store preferences).`;
}

const rowKey = (r: ProgRow) => `${fidOf(r) ?? `sf${r.subfixtureIndex ?? "?"}`}|${r.attribute ?? ""}`;
const rowLabel = (r: ProgRow) => `${fidOf(r) ?? `subfixture ${r.subfixtureIndex ?? "?"}`} ${r.attribute ?? "?"}`;

/**
 * Capture, right before the store, what the console is expected to store. Never throws.
 * `leftOut`: with a "... For Selected" filter, also read the whole programmer and report the values the filter keeps out
 * (a tool that built the programmer from several selections intended them all).
 */
export async function captureStoreExpectation(bridge: Gma3Bridge, t: number, opts: { leftOut?: boolean } = {}): Promise<StoreExpectation> {
  const prefs = await readStorePreferences(bridge, t);
  const { channelFilter, storeSource } = prefs;
  let reason = prefs.reason;
  const model = storeModel(channelFilter, storeSource);
  if (!model && !reason) reason = `ChannelFilter ${JSON.stringify(channelFilter)} with StoreSource ${JSON.stringify(storeSource)} is not modelled`;
  const scope = model === "active_selected" || model === "all_selected" ? "selection" : "all";
  try {
    const p = await readProgrammer(bridge, scope, t);
    const keep = (r: ProgRow) => model === "all" || model === "all_selected" || isActive(r);
    const rows = p.rows.filter(keep);
    let leftOut: StoreExpectation["leftOut"];
    let leftOutReason: string | undefined;
    // Values are claimed as left out only when both reads are complete: a value missing from an incomplete selection
    // read may well be selected (review of #129), so nothing is claimed then and the check stays unavailable.
    if (opts.leftOut && scope === "selection") {
      if (!p.complete) leftOutReason = "the selection's programmer values could not be read completely, so the values the filter keeps out are not counted";
      else {
        try {
          const whole = await readProgrammer(bridge, "all", t);
          if (!whole.complete) leftOutReason = "the whole programmer could not be read completely, so the values the filter keeps out are not counted";
          else {
            const taken = new Set(rows.map(rowKey));
            const out = whole.rows.filter((r) => keep(r) && !taken.has(rowKey(r)));
            leftOut = { count: out.length, shown: out.slice(0, SHOWN).map(rowLabel) };
          }
        } catch {
          leftOutReason = "the whole programmer could not be read, so the values the filter keeps out are not counted"; // nothing is claimed
        }
      }
    }

    return {
      channelFilter,
      storeSource,
      model,
      rows,
      complete: p.complete,
      ...(p.complete ? (reason ? { reason } : {}) : { reason: [reason, "the programmer could not be read completely"].filter(Boolean).join("; ") }),
      ...(leftOut ? { leftOut } : {}),
      ...(leftOutReason ? { leftOutUnknown: leftOutReason } : {}),
    };
  } catch (err) {
    const error = `the programmer could not be read before the store (${err instanceof Error ? err.message : String(err)})`;
    return { channelFilter, storeSource, model, rows: [], complete: false, error, reason: error };
  }
}

const near = (a: number, b: number) => Math.abs(a - b) <= VALUE_TOLERANCE;
const fidOf = (r: ProgRow) => (r.fid && r.fid !== "None" ? String(r.fid) : null);

/** A step layer the console leaves out of a stored step when it holds its default (presets.ts: width/trans 100, accel/decel 0). */
const STEP_DEFAULTS: Record<"width" | "trans" | "accel" | "decel", number> = { width: 100, trans: 100, accel: 0, decel: 0 };
const STEP_LAYER_NAMES: Record<string, string> = { absolute: "absolute", relative: "relative", width: "width", trans: "transition", accel: "acceleration", decel: "deceleration" };

/**
 * Compare one programmer row with the stored row: undefined when equal, else the difference in words.
 * Every layer the programmer holds as a number is compared (review of #129): the absolute and relative value, and on a
 * phaser each step's absolute, relative, width, transition, acceleration and deceleration. A layer the programmer holds
 * but the part does not store is a difference, except a step timing layer, which the console leaves out at its default.
 */
function differs(p: ProgRow, s: PresetRow): string | undefined {
  const n = p.stepCount ?? 1;
  if (n > 1) {
    const want = p.steps ?? [];
    const got = s.steps ?? [];
    if ((s.stepCount ?? got.length) !== n || got.length !== want.length) return `${n} steps in the programmer, ${s.stepCount ?? got.length} stored`;
    for (let i = 0; i < want.length; i++) {
      for (const k of ["absolute", "relative", "width", "trans", "accel", "decel"] as const) {
        const w = want[i][k];
        if (typeof w !== "number") continue;
        let g: unknown = (got[i] as Record<string, unknown>)[k];
        if (typeof g !== "number" && k in STEP_DEFAULTS) g = STEP_DEFAULTS[k as keyof typeof STEP_DEFAULTS];
        if (typeof g !== "number") return `step ${i + 1} ${STEP_LAYER_NAMES[k]}: ${round(w)} in the programmer, none stored`;
        if (!near(w, g)) return `step ${i + 1} ${STEP_LAYER_NAMES[k]}: ${round(w)} in the programmer, ${round(g)} stored`;
      }
    }
    return undefined;
  }
  const out: string[] = [];
  if (typeof p.value === "number") {
    if (typeof s.value !== "number") out.push(`${round(p.value)} in the programmer, no absolute value stored`);
    else if (!near(p.value, s.value)) out.push(`${round(p.value)} in the programmer, ${round(s.value)} stored`);
  }
  if (typeof p.relative === "number") {
    if (typeof s.relative !== "number") out.push(`relative ${round(p.relative)} in the programmer, no relative value stored`);
    else if (!near(p.relative, s.relative)) out.push(`relative ${round(p.relative)} in the programmer, ${round(s.relative)} stored`);
  }
  // A row with neither an absolute nor a relative number: presence is what is checked.
  return out.length ? out.join(", ") : undefined;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export interface StoredCheck extends Verification {
  /** The preference the expectation followed and the counts; present whenever a comparison ran. */
  storedValues?: {
    channelFilter: string | null;
    storeSource: string | null;
    expected: number;
    stored: number;
    compared: number;
    missing: number;
    different: number;
    notCompared?: number;
    /** Programmer values the "... For Selected" filter kept out of the store (fixture not selected), when asked. */
    leftOutByFilter?: number;
    missingShown?: string[];
    differentShown?: string[];
  };
}

/** After the store: read the part and check every expected value is stored. Never throws. */
export async function verifyStoredValues(bridge: Gma3Bridge, partRef: string, exp: StoreExpectation, t: number): Promise<StoredCheck> {
  const checked = `the values stored in ${partRef} against the programmer values the store was expected to take (ChannelFilter ${JSON.stringify(exp.channelFilter)}); absolute and relative values and every phaser step layer (absolute, relative, width, transition, acceleration, deceleration), within ${VALUE_TOLERANCE} %; not preset references, nor a phaser's speed, phase or measure`;
  if (exp.error) return unavailable(exp.error, checked);
  const read = await readPartRows(bridge, partRef, t);
  if (read.unread && !read.rows.length) return unavailable(`the stored values could not be read: ${read.unread}`, checked);
  const byFid = new Map<string, PresetRow>();
  const bySf = new Map<string, PresetRow>();
  for (const s of read.rows) {
    byFid.set(`${s.fixture}|${s.attribute}`, s);
    if (typeof s.sfIndex === "number") bySf.set(`${s.sfIndex}|${s.attribute}`, s);
  }
  const missing: string[] = [];
  const different: string[] = [];
  let compared = 0;
  let notCompared = 0;
  for (const p of exp.rows) {
    if (!p.attribute) {
      notCompared++;
      continue;
    }
    const fid = fidOf(p);
    const s = (fid ? byFid.get(`${fid}|${p.attribute}`) : undefined) ?? (typeof p.subfixtureIndex === "number" ? bySf.get(`${p.subfixtureIndex}|${p.attribute}`) : undefined);
    const label = `${fid ?? `subfixture ${p.subfixtureIndex ?? "?"}`} ${p.attribute}`;
    if (!s) {
      // A cell without its own FID whose key form is not confirmed: not counted as missing.
      if (!fid) notCompared++;
      else missing.push(label);
      continue;
    }
    compared++;
    const d = differs(p, s);
    if (d) different.push(`${label}: ${d}`);
  }
  const counts = {
    channelFilter: exp.channelFilter,
    storeSource: exp.storeSource,
    expected: exp.rows.length,
    stored: read.rows.length,
    compared,
    missing: missing.length,
    different: different.length,
    ...(notCompared ? { notCompared } : {}),
    ...(exp.leftOut ? { leftOutByFilter: exp.leftOut.count } : {}),
    ...(missing.length ? { missingShown: missing.slice(0, SHOWN) } : {}),
    ...(different.length ? { differentShown: different.slice(0, SHOWN) } : {}),
  };
  const judgeMissing = exp.model !== null && exp.complete && !read.unread;
  const problems = [
    different.length ? `${different.length} value(s) differ from the programmer (${different.slice(0, 3).join("; ")}${different.length > 3 ? "; ..." : ""})` : "",
    judgeMissing && missing.length ? `${missing.length} expected value(s) are not stored (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})` : "",
  ].filter(Boolean);
  if (problems.length) return { status: "mismatched", checked, detail: problems.join("; "), storedValues: counts };
  if (!judgeMissing) {
    const why = read.unread ?? exp.reason ?? "completeness could not be judged";
    return { status: "unavailable", checked, detail: `${compared} value(s) compared and matched, completeness not judged: ${why}${missing.length ? ` (${missing.length} programmer value(s) not found in the cue)` : ""}`, storedValues: counts };
  }
  // Nothing expected (a command-only cue, an empty selection): nothing can be missing; the detail says so.
  if (exp.rows.length === 0) return { status: "matched", checked, detail: `the programmer held no value the store was expected to take (ChannelFilter ${JSON.stringify(exp.channelFilter)})`, storedValues: counts };
  // An expected value that could not be compared is not verified (review of #129): unavailable, never matched.
  if (notCompared) return { status: "unavailable", checked, detail: `${compared} value(s) compared and matched; ${notCompared} expected value(s) could not be compared (a cell without its own FID whose stored row was not found by subfixture index, or a row without an attribute)`, storedValues: counts };
  return { status: "matched", checked, storedValues: counts };
}

/** The weakest of several verifications: mismatched > unavailable / not requested > matched. */
export function combineVerifications(list: Verification[], checked: string): Verification {
  const mism = list.filter((v) => v.status === "mismatched");
  if (mism.length) return { status: "mismatched", checked, detail: mism.map((v) => v.detail).filter(Boolean).join("; ") };
  const unav = list.filter((v) => v.status === "unavailable" || v.status === "not_requested");
  if (unav.length) return unavailable(unav.map((v) => v.detail).filter(Boolean).join("; ") || "not verified", checked);
  return { status: "matched", checked };
}
