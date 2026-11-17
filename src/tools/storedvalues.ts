/**
 * The stored values of a cue part, shared by gma3_cue_contents (inspection.ts) and the show-analysis tools
 * (analysis.ts).
 *
 * Console fact (probe SB-05, docs/probes/sb-05-recipes-macos-2.5.1.md "Reading cooked coverage", onPC 2.5.1):
 * GetPresetData works on a cue Part as on a preset: by_fixtures[fid][attribute] with the stored value, phaser steps,
 * fade/delay, mask_cooked (511 for a recipe's cooked output, 0 for a hard value) and the referenced presets. The
 * bridge's preset.read accepts a Part from 0.24.0 and returns at most 5000 rows (`truncated`). A part is addressed
 * by command form ("Sequence S Cue C Part P"): its address holds a negative cue index and does not resolve.
 */
import type { Gma3Bridge } from "../bridge.js";
import type { ObjectRefInfo, PresetRead, PresetRow } from "./presets.js";

type Row = Record<string, unknown>;

/** The bridge that reads a cue Part with preset.read (GetPresetData on a Part, sb-05). */
export const PART_DATA_BRIDGE = "0.24.0";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A failed preset.read on a Part, with what an older bridge needs. */
export function partReadError(err: unknown): string {
  const m = errText(err);
  if (/\[not-preset\]|unknown op/i.test(m)) return `${m} (reading a cue part's data needs bridge ${PART_DATA_BRIDGE}; update the plugin)`;
  return m;
}

/** One part's stored rows; `unread` says why they are missing or incomplete. Never throws. */
export async function readPartRows(bridge: Gma3Bridge, partRef: string, t: number): Promise<{ rows: PresetRow[]; unread?: string; truncated?: boolean }> {
  try {
    const pr = (await bridge.request("preset.read", { ref: partRef }, t)) as PresetRead & { byFixtures?: boolean };
    const rows = Array.isArray(pr?.rows) ? pr.rows : [];
    if (pr?.byFixtures === false) return { rows, unread: "GetPresetData returned no per-fixture table for this part" };
    if (pr?.truncated) return { rows, truncated: true, unread: `the part holds more than ${rows.length} values; only the first ${rows.length} were read` };
    return { rows };
  } catch (err) {
    return { rows: [], unread: partReadError(err) };
  }
}

/** A referenced preset in words: Preset 4.12 "Red"; a deleted one as "deleted preset". */
export function refLabel(r: ObjectRefInfo | null | undefined): string | null {
  if (!r) return null;
  if (r.valid === false) return "deleted preset (invalid reference)";
  const where = r.pool !== undefined && r.no !== undefined ? `Preset ${r.pool}.${r.no}` : (r.addrNative ?? r.addr ?? "a preset");
  return r.name ? `${where} "${r.name}"` : where;
}

/** A referenced preset's full address (its data pool included), or null: what tells two same-labelled presets apart. */
export function refAddress(r: ObjectRefInfo | null | undefined): string | null {
  if (!r || r.valid === false) return null;
  return r.addrNative ?? r.addr ?? null;
}

const round = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v === undefined ? null : v);

/**
 * A stored value as a compact description (null fields left out). With `identity` (comparisons: gma3_cue_diff,
 * gma3_tracking_leaks), each preset reference's full address is kept too (presetAddr, relPresetAddr,
 * stepPresetAddrs), so Preset 4.12 "Red" of DataPool 1 and of DataPool 2 differ (review of #129); the labels stay short.
 */
