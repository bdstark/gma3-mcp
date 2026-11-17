/**
 * Read-only show analysis over stored cue data (inspired by drohi-r/grandma2-mcp's analysis.py, built the gma3 way):
 *
 *   gma3_preset_usage    which sequences / cues / parts reference a preset, and the executors that play them; or the
 *                        dangling references (cue data pointing at a preset that no longer exists)
 *   gma3_cue_diff        per-attribute diff of the stored data of two cues, plus cue and part property differences
 *   gma3_tracking_leaks  candidates for values that keep tracking through later cues that revisit the fixture
 *
 * Three tools rather than one with an `action`: the three take different inputs and return different shapes, as the
 * read tools next to them do (gma3_tags, gma3_variables, gma3_pool_usage). Like those, they return plain JSON with
 * `complete` and the reasons, not the workflow OperationResult: an incomplete scan is still a useful answer and must
 * not be surfaced as a failed operation; the call is an error only when nothing could be read.
 *
 * Built on existing bridge ops only (no bridge change), all read-only and usable with the `lua` op disabled:
 *   - `children` (paged with readAllChildren): DataPool.Sequences, then each sequence's cues (No read with asText
 *     false: x1000; CueZero reads 0 and OffCue has none, so both are left out and say so). No range is ever sent:
 *     ObjectList ranges can hang onPC 2.5.1 (docs/probes/objectlist-hang-macos-2.5.1.md).
 *   - `cueContents` (FR-10, what gma3_cue_contents reads) on "Sequence S Cue C": cue properties, the sequence's
 *     Tracking, each part's number, timing, OwnDataPresent and recipe lines with their resolved preset reference.
 *   - `preset.read` (bridge 0.24.0) on "Sequence S Cue C Part P": GetPresetData works on a cue Part as on a preset
 *     (docs/probes/sb-05-recipes-macos-2.5.1.md "Reading cooked coverage"): per fixture and attribute the stored value,
 *     phaser steps, fade/delay, `cooked` (a recipe's output) and abs_preset / rel_preset / step `integrated` (the
 *     preset a value references). This is what gma3_cue_contents' "storedValues: null" note predates. A part's
 *     address holds a negative cue index and does not resolve (tags.ts), so parts are addressed by command form.
 *     A part whose OwnDataPresent reads No holds no data and is not read.
 *   - `findReferencesWhere` (playback.ts): executors on every page whose object is a sequence with a usage.
 *
 * Console facts the analyses rely on:
 *   - Deleting a preset that cue data references turns those values into plain values: no reference and no invalid
 *     handle remain (live 2026-11-14, docs/probes/cue-part-data-macos-2.5.1.md). An invalid handle is still reported
 *     where one is read (a preset inside a preset keeps one, sb-03); it says where it sits, not which preset it was.
 *     A recipe line whose preset was deleted reads an empty Values field (sb-05), indistinguishable from a line
 *     without a preset.
 *   - Stored data is what a cue stores (hard values, blocked values, cooked recipe output); tracked values are not
 *     part of a part's data. Tracking is folded here from the stored data in cue order.
 *   - Cue Release Yes releases every tracked value at that cue; a cue Break releases the attributes of a filter or
 *     world (not evaluated here); a TrackingDistance on a cue part limits how far that cue's values track
 *     (grandMA3 manual: cue_tracking*.html).
 *
 * Every per-cue read is a request (one cueContents plus one preset.read per part with data), so scans are bounded by
 * a cue count and a time budget, and a stopped scan returns where to resume. Anything not read (a failed request,
 * 5000-row truncation, a listing that failed or changed, a budget stop, a bridge too old for preset.read on a Part)
 * makes the result `complete: false` with the reason; such a result never claims that something is unused or that
 * there are no leaks.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import type { ToolResult } from "../results.js";
import { parseConsoleBoolean } from "../results.js";
import { Validator, ValidationError, cueNumber, describe, finiteNumber, objectNumber } from "../validate.js";
import type { RegisterTools, ToolContext } from "./context.js";
import { dataPoolShape, scopedBridge } from "./datapool.js";
import { CUE_KEYS, PART_TIMING_KEYS, RECIPE_KEYS } from "./inspection.js";
import { findReferencesWhere } from "./playback.js";
import { FIELD_ERRORS_BRIDGE, readAllChildren, versionAtLeast } from "./poolusage.js";
import type { ObjectRefInfo, PresetRead, PresetRow } from "./presets.js";
import { cueNo } from "./speed.js";
import { PART_DATA_BRIDGE, readPartRows, refAddress, refLabel, valueOf } from "./storedvalues.js";

export { refLabel, valueOf };

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Reading cues and parts
// ---------------------------------------------------------------------------

export { PART_DATA_BRIDGE };

export interface PartRead {
  part: number | null;
  name: string | null;
  timing: Row;
  command: Row;
  mib: Row;
  ownDataPresent: boolean | null;
  recipes: Row[];
  /** The part's stored rows; [] for a part whose OwnDataPresent is No (not read). */
  rows: PresetRow[];
  /** Why the part's data was not (fully) read; absent when it was. */
  unread?: string;
}

export interface CueRead {
  sequence: number;
  cue: string;
  ref: string;
  name: string | null;
  props: Row;
  /** The sequence's Tracking setting as read with the cue (true / false / null when unreadable). */
  tracking: boolean | null;
  parts: PartRead[];
  /** Why the cue could not be read at all. */
  error?: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));


const asRow = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strOrNull = (v: unknown) => (v === undefined || v === null ? null : String(v));

/** The cue number as the command line writes it: 1, 2.5, 10.001. */
export function cueText(no: number): string {
  return String(Number(no.toFixed(3)));
}

/** One cue: its properties and parts (cueContents), then each part's stored rows (preset.read). Never throws. */
export async function readCue(bridge: Gma3Bridge, sequence: number, cue: string, t: number): Promise<CueRead> {
  const ref = `Sequence ${sequence} Cue ${cue}`;
  const out: CueRead = { sequence, cue, ref, name: null, props: {}, tracking: null, parts: [] };
  let cc: Row;
  try {
    cc = asRow(await bridge.request("cueContents", { ref }, t));
  } catch (err) {
    out.error = errText(err);
    return out;
  }
  out.props = asRow(cc.cue);
  out.name = strOrNull(out.props.name);
  out.tracking = parseConsoleBoolean(asRow(cc.sequence).tracking ?? "");
  for (const raw of asList(cc.parts)) {
    const p = asRow(raw);
    const part: PartRead = {
      part: typeof p.part === "number" && Number.isInteger(p.part) ? p.part : null,
      name: strOrNull(p.name),
      timing: asRow(p.timing),
      command: asRow(p.command),
      mib: asRow(p.mib),
      ownDataPresent: typeof p.ownDataPresent === "boolean" ? p.ownDataPresent : null,
      recipes: asList(p.recipes).map(asRow),
      rows: [],
    };
    out.parts.push(part);
    // OwnDataPresent No: nothing stored (a recipe's cooked output sets it to Yes, sb-05).
    if (part.ownDataPresent === false) continue;
    if (part.part === null) {
      part.unread = "the part's number could not be read, so its data cannot be addressed";
      continue;
    }
    const read = await readPartRows(bridge, `${ref} Part ${part.part}`, t);
    part.rows = read.rows;
    if (read.unread) part.unread = read.unread;
  }
  return out;
}

/** Why a cue's data is not fully known, or undefined when every part was read. */
export function cueUnread(c: CueRead): string | undefined {
  if (c.error) return c.error;
  const bad = c.parts.filter((p) => p.unread);
  if (!bad.length) return undefined;
  return bad.map((p) => `part ${p.part ?? "?"}: ${p.unread}`).join("; ");
}

interface CueEntry {
  no: number;
  cue: string;
  name: string | null;
}

/** The cues of a sequence (numbers > 0, in order). CueZero and OffCue are counted in `special`. Never throws. */
export async function listCues(bridge: Gma3Bridge, sequence: number, t: number): Promise<{ cues: CueEntry[]; complete: boolean; reason?: string; special: number; answered: boolean }> {
  const read = await readAllChildren(bridge, `Sequence ${sequence}`, { fields: ["No"], asText: false }, t);
  const cues: CueEntry[] = [];
  let special = 0;
  let unnumbered = 0;
  for (const it of read.items) {
    if (!it || it.invalid) {
      unnumbered++;
      continue;
    }
    if (it.class !== undefined && it.class !== "Cue") continue;
    // The cue number decides first: an ordinary cue may be named OffCue or CueZero (review of #129). OffCue has no
    // readable No (its read may fail) and CueZero reads 0: only without a usable number does the name mark them.
    const no = it.fieldErrors?.No === undefined ? cueNo(it.fields?.No) : null;
    if (no !== null && no > 0) {
      cues.push({ no, cue: cueText(no), name: it.name ?? null });
      continue;
    }
    if (/^(offcue|cuezero)$/i.test(it.name ?? "")) {
      special++;
      continue;
    }
    if (it.fieldErrors?.No !== undefined) {
      unnumbered++;
      continue;
    }
    special++;
  }
  cues.sort((a, b) => a.no - b.no);
  if (unnumbered && read.complete) return { cues, complete: false, reason: `${unnumbered} cue(s) of Sequence ${sequence} without a readable number`, special, answered: read.answered };
  return { cues, complete: read.complete, reason: read.reason, special, answered: read.answered };
}

interface SequenceEntry {
  no: number;
  name: string | null;
  addr?: string;
  /** Children of the sequence (its cues, CueZero and OffCue included), from the listing. */
  childCount?: number;
}

/** Every sequence of the data pool, in number order. Never throws. */
async function listSequences(bridge: Gma3Bridge, t: number): Promise<{ sequences: SequenceEntry[]; complete: boolean; reason?: string; answered: boolean }> {
  const read = await readAllChildren(bridge, "DataPool.Sequences", {}, t);
  const out = new Map<number, SequenceEntry>();
  let unnumbered = 0;
  for (const it of read.items) {
    if (!it || it.invalid || typeof it.index !== "number" || !Number.isInteger(it.index)) {
      unnumbered++;
      continue;
    }
    if (!out.has(it.index)) out.set(it.index, { no: it.index, name: it.name ?? null, addr: it.addr, childCount: typeof (it as { childCount?: unknown }).childCount === "number" ? ((it as { childCount?: number }).childCount as number) : undefined });
  }
  const sequences = [...out.values()].sort((a, b) => a.no - b.no);
  if (unnumbered && read.complete) return { sequences, complete: false, reason: `${unnumbered} sequence(s) without a number`, answered: read.answered };
  return { sequences, complete: read.complete, reason: read.reason, answered: read.answered };
}

/**
 * Child listings are only confirmed complete from bridge 0.47.0 (an older one answers a failed enumeration with an
 * empty listing; poolusage.ts). One ping per call: undefined when confirmed, else why not.
 */
async function unconfirmedListings(bridge: Gma3Bridge, t: number): Promise<string | undefined> {
  let version: unknown;
  try {
    version = ((await bridge.request("ping", {}, t)) as { bridgeVersion?: unknown } | null)?.bridgeVersion;
  } catch (err) {
    return `the bridge version could not be read (${errText(err)}); complete listings need bridge ${FIELD_ERRORS_BRIDGE}`;
  }
  if (versionAtLeast(version, FIELD_ERRORS_BRIDGE)) return undefined;
  return `bridge ${typeof version === "string" ? version : "(unknown version)"} does not report a failed child listing (it reads like an empty one), so the listings cannot be confirmed complete; update to bridge ${FIELD_ERRORS_BRIDGE}`;
}

/** A cue-count and wall-clock budget for one call. */
class Budget {
  cues = 0;
  private readonly deadline: number;
  constructor(
    private readonly maxCues: number,
    seconds: number,
  ) {
    this.deadline = Date.now() + seconds * 1000;
  }
  /** Why no further cue may be read, or undefined. */
  exhausted(): string | undefined {
    if (this.cues >= this.maxCues) return `the cue budget (max_cues ${this.maxCues}) was reached`;
    if (Date.now() >= this.deadline) return "the time budget (max_seconds) was reached";
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Values and references
// ---------------------------------------------------------------------------

/** The fields in which two descriptions differ. */
function changedFields(a: Row, b: Row): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

/** Every reference a row holds: [kind, ref]. */
function refsOf(r: PresetRow): Array<[string, ObjectRefInfo]> {
  const out: Array<[string, ObjectRefInfo]> = [];
  if (r.absPreset) out.push(["absolute", r.absPreset]);
  if (r.relPreset) out.push(["relative", r.relPreset]);
  for (const s of r.steps ?? []) if (s.integrated) out.push([`step ${s.step}`, s.integrated]);
  return out;
}

interface TargetPreset {
  addr?: string;
  addrNative?: string;
}

function sameObject(r: { valid?: boolean; addr?: unknown; addrNative?: unknown } | null | undefined, t: TargetPreset): boolean {
  if (!r || r.valid === false) return false;
  if (t.addrNative && typeof r.addrNative === "string") return r.addrNative === t.addrNative;
  return !!t.addr && typeof r.addr === "string" && r.addr === t.addr;
}

/** Natural order of fixture keys: 2 < 10 < 501.2 < 501.10; non-numeric keys after. */
function fixtureOrder(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a.localeCompare(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

const firstFew = (xs: string[], n: number) => (xs.length > n ? [...xs.slice(0, n), `and ${xs.length - n} more`] : xs);

/** JSON with each listed array one element per line, so a long result stays readable and a cut keeps whole rows. */
export function renderLines(result: Row, listKeys: string[]): string {
  const head: Row = {};
  const lists: Array<[string, unknown[]]> = [];
  for (const [k, v] of Object.entries(result)) {
    if (listKeys.includes(k) && Array.isArray(v) && v.length) lists.push([k, v]);
    else head[k] = v;
  }
  if (!lists.length) return JSON.stringify(result);
  const headText = JSON.stringify(head);
  const body = lists.map(([k, v]) => `${JSON.stringify(k)}:[\n${v.map((x) => JSON.stringify(x)).join(",\n")}\n]`).join(",\n");
  return `${headText.slice(0, -1)}${headText.length > 2 ? "," : ""}\n${body}}`;
}

function validationError(tool: string, errors: string[]): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ tool, error: "validation failed", validationErrors: errors }) }], isError: true };
}

const toolError = (tool: string, error: string): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ tool, error }) }], isError: true });