export function valueOf(r: PresetRow, opts: { identity?: boolean } = {}): Row {
  const ref = (x: ObjectRefInfo | null | undefined) => refLabel(x);
  const out: Row = {};
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  if ((r.stepCount ?? 1) > 1 && Array.isArray(r.steps)) {
    put("steps", r.steps.length);
    put("stepValues", r.steps.map((s) => round(s.absolute)));
    // Every playback-significant step layer, step by step, so two cues whose steps differ only in a relative value,
    // a timing layer or which step holds which preset never compare equal (review of #129).
    const layer = (k: "relative" | "width" | "trans" | "accel" | "decel") => r.steps!.map((s) => round(s[k]));
    for (const [name, k] of [["stepRelative", "relative"], ["stepWidth", "width"], ["stepTransition", "trans"], ["stepAccel", "accel"], ["stepDecel", "decel"]] as const) {
      const vals = layer(k);
      if (vals.some((v) => v !== null)) put(name, vals);
    }
    const integrated = r.steps.map((s) => ref(s.integrated));
    if (integrated.some((x) => x !== null)) put("stepPresets", integrated);
    if (opts.identity) {
      const addrs = r.steps.map((s) => refAddress(s.integrated));
      if (addrs.some((x) => x !== null)) put("stepPresetAddrs", addrs);
    }
    put("speed", round(r.speed));
    put("phase", round(r.phase));
    // Measure and the speed master change playback timing too (review of #129).
    put("measure", round(r.measure));
    put("speedMaster", round(r.speedMaster));
  } else {
    put("value", round(r.value));
  }
  put("relative", round(r.relative));
  put("preset", ref(r.absPreset));
  put("relPreset", ref(r.relPreset));
  if (opts.identity) {
    put("presetAddr", refAddress(r.absPreset));
    put("relPresetAddr", refAddress(r.relPreset));
  }
  put("fade", round(r.fade));
  put("delay", round(r.delay));
  if (r.cooked) out.cooked = true;
  return out;
}

/** A stored row in the compact form gma3_cue_contents returns: fixture, attribute and its described value. */
export function storedRow(r: PresetRow): Row {
  return { fixture: r.fixture, attribute: r.attribute, ...valueOf(r) };
}

/**
 * A predicate on a row's fixture key ("101", "501.2") from a validated fixture range ("Fixture 1 Thru 5 + 10 - 3",
 * inspection.ts fixtureRange). An id also matches its subfixtures (501 matches 501.2). A range runs within one level
 * ("401 Thru 404", "501.1 Thru 501.12"). Undefined when the range cannot be read this way (the caller then says the
 * filter was not applied).
 */
export function fixtureMatcher(range: string): ((fixture: string) => boolean) | undefined {
  const tokens = range.trim().split(/\s+/).filter((t) => !/^fixture$/i.test(t));
  type Term = (parts: number[]) => boolean;
  const ids = (t: string) => (/^\d+(?:\.\d+)*$/.test(t) ? t.split(".").map(Number) : undefined);
  const include: Term[] = [];
  const exclude: Term[] = [];
  let sign: 1 | -1 = 1;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "+" || t === "-") {
      sign = t === "+" ? 1 : -1;
      i++;
      continue;
    }
    const a = ids(t);
    if (!a) return undefined;
    let term: Term;
    if (tokens[i + 1] && /^thru$/i.test(tokens[i + 1])) {
      const b = ids(tokens[i + 2] ?? "");
      if (!b || a.length !== b.length || a.slice(0, -1).join(".") !== b.slice(0, -1).join(".")) return undefined;
      const depth = a.length;
      const lo = Math.min(a[depth - 1], b[depth - 1]);
      const hi = Math.max(a[depth - 1], b[depth - 1]);
      const prefix = a.slice(0, -1);
      term = (p) => p.length >= depth && prefix.every((n, k) => p[k] === n) && p[depth - 1] >= lo && p[depth - 1] <= hi;
      i += 3;
    } else {
      term = (p) => p.length >= a.length && a.every((n, k) => p[k] === n);
      i++;
    }
    (sign === 1 ? include : exclude).push(term);
  }
  if (!include.length) return undefined;
  return (fixture: string) => {
    const p = ids(String(fixture));
    if (!p) return false;
    return include.some((f) => f(p)) && !exclude.some((f) => f(p));
  };
}