function intArg(v: Validator, field: string, value: unknown, min: number, max: number, dflt: number): number {
  return v.check(() => finiteNumber(field, value, { integer: true, min, max, optional: true })) ?? dflt;
}

// ---------------------------------------------------------------------------
// gma3_preset_usage
// ---------------------------------------------------------------------------

export function parsePresetRef(field: string, value: unknown): { pool: number; no: number; ref: string } {
  const m = typeof value === "string" ? value.trim().match(/^(?:preset\s+)?(\d{1,4})\.(\d{1,5})$/i) : null;
  if (!m) throw new ValidationError(`${field} must be a preset as "4.12" or "Preset 4.12" (got ${describe(value)})`, field);
  const pool = Number(m[1]);
  const no = Number(m[2]);
  if (pool < 1 || no < 1) throw new ValidationError(`${field}: pool and preset numbers start at 1`, field);
  return { pool, no, ref: `Preset ${pool}.${no}` };
}

export interface PresetUsageArgs {
  preset?: unknown;
  dangling?: unknown;
  sequences?: unknown;
  executors?: unknown;
  resume?: unknown;
  max_cues?: unknown;
  max_seconds?: unknown;
  max_results?: unknown;
  data_pool?: unknown;
}

const USAGE_LIMITATIONS = [
  "searched: the stored data of every cue part (values, phaser steps and their references, cooked recipe output) and each part's recipe lines; not searched: presets that embed this preset, CueZero and OffCue, macros, timecode events and command text",
  "deleting a preset turns the cue values that referenced it into plain values (onPC 2.5.1, 2026-11-14): no reference remains, so such values are neither a usage nor dangling; dangling lists invalid handles where the console kept one (it says where, not which preset) and recipe preset text that no longer resolves",
  "a recipe line whose preset was deleted reads an empty Values field (no handle remains) and cannot be told from a line without a preset; a recipe line with preset text that did not resolve is reported as dangling",
  "executors are those of every page of the data pool whose assigned object is the sequence",
];

export async function presetUsage(ctx: ToolContext, raw: PresetUsageArgs): Promise<ToolResult> {
  const tool = "gma3_preset_usage";
  const v = new Validator();
  const target = raw.preset === undefined || raw.preset === null || raw.preset === "" ? undefined : v.check(() => parsePresetRef("preset", raw.preset));
  const dangling = raw.dangling === true;
  if (!target && !dangling) v.fail("give preset (\"4.12\") or dangling: true (or both)");
  let only: number[] | undefined;
  if (raw.sequences !== undefined) {
    if (!Array.isArray(raw.sequences) || raw.sequences.length === 0 || raw.sequences.length > 500) v.fail("sequences must list 1-500 sequence numbers");
    else only = raw.sequences.map((s, i) => v.check(() => objectNumber(`sequences[${i}]`, s)) ?? 0);
  }
  let resume: { sequence: number; cue: number } | undefined;
  if (raw.resume !== undefined) {
    const r = asRow(raw.resume);
    const sequence = v.check(() => objectNumber("resume.sequence", r.sequence));
    const cue = v.check(() => cueNumber("resume.cue", r.cue));
    if (sequence !== undefined && cue !== undefined) resume = { sequence, cue: Number(cue) };
  }
  const maxCues = intArg(v, "max_cues", raw.max_cues, 1, 5000, 300);
  const maxSeconds = intArg(v, "max_seconds", raw.max_seconds, 5, 600, 90);
  const maxResults = intArg(v, "max_results", raw.max_results, 1, 1000, 100);
  const dataPool = raw.data_pool === undefined ? undefined : v.check(() => objectNumber("data_pool", raw.data_pool));
  if (!v.ok) return validationError(tool, v.errors);

  const bridge = scopedBridge(ctx.bridge, dataPool);
  const t = ctx.requestTimeoutMs;
  const tRead = Math.max(t, Math.min(t * 3, 60000));
  const reasons: string[] = [];
  const unconfirmed = await unconfirmedListings(ctx.bridge, t);
  if (unconfirmed) reasons.push(unconfirmed);

  // The preset itself: its address is what a reference is matched by.
  let preset: Row | null = null;
  let tgt: TargetPreset = {};
  if (target) {
    let pr: PresetRead;
    try {
      pr = (await bridge.request("preset.read", { ref: target.ref }, tRead)) as PresetRead;
    } catch (err) {
      const m = errText(err);
      if (/no objects? found|no object at address/i.test(m)) return toolError(tool, `${target.ref} does not exist. Cue values that referenced a deleted preset keep their values without a reference (onPC 2.5.1), so they cannot be found by preset; dangling: true lists invalid handles and unresolved recipe preset text.`);
      return toolError(tool, `${target.ref} could not be read: ${m}`);
    }
    tgt = { addr: pr.addr, addrNative: pr.addrNative };
    if (!tgt.addr && !tgt.addrNative) return toolError(tool, `${target.ref} has no readable address, so references to it cannot be matched`);
    preset = { ref: target.ref, name: pr.name ?? null, consoleReferenceCount: typeof pr.referencedBy === "number" ? pr.referencedBy : null };
  }

  const seqList = await listSequences(bridge, t);
  if (!seqList.answered && seqList.sequences.length === 0) return toolError(tool, `the sequence pool could not be read: ${seqList.reason ?? "no answer"}`);
  if (!seqList.complete) reasons.push(`the sequence pool listing is incomplete: ${seqList.reason}`);
  let inScope = seqList.sequences;
  const notFound: number[] = [];
  if (only) {
    const want = new Set(only);
    inScope = inScope.filter((s) => want.has(s.no));
    for (const n of want) if (!inScope.some((s) => s.no === n)) notFound.push(n);
    if (notFound.length) reasons.push(`sequence(s) ${notFound.join(", ")} not found in the sequence pool`);
  }
  if (resume) inScope = inScope.filter((s) => s.no >= resume!.sequence);

  const budget = new Budget(maxCues, maxSeconds);
  const usages: Row[] = [];
  const danglingRows: Row[] = [];
  const unread: Row[] = [];
  const usedSeqs = new Map<number, SequenceEntry>();
  let usageTotal = 0;
  let danglingTotal = 0;
  let cuesListed = 0;
  let cuesScanned = 0;
  let partsRead = 0;
  let partsEmpty = 0;
  let sequencesDone = 0;
  let next: { sequence: number; cue: string } | undefined;
  let stopped: string | undefined;

  outer: for (const seq of inScope) {
    // The budget is checked before each sequence listing too (review of #129): a listing is a request of its own, and
    // a show with many sequences could otherwise run past max_seconds before its first cue. A sequence not yet listed
    // resumes from its first cue (0.001: the smallest cue number), or from the resume point it was given.
    const before = budget.exhausted();
    if (before) {
      stopped = before;
      next = { sequence: seq.no, cue: resume && seq.no === resume.sequence ? String(resume.cue) : "0.001" };
      break;
    }
    const listing = await listCues(bridge, seq.no, t);
    if (!listing.complete) reasons.push(`Sequence ${seq.no}: the cue listing is incomplete: ${listing.reason}`);
    let cues = listing.cues;
    if (resume && seq.no === resume.sequence) cues = cues.filter((c) => c.no >= resume!.cue - 1e-9);
    cuesListed += cues.length;
    for (const c of cues) {
      const why = budget.exhausted();
      if (why) {
        stopped = why;
        next = { sequence: seq.no, cue: c.cue };
        break outer;
      }
      budget.cues++;
      const cue = await readCue(bridge, seq.no, c.cue, tRead);
      cuesScanned++;
      if (cue.error) {
        unread.push({ sequence: seq.no, cue: c.cue, reason: cue.error });
        continue;
      }
      for (const p of cue.parts) {
        if (p.ownDataPresent === false) partsEmpty++;
        else if (!p.unread) partsRead++;
        if (p.unread) unread.push({ sequence: seq.no, cue: c.cue, part: p.part, reason: p.unread });
        // Usages: values, steps and recipe lines that reference the preset.
        if (target) {
          const via = new Set<string>();
          const fixtures = new Set<string>();
          const attributes = new Set<string>();
          let channels = 0;
          for (const r of p.rows) {
            const hits = refsOf(r).filter(([, ref]) => sameObject(ref, tgt));
            if (!hits.length) continue;
            channels++;
            fixtures.add(r.fixture);
            attributes.add(r.attribute);
            for (const [kind] of hits) via.add(kind.startsWith("step") ? "phaser step" : kind);
            if (r.cooked) via.add("cooked");
          }
          const recipes = p.recipes.filter((rc) => sameObject(asRow(rc.presetRef), tgt)).map((rc) => rc.index);
          for (const ix of recipes) via.add(`recipe line ${ix ?? "?"}`);
          if (channels || recipes.length) {
            usageTotal++;
            usedSeqs.set(seq.no, seq);
            if (usages.length < maxResults) {
              usages.push({
                sequence: seq.no,
                cue: c.cue,
                part: p.part,
                ...(cue.name ? { cueName: cue.name } : {}),
                channels,
                fixtures: firstFew([...fixtures].sort(fixtureOrder), 8),
                attributes: firstFew([...attributes].sort(), 8),
                via: [...via],
              });
            }
          }
        }
        // Dangling: invalid handles in the data, recipe preset text that did not resolve.
        if (dangling) {
          const examples: string[] = [];
          let channels = 0;
          for (const r of p.rows) {
            const bad = refsOf(r).filter(([, ref]) => ref.valid === false);
            if (!bad.length) continue;
            channels++;
            if (examples.length < 5) examples.push(`${r.fixture} ${r.attribute} (${bad.map(([k]) => k).join(", ")})`);
          }
          const recipes = p.recipes.filter((rc) => rc.presetResolved === false && typeof rc.preset === "string" && rc.preset.trim() !== "").map((rc) => ({ line: rc.index ?? null, preset: rc.preset ?? null }));
          if (channels || recipes.length) {
            danglingTotal++;
            if (danglingRows.length < maxResults) danglingRows.push({ sequence: seq.no, cue: c.cue, part: p.part, ...(cue.name ? { cueName: cue.name } : {}), channels, ...(examples.length ? { examples } : {}), ...(recipes.length ? { recipes } : {}) });
          }
        }
      }
    }
    if (listing.complete) sequencesDone++;
  }

  if (stopped) reasons.push(`${stopped}; resume with resume: ${JSON.stringify(next)}`);
  if (unread.length) reasons.push(`${unread.length} cue(s) or part(s) could not be read (see unread)`);

  // Executors that play the sequences with a usage.
  let executors: Row[] | undefined;
  let executorScan: Row | undefined;
  if (target && raw.executors !== false && usedSeqs.size) {
    const byAddr = new Map<string, SequenceEntry>();
    for (const s of usedSeqs.values()) if (s.addr) byAddr.set(s.addr, s);
    const refs = await findReferencesWhere(bridge, (addr) => byAddr.has(addr), t);
    executorScan = { complete: refs.complete, pagesScanned: refs.pagesScanned, ...(refs.error ? { error: refs.error } : {}) };
    if (!refs.complete) reasons.push(`the executor scan is incomplete: ${refs.error ?? "unknown reason"}; executors lists only what was found`);
    executors = [...usedSeqs.values()].map((s) => ({ sequence: s.no, name: s.name, executors: refs.executors.filter((e) => e.addr === s.addr).map((e) => e.ref) }));
  }

  const complete = reasons.length === 0;

  const scope = only ? `Sequence(s) ${only.join(", ")}` : "every sequence";
  let summary: string;
  if (target) {
    summary = usageTotal
      ? `${target.ref} is referenced by ${usageTotal} cue part(s) in ${usedSeqs.size} sequence(s)${complete ? "" : " so far"}`
      : complete
        ? `no cue part in ${scope} references ${target.ref} (searched: stored values, phaser steps and recipe lines)`
        : `no reference to ${target.ref} found in what was read; the scan is INCOMPLETE, so this does not show that ${target.ref} is unused`;
  } else summary = "";
  if (dangling) {
    const d = danglingTotal
      ? `${danglingTotal} cue part(s) hold dangling preset references${complete ? "" : " so far"}`
      : complete
        ? `no dangling preset reference in ${scope}`
        : "no dangling preset reference found in what was read; the scan is INCOMPLETE, so there may be some";
    summary = summary ? `${summary}; ${d}` : d;
  }

  const result: Row = {
    tool,
    ...(dataPool !== undefined ? { dataPool } : {}),
    complete,
    summary: `${summary}.`,
    ...(reasons.length ? { reasons } : {}),
    ...(next ? { next: { resume: next } } : {}),
    ...(preset ? { preset } : {}),
    coverage: {
      sequences: { inScope: inScope.length, scannedToTheEnd: sequencesDone, ...(resume ? { resumedAt: resume } : {}) },
      ...(inScope.every((x) => x.childCount !== undefined) ? { cueObjectsInScope: inScope.reduce((n, x) => n + (x.childCount ?? 0), 0) } : {}),
      cues: { listed: cuesListed, scanned: cuesScanned },
      ...(resume ? { note: "a resumed call reports the counts, rows and executors of this call only" } : {}),
      parts: { read: partsRead, withoutData: partsEmpty, unread: unread.filter((u) => u.part !== undefined).length },
      notScanned: "CueZero and OffCue",
    },
    ...(target ? { usageCount: usageTotal, usagesShown: usages.length } : {}),
    ...(dangling ? { danglingCount: danglingTotal, danglingShown: danglingRows.length } : {}),
    ...(preset && preset.consoleReferenceCount !== null
      ? { consoleReferenceNote: "consoleReferenceCount is the console's own count of objects referencing the preset (its References property); it counts other kinds of objects too and is not a stop criterion" }
      : {}),
    ...(executorScan ? { executorScan } : {}),
    ...(executors ? { executors } : {}),
    limitations: USAGE_LIMITATIONS,
    usages: target ? usages : undefined,
    dangling: dangling ? danglingRows : undefined,
    unread: unread.length ? unread.slice(0, 20) : undefined,
  };
  for (const k of Object.keys(result)) if (result[k] === undefined) delete result[k];
  const anyRead = cuesScanned > 0 || seqList.answered;
  return { content: [{ type: "text", text: renderLines(result, ["usages", "dangling", "executors", "unread"]) }], ...(anyRead ? {} : { isError: true }) };
}

// ---------------------------------------------------------------------------
// gma3_cue_diff
// ---------------------------------------------------------------------------

interface CueSide {
  sequence: number;
  cue: string;
}

function parseSide(v: Validator, field: string, raw: unknown, fallbackSeq?: number): CueSide | undefined {
  const r = asRow(raw);
  if (!raw || typeof raw !== "object") {
    v.fail(`${field} must be {sequence, cue}`);
    return undefined;
  }
  const sequence = r.sequence === undefined && fallbackSeq !== undefined ? fallbackSeq : v.check(() => objectNumber(`${field}.sequence`, r.sequence));
  const cue = v.check(() => cueNumber(`${field}.cue`, r.cue));
  return sequence !== undefined && cue !== undefined ? { sequence, cue } : undefined;
}

/**
 * A recipe line as a comparable object: every behaviour-affecting field cueContents returns (RECIPE_KEYS), so two
 * lines that differ only in FadeX, DelayX, SpeedX, PhaseX, MAtricks, filter or generator never compare equal (review
 * of #129). The resolved preset reference is reduced to its address; the internal presetDataKey is left out.
 */
const recipeOf = (r: Row): Row => {
  const out: Row = {};
  for (const k of RECIPE_KEYS) {
    if (k === "presetDataKey") continue;
    const v = r[k];
    if (k === "presetRef") {
      const ref = asRow(v);
      out[k] = v && typeof v === "object" ? (ref.addrNative ?? ref.addr ?? null) : (v ?? null);
    } else out[k] = v === undefined ? null : v;
  }
  return out;
};

/** Part-level properties that are compared: name, timing, command, MIB, recipe lines. */
function partProps(p: PartRead): Row {
  const out: Row = { name: p.name };
  for (const k of PART_TIMING_KEYS) out[`timing.${k}`] = p.timing[k] ?? null;
  for (const k of ["text", "delay", "enabled"]) out[`command.${k}`] = p.command[k] ?? null;
  for (const k of ["mode", "target", "fade", "delay"]) out[`mib.${k}`] = p.mib[k] ?? null;
  out.recipes = p.recipes.map(recipeOf);
  return out;
}

const norm = (x: unknown) => (typeof x === "string" ? x.trim() : x === undefined ? null : x);

function propDiff(a: Row, b: Row, keys: readonly string[]): Row[] {
  const out: Row[] = [];
  for (const k of keys) {
    const x = norm(a[k]);
    const y = norm(b[k]);
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field: k, a: x, b: y });
  }
  return out;
}

/** The values of a cue keyed by fixture|attribute; a key stored in two parts keeps both (part in the key). */
function valueMap(c: CueRead): Map<string, { fixture: string; attribute: string; part: number | null; v: Row }> {
  const out = new Map<string, { fixture: string; attribute: string; part: number | null; v: Row }>();
  for (const p of c.parts) {
    for (const r of p.rows) {
      let key = `${r.fixture}|${r.attribute}`;
      if (out.has(key)) key = `${key}|part ${p.part}`;
      out.set(key, { fixture: r.fixture, attribute: r.attribute, part: p.part, v: valueOf(r, { identity: true }) });
    }
  }
  return out;
}

/** The structured difference of two read cues (pure; exported for tests). */
export function diffCues(a: CueRead, b: CueRead): { cue: Row[]; parts: Row[]; values: Row[]; counts: Row; presets: Row } {
  const cueKeys = CUE_KEYS.filter((k) => k !== "no");
  const cue = propDiff(a.props, b.props, cueKeys);
  const parts: Row[] = [];
  const partNos = [...new Set([...a.parts.map((p) => p.part), ...b.parts.map((p) => p.part)])].sort((x, y) => (x ?? -1) - (y ?? -1));
  for (const n of partNos) {
    const pa = a.parts.find((p) => p.part === n);
    const pb = b.parts.find((p) => p.part === n);
    if (!pa || !pb) {
      parts.push({ part: n, only: pa ? "a" : "b" });
      continue;
    }
    const pka = partProps(pa);
    const changes = propDiff(pka, partProps(pb), Object.keys(pka));
    if (changes.length) parts.push({ part: n, changes });
  }
  const ma = valueMap(a);
  const mb = valueMap(b);
  const values: Row[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let same = 0;
  for (const key of new Set([...ma.keys(), ...mb.keys()])) {
    const x = ma.get(key);
    const y = mb.get(key);
    const id = (x ?? y)!;
    if (x && y) {
      // An address field is reported only when its label is the same: then the preset differs by its data pool.
      const raw = changedFields(x.v, y.v);
      const labelOf: Record<string, string> = { presetAddr: "preset", relPresetAddr: "relPreset", stepPresetAddrs: "stepPresets" };
      const fields = raw.filter((f) => !(f in labelOf && raw.includes(labelOf[f])));
      if (x.part !== y.part) fields.push("part");
      if (!fields.length) {
        same++;
        continue;
      }
      changed++;
      values.push({ fixture: id.fixture, attribute: id.attribute, change: "changed", fields, a: { part: x.part, ...x.v }, b: { part: y.part, ...y.v } });
    } else if (y) {
      added++;
      values.push({ fixture: id.fixture, attribute: id.attribute, change: "added", b: { part: y.part, ...y.v } });
    } else {
      removed++;
      values.push({ fixture: id.fixture, attribute: id.attribute, change: "removed", a: { part: x!.part, ...x!.v } });
    }
  }
  values.sort((p, q) => fixtureOrder(String(p.fixture), String(q.fixture)) || String(p.attribute).localeCompare(String(q.attribute)));
  // A preset is keyed by its label and, when known, its full address: same-labelled presets of two data pools are two
  // presets (review of #129). The lists show the short label, with the address only where two presets share a label.
  const presetsOf = (m: typeof ma, c: CueRead) => {
    const s = new Map<string, string>();
    const add = (label: unknown, addr: unknown, suffix = "") => s.set(`${label}${addr ? ` @ ${addr}` : ""}${suffix}`, `${label}${suffix}`);
    for (const e of m.values()) for (const k of ["preset", "relPreset"]) if (typeof e.v[k] === "string") add(e.v[k], e.v[`${k}Addr`]);
    for (const e of m.values()) {
      const addrs = asList(e.v.stepPresetAddrs);
      asList(e.v.stepPresets).forEach((p, i) => { if (p !== null) add(p, addrs[i]); });
    }
    for (const p of c.parts) for (const r of p.recipes) {
      const info = asRow(r.presetRef) as unknown as ObjectRefInfo;
      const l = refLabel(info);
      if (l && Object.keys(asRow(r.presetRef)).length) add(l, refAddress(info), " (recipe)");
    }
    return s;
  };
  const pa = presetsOf(ma, a);
  const pb = presetsOf(mb, b);
  const labels = new Map<string, Set<string>>();
  for (const [key, label] of [...pa, ...pb]) labels.set(label, (labels.get(label) ?? new Set()).add(key));
  const shown = (key: string) => {
    const label = (pa.get(key) ?? pb.get(key))!;
    return (labels.get(label)?.size ?? 0) > 1 ? key : label;
  };
  return {
    cue,
    parts,
    values,
    counts: { aValues: ma.size, bValues: mb.size, added, removed, changed, same },
    presets: { onlyA: [...pa.keys()].filter((x) => !pb.has(x)).map(shown).sort(), onlyB: [...pb.keys()].filter((x) => !pa.has(x)).map(shown).sort(), both: [...pa.keys()].filter((x) => pb.has(x)).length },
  };
}

export async function cueDiff(ctx: ToolContext, raw: { a?: unknown; b?: unknown; offset?: unknown; limit?: unknown; data_pool?: unknown }): Promise<ToolResult> {
  const tool = "gma3_cue_diff";
  const v = new Validator();
  const a = parseSide(v, "a", raw.a);
  const b = parseSide(v, "b", raw.b, a?.sequence);
  const limit = intArg(v, "limit", raw.limit, 1, 2000, 200);
  const offset = intArg(v, "offset", raw.offset, 0, 1000000, 0);
  const dataPool = raw.data_pool === undefined ? undefined : v.check(() => objectNumber("data_pool", raw.data_pool));
  if (a && b && a.sequence === b.sequence && a.cue === b.cue) v.fail("a and b are the same cue");
  if (!v.ok || !a || !b) return validationError(tool, v.errors);
  const bridge = scopedBridge(ctx.bridge, dataPool);
  const t = Math.max(ctx.requestTimeoutMs, Math.min(ctx.requestTimeoutMs * 3, 60000));
  const ca = await readCue(bridge, a.sequence, a.cue, t);
  const cb = await readCue(bridge, b.sequence, b.cue, t);
  for (const c of [ca, cb]) if (c.error) return toolError(tool, `${c.ref} could not be read: ${c.error}`);
  const reasons: string[] = [];
  for (const c of [ca, cb]) {
    const why = cueUnread(c);
    if (why) reasons.push(`${c.ref}: ${why}`);
  }
  const d = diffCues(ca, cb);
  const page = d.values.slice(offset, offset + limit);
  const identical = !d.cue.length && !d.parts.length && !d.values.length;
  const complete = reasons.length === 0;
  const counts = d.counts as Record<string, number>;
  const summary = identical
    ? complete
      ? "the two cues store the same data and have the same cue and part properties"
      : "no difference in what was read, but the read is INCOMPLETE, so the cues may still differ"
    : `values: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed (${counts.same} the same); ${d.cue.length} cue propert${d.cue.length === 1 ? "y" : "ies"} and ${d.parts.length} part(s) differ`;
  const result: Row = {
    tool,
    ...(dataPool !== undefined ? { dataPool } : {}),
    a: { ref: ca.ref, name: ca.name, parts: ca.parts.length },
    b: { ref: cb.ref, name: cb.name, parts: cb.parts.length },
    complete,
    identical: complete ? identical : null,
    summary: `${summary}.`,
    ...(reasons.length ? { reasons } : {}),
    counts: d.counts,
    presets: d.presets,
    cue: d.cue,
    parts: d.parts,
    total: d.values.length,
    offset,
    count: page.length,
    ...(offset + page.length < d.values.length ? { truncated: true, note: `read the rest with offset ${offset + page.length}` } : {}),
    compared: "STORED data only: what each cue stores (hard, blocked and cooked values). Values tracked into a cue from earlier cues are not part of it; gma3_tracking_leaks folds tracking. value is percent; preset names the referenced preset; a deleted preset reads as an invalid reference.",
    values: page,
  };
  return { content: [{ type: "text", text: renderLines(result, ["values", "parts"]) }] };
}

// ---------------------------------------------------------------------------
// gma3_tracking_leaks
// ---------------------------------------------------------------------------

/** A Break or TrackingDistance text that means "not set". */
// "#FFFFFFFFFFFFFFFF" is how onPC 2.5.1 reads the Break of a cue without one (docs/probes/cue-part-data-macos-2.5.1.md).
const UNSET = /^\s*(|none|<none>|empty|<empty>|off|no|-|0|#F{16})\s*$/i;
export const isSet = (v: unknown) => v !== null && v !== undefined && !UNSET.test(String(v));

interface Run {
  fixture: string;
  attribute: string;
  from: string;
  value: Row;
  cues: number;
  last: string;
  revisits: string[];
  excluded?: string;
}

export interface LeakOptions {
  minCues: number;
  requireRevisit: boolean;
}

export interface LeakFold {
  candidates: Row[];
  excluded: { trackingDistance: number };
  /** Runs cut at a Break (not evaluated past it). */
  cutByBreak: number;
  /** The Break and TrackingDistance texts read as "set", so a reader can tell a real setting from an unrecognised empty text. */
  setTexts: { break: string[]; trackingDistance: string[] };
  breaks: string[];
  releases: string[];
  runs: number;
}

/**
 * The tracking-leak heuristic over cues in order (pure; exported for tests). Per fixture|attribute a run starts where
 * the value is stored and counts every later cue it is still effective in; it ends at a cue that stores the
 * attribute again (restated, blocked, cooked), at a cue with Release, at a cue with a Break (its filter is not
 * evaluated: the run is counted up to that cue), or at an unread cue (unknown from there). A run is a candidate when it
 * tracks through at least minCues cues and, with requireRevisit, at least one of them stores another attribute of the
 * same (sub)fixture without restating this one. Values stored in a part with a TrackingDistance are excluded (counted).
 */
export function foldLeaks(cues: CueRead[], opts: LeakOptions, reachedEnd: boolean): LeakFold {
  const open = new Map<string, Run>();
  const out: LeakFold = { candidates: [], excluded: { trackingDistance: 0 }, cutByBreak: 0, setTexts: { break: [], trackingDistance: [] }, breaks: [], releases: [], runs: 0 };
  const seen = (list: string[], text: string) => {
    if (list.length < 5 && !list.includes(text)) list.push(text);
  };
  const close = (run: Run, endedBy: string) => {
    out.runs++;
    if (run.excluded) {
      out.excluded.trackingDistance++;
      return;
    }
    if (run.cues < opts.minCues || (opts.requireRevisit && run.revisits.length === 0)) return;
    out.candidates.push({ fixture: run.fixture, attribute: run.attribute, storedIn: run.from, value: run.value, trackedThrough: run.cues, lastEffective: run.last, revisitedIn: firstFew(run.revisits, 6), revisits: run.revisits.length, endedBy });
  };
  for (const c of cues) {
    const unread = cueUnread(c);
    if (unread) {
      for (const run of open.values()) close(run, `unknown: cue ${c.cue} could not be read`);
      open.clear();
      continue;
    }
    const stored = new Map<string, PresetRow>();
    // The TrackingDistance of the part that stores each value: it excludes only that part's values (review of #129).
    const distanceOf = new Map<string, boolean>();
    for (const p of c.parts) {
      const d = isSet(p.timing.trackingDistance);
      for (const r of p.rows) {
        const key = `${r.fixture}|${r.attribute}`;
        stored.set(key, r);
        distanceOf.set(key, (distanceOf.get(key) ?? false) || d);
      }
    }
    const touched = new Set([...stored.values()].map((r) => r.fixture));
    const release = parseConsoleBoolean(c.props.release ?? "") === true;
    const brk = isSet(c.props.break) ? String(c.props.break) : undefined;
    if (release) out.releases.push(c.cue);
    if (brk) {
      out.breaks.push(c.cue);
      seen(out.setTexts.break, brk);
    }
    for (const [key, run] of [...open]) {
      if (stored.has(key)) {
        close(run, `restated in cue ${c.cue}`);
        open.delete(key);
      } else if (release || brk) {
        if (!release && !run.excluded) out.cutByBreak++;
        close(run, release ? `released by cue ${c.cue} (Release)` : `cue ${c.cue} has a Break (${brk}), not evaluated: counted up to the cue before`);
        open.delete(key);
      } else {
        run.cues++;
        run.last = c.cue;
        if (touched.has(run.fixture)) run.revisits.push(c.cue);
      }
    }
    for (const p of c.parts) if (isSet(p.timing.trackingDistance)) seen(out.setTexts.trackingDistance, String(p.timing.trackingDistance));
    for (const [key, r] of stored) open.set(key, { fixture: r.fixture, attribute: r.attribute, from: c.cue, value: valueOf(r, { identity: true }), cues: 0, last: c.cue, revisits: [], ...(distanceOf.get(key) ? { excluded: "trackingDistance" } : {}) });
  }
  for (const run of open.values()) close(run, reachedEnd ? "end of the sequence (still on until OffCue or another release)" : "end of the scanned range");
  out.candidates.sort((p, q) => (q.revisits as number) - (p.revisits as number) || (q.trackedThrough as number) - (p.trackedThrough as number) || fixtureOrder(String(p.fixture), String(q.fixture)));
  return out;
}

export const LEAK_HEURISTIC =
  "Folded from STORED cue data in cue order (CueZero and OffCue left out). A run starts where a fixture|attribute value is stored and counts each later cue it is still effective in (not stored there). " +
  "It ends at a cue that stores the attribute again (a restated, blocked or cooked value), at a cue with Release Yes, at a cue with a Break (its filter or world is NOT evaluated, so the run is only counted up to the cue before), or at an unread cue. " +
  "A run is a CANDIDATE when it tracks through at least min_cues cues and (require_revisit, default true) at least one of those cues stores another attribute of the same (sub)fixture without restating this one: the fixture was worked on there, but this value was left to track. " +
  "Values stored in a part that has a TrackingDistance are excluded and counted (the distance itself is not evaluated). This is a heuristic: a candidate can be intended (a gobo kept on purpose); a value that tracks through cues that never touch the fixture is not a candidate unless require_revisit is false.";

export async function trackingLeaks(
  ctx: ToolContext,
  raw: { sequence?: unknown; from?: unknown; to?: unknown; min_cues?: unknown; require_revisit?: unknown; max_cues?: unknown; max_seconds?: unknown; max_results?: unknown; data_pool?: unknown },
): Promise<ToolResult> {
  const tool = "gma3_tracking_leaks";
  const v = new Validator();
  const sequence = v.check(() => objectNumber("sequence", raw.sequence));
  const from = raw.from === undefined ? undefined : v.check(() => cueNumber("from", raw.from));
  const to = raw.to === undefined ? undefined : v.check(() => cueNumber("to", raw.to));
  if (from !== undefined && to !== undefined && Number(to) < Number(from)) v.fail("to must be >= from");
  const minCues = intArg(v, "min_cues", raw.min_cues, 1, 10000, 2);
  const maxCues = intArg(v, "max_cues", raw.max_cues, 1, 5000, 500);
  const maxSeconds = intArg(v, "max_seconds", raw.max_seconds, 5, 600, 90);
  const maxResults = intArg(v, "max_results", raw.max_results, 1, 1000, 100);
  const dataPool = raw.data_pool === undefined ? undefined : v.check(() => objectNumber("data_pool", raw.data_pool));
  if (!v.ok || sequence === undefined) return validationError(tool, v.errors);
  const requireRevisit = raw.require_revisit !== false;
  const bridge = scopedBridge(ctx.bridge, dataPool);
  const t = ctx.requestTimeoutMs;
  const tRead = Math.max(t, Math.min(t * 3, 60000));
  const reasons: string[] = [];
  const unconfirmed = await unconfirmedListings(ctx.bridge, t);
  if (unconfirmed) reasons.push(unconfirmed);
  const listing = await listCues(bridge, sequence, t);
  if (!listing.answered && listing.cues.length === 0) return toolError(tool, `Sequence ${sequence} could not be read: ${listing.reason ?? "no answer"}`);
  if (!listing.complete) reasons.push(`the cue listing is incomplete: ${listing.reason}`);
  const inRange = listing.cues.filter((c) => (from === undefined || c.no >= Number(from) - 1e-9) && (to === undefined || c.no <= Number(to) + 1e-9));
  const budget = new Budget(maxCues, maxSeconds);
  const read: CueRead[] = [];
  let stopped: string | undefined;
  let tracking: boolean | null = null;
  for (const c of inRange) {
    const why = budget.exhausted();
    if (why) {
      stopped = `${why} after ${read.length} of ${inRange.length} cues; narrow the range with from/to or raise max_cues`;
      break;
    }
    budget.cues++;
    const cue = await readCue(bridge, sequence, c.cue, tRead);
    read.push(cue);
    if (tracking === null && !cue.error) tracking = cue.tracking;
    if (tracking === false) break;
  }
  const base: Row = { tool, ...(dataPool !== undefined ? { dataPool } : {}), sequence, tracking };
  if (tracking === false) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ...base, complete: reasons.length === 0, summary: `Sequence ${sequence} has Tracking off: stored values do not track into later cues, so there are no tracking leaks.`, ...(reasons.length ? { reasons } : {}) }) }],
    };
  }
  if (tracking === null) reasons.push("the sequence's Tracking setting could not be read; tracking was assumed on");
  if (stopped) reasons.push(stopped);
  const unreadCues = read.filter((c) => cueUnread(c));
  if (unreadCues.length) reasons.push(`${unreadCues.length} cue(s) could not be fully read; runs end there as unknown (see unread)`);
  const lastCue = listing.cues[listing.cues.length - 1];
  const reachedEnd = !stopped && listing.complete && (to === undefined || (lastCue !== undefined && lastCue.no <= Number(to) + 1e-9));
  const fold = foldLeaks(read, { minCues, requireRevisit }, reachedEnd);
  const uncertain: string[] = [];
  if (fold.breaks.length) uncertain.push(`cue(s) ${firstFew(fold.breaks, 10).join(", ")} have a Break (read as ${fold.setTexts.break.map((x) => JSON.stringify(x)).join(", ")}) whose filter was not evaluated: ${fold.cutByBreak} run(s) reaching them were counted only up to the cue before, so a leak past a Break is not shown`);
  if (fold.excluded.trackingDistance) uncertain.push(`${fold.excluded.trackingDistance} value run(s) stored in parts with a TrackingDistance (read as ${fold.setTexts.trackingDistance.map((x) => JSON.stringify(x)).join(", ")}) were excluded`);
  if (from !== undefined && listing.cues.length && listing.cues[0].no < Number(from) - 1e-9) uncertain.push(`values stored before cue ${from} are not known: the scan starts at cue ${from}`);
  const complete = reasons.length === 0;
  const n = fold.candidates.length;
  const summary = n
    ? `${n} candidate value(s) keep tracking through ${minCues}+ later cue(s)${requireRevisit ? " that revisit the fixture" : ""} without being restated${complete ? "" : " (in what was read)"}`
    : complete && (fold.cutByBreak || fold.excluded.trackingDistance)
      ? `no candidate among the runs evaluated in cues ${inRange[0]?.cue ?? "-"} to ${inRange[inRange.length - 1]?.cue ?? "-"}, but ${fold.cutByBreak} run(s) cut at a Break and ${fold.excluded.trackingDistance} excluded for a TrackingDistance were NOT evaluated (see uncertain)`
      : complete
      ? `no candidate in cues ${inRange[0]?.cue ?? "-"} to ${inRange[inRange.length - 1]?.cue ?? "-"} under the heuristic${uncertain.length ? " (see uncertain)" : ""}`
      : "no candidate found in what was read; the scan is INCOMPLETE, so this does not show that there are no leaks";
  const unread = unreadCues.slice(0, 20).map((c) => ({ cue: c.cue, reason: cueUnread(c) }));
  const result: Row = {
    ...base,
    complete,
    summary: `${summary}.`,
    ...(reasons.length ? { reasons } : {}),
    ...(uncertain.length ? { uncertain } : {}),
    coverage: { cuesInSequence: listing.cues.length, cuesInRange: inRange.length, cuesRead: read.length - unreadCues.length, cuesUnread: unreadCues.length, notScanned: "CueZero and OffCue" },
    options: { minCues, requireRevisit },
    runs: fold.runs,
    notEvaluated: { cutByBreak: fold.cutByBreak, trackingDistance: fold.excluded.trackingDistance },
    candidateCount: n,
    shown: Math.min(n, maxResults),
    ...(fold.releases.length ? { releaseCues: firstFew(fold.releases, 20) } : {}),
    heuristic: LEAK_HEURISTIC,
    candidates: fold.candidates.slice(0, maxResults),
    unread: unread.length ? unread : undefined,
  };
  if (result.unread === undefined) delete result.unread;
  return { content: [{ type: "text", text: renderLines(result, ["candidates", "unread"]) }] };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const READ_ONLY =
  "Read-only, works with gma3_lua disabled: it reads stored cue data (cueContents, and preset.read on each cue part: GetPresetData, bridge 0.24.0) and never plays, loads, selects or changes anything. ";

const budgetShape = {
  max_cues: z.number().int().min(1).max(5000).optional().describe("Cue budget per call (default 300 for usages, 500 for leaks). Each cue costs one read plus one per part with data."),
  max_seconds: z.number().int().min(5).max(600).optional().describe("Time budget per call in seconds (default 90)."),
  max_results: z.number().int().min(1).max(1000).optional().describe("Rows returned at most (default 100); the counts are always complete for what was scanned."),
};

const cueSide = z.object({ sequence: z.number().int().optional(), cue: z.union([z.number(), z.string()]) });

export const registerAnalysisTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_preset_usage",
    {
      title: "Where a preset is used, and dangling preset references",
      description:
        "Which sequences, cues and parts reference a preset (preset: \"4.12\"), with per part the number of channels, fixtures, attributes and how it is referenced (absolute, relative, phaser step, cooked, recipe line), and which executors play those sequences. " +
        "dangling: true finds cue data whose preset reference is an invalid handle, and recipe lines whose preset text no longer resolves: it says where (sequence, cue, part, fixture, attribute) but cannot say which preset it was. NOTE (onPC 2.5.1): deleting a preset turns the cue values that referenced it into plain values, with no reference left, so a deleted preset usually leaves nothing to find. Both can be asked in one call. " +
        READ_ONLY +
        "Scans every sequence (or `sequences`) in number order within a cue and time budget; a stopped scan returns next.resume to continue. complete: false with reasons whenever anything was not read (budget, a failed read, a part over 5000 values, an incomplete listing, a bridge older than 0.47.0 for listings or 0.24.0 for part data): then \"no usage found\" is NOT proof that the preset is unused. " +
        "Not searched: presets that embed this one, CueZero and OffCue, macros, timecodes and command text. preset.consoleReferenceCount is the console's own reference count, for comparison. Output is capped by max_results.",
      inputSchema: {
        ...dataPoolShape,
        preset: z.string().optional().describe('The preset, "4.12" or "Preset 4.12".'),
        dangling: z.boolean().optional().describe("Also (or only) report references to deleted presets (default false)."),
        sequences: z.array(z.number().int()).optional().describe("Only these sequence numbers (default every sequence of the data pool)."),
        executors: z.boolean().optional().describe("List the executors that play sequences with a usage (default true)."),
        resume: z.object({ sequence: z.number().int(), cue: z.union([z.number(), z.string()]) }).optional().describe("Continue a stopped scan from next.resume of the previous result."),
        ...budgetShape,
      },
    },
    async (args) => presetUsage(ctx, args as PresetUsageArgs).catch((err: unknown) => toolError("gma3_preset_usage", errText(err))),
  );

  server.registerTool(
    "gma3_cue_diff",
    {
      title: "Diff the stored data of two cues",
      description:
        "Structured difference between two cues of the same or different sequences: per fixture and attribute the values added, removed and changed (value, phaser steps, relative, referenced preset, fade, delay, cooked, part) with the changed fields named; " +
        "the presets only one cue references; and the cue properties (name, trigger, release, assert, break, note, ...) and per part the timing, command, MIB and recipe lines that differ. " +
        READ_ONLY +
        "STORED data only: values tracked into a cue from earlier cues are not part of it (use gma3_tracking_leaks for tracking). complete: false with reasons when a part could not be fully read; identical is then null. Value rows are paged (offset/limit, default 200).",
      inputSchema: {
        ...dataPoolShape,
        a: cueSide.describe("First cue: {sequence, cue}."),
        b: cueSide.describe("Second cue: {sequence (default a's), cue}."),
        offset: z.number().int().min(0).optional().describe("Value rows to skip (paging)."),
        limit: z.number().int().min(1).max(2000).optional().describe("Value rows per page (default 200)."),
      },
    },
    async (args) => cueDiff(ctx, args as Record<string, unknown>).catch((err: unknown) => toolError("gma3_cue_diff", errText(err))),
  );

  server.registerTool(
    "gma3_tracking_leaks",
    {
      title: "Find values that keep tracking unintentionally",
      description:
        "Candidates for tracking leaks in one sequence: values stored in a cue that are still effective many cues later, where those later cues work on the same fixture but do not restate the value. Each candidate: fixture, attribute, storedIn, value, trackedThrough (cues), lastEffective, revisitedIn, endedBy. " +
        READ_ONLY +
        `HEURISTIC: ${LEAK_HEURISTIC} ` +
        "A sequence with Tracking off has no leaks. complete: false with reasons when cues were not read (budget: narrow with from/to); an incomplete result never claims there are no leaks. Not evaluated: Break filters, TrackingDistance values, released values stored as such, wrap-around of looping sequences.",
      inputSchema: {
        ...dataPoolShape,
        sequence: z.number().int().describe("Sequence number."),
        from: z.union([z.number(), z.string()]).optional().describe("First cue to scan (default the first cue). Values stored before it are not known."),
        to: z.union([z.number(), z.string()]).optional().describe("Last cue to scan (default the last cue)."),
        min_cues: z.number().int().min(1).optional().describe("Later cues a value must track through to be a candidate (default 2)."),
        require_revisit: z.boolean().optional().describe("Only values whose fixture gets other attributes stored in at least one of those cues (default true)."),
        ...budgetShape,
      },
    },
    async (args) => trackingLeaks(ctx, args as Record<string, unknown>).catch((err: unknown) => toolError("gma3_tracking_leaks", errText(err))),
  );
};
