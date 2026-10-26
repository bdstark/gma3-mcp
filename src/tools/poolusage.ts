/**
 * Issue #96: gma3_pool_usage, which pool numbers a show already uses, before the first store.
 *
 *   gma3_pool_usage  per pool: the stored count, the used numbers as ranges ("1-11, 5001-5534"), optionally
 *                    [no, name] pairs, and the first free block of a requested size
 *
 * Field evidence (Halloween 2026 build, server 0bade8e, bridge 0.44.0): to find the numbers the Show Start show
 * used, the agent read `gma3_objects` "Sequence Thru" and "Macro Thru" (138 KB and 172 KB, over the client's limit),
 * missed 270 of 770 macros because the read stopped at the default limit of 500, and walked the preset pools and
 * every page's executors in Lua (a nil child broke the first try).
 *
 * Built on the existing `children` op only (no bridge change):
 *   - `children` lists the objects a parent holds, densely (the executor scan in playback.ts reads pages the same
 *     way), with `total` = the number of children. A pool object's `index` is its number (macro 5893 of 770). A
 *     preset pool reads `No` "4 (1000)": Count() is 1000 slots, but only stored presets are children, so the count
 *     here is the listed objects, never the slots.
 *   - Every read is paged (limit/offset), so a pool of more than one page is complete; a failed page, a total that
 *     changes between pages or an object without a number leaves the pool `complete: false` with the reason, and no
 *     free block is offered from an incomplete read.
 *   - Executors are read per page with `children` on "Page P" (fields No and Object, asText false: the assigned
 *     object as a handle summary with class and name). A page or executor range never goes to ObjectList: it can
 *     hang onPC 2.5.1 for good (docs/lua.md, the bridge's [unsafe-range] guard), and this tool accepts no range.
 *
 * Also here: the `truncated` flag and the compact form that gma3_objects and gma3_list_children (src/index.ts) add to
 * a bridge listing.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import type { ToolResult } from "../results.js";
import type { RegisterTools, ToolContext } from "./context.js";
import { dataPoolShape, scopedBridge } from "./datapool.js";

// ---------------------------------------------------------------------------
// Listings: truncated flag and compact form (gma3_objects, gma3_list_children)
// ---------------------------------------------------------------------------

/**
 * Mark a bridge listing ({total, offset, count, items}) whose items stop before the end: `truncated: true` and a
 * note with the offset of the rest. A listing without numeric total/count is returned unchanged.
 */
export function markTruncated(res: unknown): unknown {
  if (!res || typeof res !== "object" || Array.isArray(res)) return res;
  const r = res as Record<string, unknown>;
  const total = r.total;
  const count = typeof r.count === "number" ? r.count : Array.isArray(r.items) ? r.items.length : undefined;
  if (typeof total !== "number" || count === undefined) return res;
  const offset = typeof r.offset === "number" ? r.offset : 0;
  if (count >= total || offset + count >= total) return res;
  return { ...r, truncated: true, note: `truncated: ${count} of ${total} items from offset ${offset}; read the rest with offset ${offset + count}` };
}

/** Drop addr and addrNative from every item of a listing (compact form, when fields are read). */
export function compactListing(res: unknown): unknown {
  if (!res || typeof res !== "object" || !Array.isArray((res as { items?: unknown }).items)) return res;
  const r = res as { items: unknown[] };
  return {
    ...r,
    items: r.items.map((it) => {
      if (!it || typeof it !== "object") return it;
      const { addr: _a, addrNative: _n, ...rest } = it as Record<string, unknown>;
      return rest;
    }),
  };
}

/** A gma3_objects / gma3_list_children result: truncated flag always; compact (minified, no addresses) on request. */
export function shapeListing(res: unknown, opts: { compact?: boolean; fields?: readonly string[] }): unknown {
  const marked = markTruncated(res);
  if (opts.compact && opts.fields && opts.fields.length > 0) return JSON.stringify(compactListing(marked));
  return marked;
}

// ---------------------------------------------------------------------------
// Ranges and free blocks
// ---------------------------------------------------------------------------

/** Sorted distinct numbers as compact ranges: [1,2,3,7,9,10] -> "1-3, 7, 9-10". "" for none. */
export function compressRanges(numbers: Iterable<number>): string {
  const sorted = [...new Set(numbers)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

const block = (first: number, size: number) => (size === 1 ? String(first) : `${first}-${first + size - 1}`);

/** Pool, page and preset numbers searched for a free block: 1..MAX_POOL_NUMBER. */
export const MAX_POOL_NUMBER = 9999;

/** The first `size` consecutive numbers in from..max that none of `used` takes, as "21-40"; null when there is none. */
export function firstFreeBlock(used: Iterable<number>, size: number, from = 1, max = MAX_POOL_NUMBER): string | null {
  const sorted = [...new Set(used)].sort((a, b) => a - b);
  let start = Math.max(1, from);
  for (const u of sorted) {
    if (u < start) continue;
    if (u - start >= size) break;
    start = u + 1;
  }
  return start + size - 1 <= max ? block(start, size) : null;
}

/** Executor numbers per row: 101-198, 201-298 (columns 91-98 are the Xkeys), 301-390, 401-490 (executors.ts). */
const EXECUTOR_ROWS = [1, 2, 3, 4].map((row) => ({ first: row * 100 + 1, last: row * 100 + (row <= 2 ? 98 : 90) }));

/** The first free block of `size` executors from `from` (default 101) inside one row; null when there is none. */
export function firstFreeExecutors(used: Iterable<number>, size: number, from = 101): string | null {
  const taken = [...used];
  for (const row of EXECUTOR_ROWS) {
    if (row.last < from) continue;
    const hit = firstFreeBlock(
      taken.filter((n) => n >= row.first && n <= row.last),
      size,
      Math.max(row.first, from),
      row.last,
    );
    if (hit !== null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paged children reads
// ---------------------------------------------------------------------------

interface Item {
  name?: string;
  class?: string;
  addr?: string;
  index?: number;
  invalid?: boolean;
  fields?: Record<string, unknown>;
  /** Bridge 0.47.0: the fields whose read raised, with the error (absent before 0.47.0 and when every read worked). */
  fieldErrors?: Record<string, unknown>;
}

interface Listing {
  total?: number;
  count?: number;
  items?: Item[];
}

/** Children per request; a pool of more than this many objects takes several. */
export const PAGE_SIZE = 500;
/** Requests per listing at most (500 000 objects): a guard against a total that never ends. */
const MAX_PAGES = 1000;

interface ReadAll {
  items: Item[];
  complete: boolean;
  reason?: string;
  requests: number;
  /** At least one request was answered: there is data (or a successful empty listing), complete or not. */
  answered: boolean;
}

/** Every child of `ref`, page by page. Never throws: a failed page ends the read with what was read and the reason. */
export async function readAllChildren(bridge: Gma3Bridge, ref: string, args: Record<string, unknown>, timeoutMs: number): Promise<ReadAll> {
  const items: Item[] = [];
  let total: number | undefined;
  let offset = 0;
  let requests = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Listing;
    try {
      requests++;
      res = ((await bridge.request("children", { ref, ...args, limit: PAGE_SIZE, offset }, timeoutMs)) ?? {}) as Listing;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { items, complete: false, reason: offset === 0 ? msg : `the read at offset ${offset} failed after ${items.length} objects: ${msg}`, requests, answered: requests > 1 };
    }
    const got = Array.isArray(res.items) ? res.items : [];
    items.push(...got);
    if (typeof res.total === "number") {
      if (total !== undefined && res.total !== total) return { items, complete: false, reason: `the listing changed while it was read (${total} objects, then ${res.total})`, requests, answered: true };
      total = res.total;
      offset += PAGE_SIZE;
      if (offset >= total) return { items, complete: true, requests, answered: true };
      if (got.length === 0) return { items, complete: false, reason: `the listing reports ${total} objects but only ${items.length} could be read`, requests, answered: true };
    } else {
      // An answer without total: the listing ends with a short page.
      offset += got.length;
      if (got.length < PAGE_SIZE) return { items, complete: true, requests, answered: true };
    }
  }
  return { items, complete: false, reason: `stopped after ${MAX_PAGES} requests`, requests, answered: true };
}

/** The leading integer of a number or text ("4 (1000)" -> 4). */
function leadingInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  const m = typeof v === "string" ? v.match(/^\s*(\d+)/) : null;
  return m ? Number(m[1]) : undefined;
}

/** A pool object's number: its index. */
const poolNo = (it: Item) => (typeof it.index === "number" && Number.isInteger(it.index) ? it.index : undefined);
/** A page's or executor's number: No, else the index (as the executor scan in playback.ts reads them). */
const fieldNo = (it: Item) => leadingInt(it.fields?.No) ?? poolNo(it);

// ---------------------------------------------------------------------------
// Pool specs
// ---------------------------------------------------------------------------

/** DataPool children in the console's spelling (gma3_pool's list); a name is matched case-insensitively, another is sent as given. */
const POOL_NAMES = [
  "Groups", "Sequences", "Macros", "MAtricks", "Timecodes", "Layouts", "Worlds", "Filters", "Timers", "Views", "Appearances",
  "Plugins", "Quickeys", "Cameras", "Sounds", "ScreenConfigurations", "Agendas", "Images", "Videos", "Scribbles", "Gels",
];

type Spec =
  | { kind: "pool"; label: string; ref: string }
  | { kind: "preset"; label: string; ref: string; pool: number }
  | { kind: "presetPools"; label: string; ref: string }
  | { kind: "page"; label: string; ref: string; page: number }
  | { kind: "pages"; label: string; ref: string };

function poolNumber(text: string, what: string, original: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > MAX_POOL_NUMBER) throw new Error(`'${original}': the ${what} number must be 1-${MAX_POOL_NUMBER}`);
  return n;
}

/** One pool name of the call, parsed. Ranges, dotted executor numbers and anything else are refused before any read. */
export function parsePool(raw: string): Spec {
  const s = raw.trim().replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if (/^pages$/i.test(s)) return { kind: "pages", label: "Pages", ref: "DataPool.Pages" };
  if ((m = s.match(/^page (\d+)$/i))) {
    const page = poolNumber(m[1], "page", raw);
    return { kind: "page", label: `Page ${page}`, ref: `Page ${page}`, page };
  }
  if (/^(presets|preset ?pools)$/i.test(s)) return { kind: "presetPools", label: "PresetPools", ref: "DataPool.PresetPools" };
  if ((m = s.match(/^presets? (\d+)$/i))) {
    const pool = poolNumber(m[1], "preset pool", raw);
    return { kind: "preset", label: `Preset ${pool}`, ref: `Preset ${pool}`, pool };
  }
  if (/^[a-z][a-z0-9]*$/i.test(s)) {
    const name = POOL_NAMES.find((p) => p.toLowerCase() === s.toLowerCase()) ?? s;
    return { kind: "pool", label: name, ref: `DataPool.${name}` };
  }
  throw new Error(
    `'${raw}' is not a pool: give a DataPool pool name ("Groups", "Sequences", "Macros", "MAtricks", ...), "Preset 4", "PresetPools", "Page 2" or "Pages" (no ranges or executor numbers)`,
  );
}

// ---------------------------------------------------------------------------
// Reading one pool
// ---------------------------------------------------------------------------

interface Options {
  names: boolean;
  free?: { size: number; from?: number };
  /** Why executor free blocks are not offered (a bridge before 0.47.0); undefined when they are. */
  executorFreeBlocked?: string;
}

type Row = Record<string, unknown>;

/** Numbers and names of a listing's objects; objects without a number or unreadable make the read incomplete. */
function numbered(items: Item[], no: (it: Item) => number | undefined) {
  const out = new Map<number, Item>();
  let unnumbered = 0;
  for (const it of items) {
    if (!it || it.invalid) {
      unnumbered++;
      continue;
    }
    const n = no(it);
    if (n === undefined) unnumbered++;
    else if (!out.has(n)) out.set(n, it);
  }
  return { byNo: new Map([...out].sort(([a], [b]) => a - b)), unnumbered };
}

/** Rows whose listing answered at least once: usable data, even when incomplete. The call fails only without any. */
const ANSWERED = new WeakSet<Row>();

function finish(row: Row, used: number[], read: { complete: boolean; reason?: string; answered: boolean }, opts: Options, freeOf: (used: number[], size: number, from?: number) => string | null, blocked?: string): Row {
  if (read.answered) ANSWERED.add(row);
  row.complete = read.complete;
  if (!read.complete) row.reason = read.reason;
  if (opts.free) {
    if (blocked !== undefined) {
      row.free = null;
      row.freeNote = blocked;
    } else if (read.complete) {
      const hit = freeOf(used, opts.free.size, opts.free.from);
      row.free = hit;
      if (hit === null) row.freeNote = `no free block of ${opts.free.size}${opts.free.from !== undefined ? ` from ${opts.free.from}` : ""}`;
    } else {
      row.free = null;
      row.freeNote = "not searched: the read is incomplete";
    }
  }
  return row;
}

const generalFree = (used: number[], size: number, from?: number) => firstFreeBlock(used, size, from ?? 1);

async function readPool(bridge: Gma3Bridge, spec: Extract<Spec, { kind: "pool" | "preset" }>, opts: Options, t: number): Promise<Row> {
  const read = await readAllChildren(bridge, spec.ref, {}, t);
  const { byNo, unnumbered } = numbered(read.items, poolNo);
  const used = [...byNo.keys()];
  const row: Row = { pool: spec.label, stored: byNo.size, used: compressRanges(used) };
  if (opts.names) row.names = [...byNo].map(([n, it]) => [n, it.name ?? null]);
  if (unnumbered && read.complete) Object.assign(read, { complete: false, reason: `${unnumbered} object(s) without a number` });
  return finish(row, used, read, opts, generalFree);
}

/**
 * An executor's Object field read with asText false: the assigned object, "empty" (no object), or "unknown" when the
 * field holds something else, such as {invalid: true} for a handle that failed validation. An unknown assignment does
 * not show that the executor is free.
 */
function assigned(v: unknown): { class?: string; name?: string } | "empty" | "unknown" {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v !== "object") return "unknown";
  const o = v as Record<string, unknown>;
  if (o.invalid === true) return "unknown";
  const out: { class?: string; name?: string } = {};
  if (typeof o.class === "string") out.class = o.class;
  if (typeof o.name === "string") out.name = o.name;
  return Object.keys(out).length ? out : "unknown";
}

/** The executors of one page (by reference or address): assigned ones, and those without an object. */
/**
 * The executor numbers an assigned executor's Width covers after its own: the following numbers of its row (KB-21,
 * docs/probes/kb-21-executors-macos-2.5.1.md: 180 with Width 2 covers 181, which reads as a Proxy with no Object; the
 * feedback module's layout rule). A missing Width is 1; anything but a positive integer is null (coverage unknown).
 */
function coveredBy(n: number, width: unknown): number[] | null {
  if (width === undefined || width === null || width === "") return [];
  const w = leadingInt(width);
  if (w === undefined || w < 1 || (typeof width === "number" && !Number.isInteger(width))) return null;
  const row = EXECUTOR_ROWS.find((r) => n >= r.first && n <= r.last);
  const last = Math.min(n + w - 1, row ? row.last : n + w - 1);
  return numbersFrom(n + 1, last);
}

const numbersFrom = (from: number, to: number) => (to < from ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i));

async function readExecutors(bridge: Gma3Bridge, ref: string, t: number) {
  const read = await readAllChildren(bridge, ref, { fields: ["No", "Object", "Width"], asText: false }, t);
  const { byNo, unnumbered } = numbered(read.items, fieldNo);
  const used: Array<[number, string | null, string | null]> = [];
  const unassigned: number[] = [];
  const unknown: number[] = [];
  const covered = new Set<number>();
  const badWidth: number[] = [];
  for (const [n, it] of byNo) {
    // A failed Object read (bridge 0.47.0 names it in fieldErrors) says nothing about whether the executor is empty.
    const obj = it.fieldErrors?.Object !== undefined ? "unknown" : assigned(it.fields?.Object);
    if (obj === "empty") unassigned.push(n);
    else if (obj === "unknown") unknown.push(n);
    else {
      used.push([n, obj.class ?? null, obj.name ?? null]);
      const span = it.fieldErrors?.Width !== undefined ? null : coveredBy(n, it.fields?.Width);
      if (span === null) badWidth.push(n);
      else for (const c of span) covered.add(c);
    }
  }
  // A covered number (a Proxy without an Object, when listed at all) belongs to the wider executor: not free, not unassigned.
  const empty = unassigned.filter((n) => !covered.has(n));
  const problems = [
    ...(unnumbered ? [`${unnumbered} executor(s) without a number`] : []),
    ...(unknown.length ? [`the assignment of executor(s) ${compressRanges(unknown)} could not be read`] : []),
    ...(badWidth.length ? [`the Width of executor(s) ${compressRanges(badWidth)} could not be read, so the numbers they cover are unknown`] : []),
  ];
  if (problems.length) Object.assign(read, { complete: false, reason: read.complete ? problems.join("; ") : `${read.reason}; ${problems.join("; ")}` });
  return { read, used, empty, unknown, covered: [...covered].sort((a, b) => a - b) };
}

const executorFree = (used: number[], size: number, from?: number) => firstFreeExecutors(used, size, from ?? 101);

async function readPage(bridge: Gma3Bridge, spec: Extract<Spec, { kind: "page" }>, opts: Options, t: number): Promise<Row> {
  const { read, used, empty, unknown, covered } = await readExecutors(bridge, spec.ref, t);
  const nos = used.map(([n]) => n);
  const row: Row = { pool: spec.label, stored: used.length, used: compressRanges(nos), executors: used };
  if (covered.length) row.covered = compressRanges(covered);
  if (empty.length) row.unassigned = compressRanges(empty);
  if (unknown.length) row.unreadable = compressRanges(unknown);
  return finish(row, [...nos, ...covered], read, opts, executorFree, opts.executorFreeBlocked);
}

/**
 * Every child of a container (pages, preset pools) with a summary per child: [no, name, count, used ranges], where
 * count and used come from the child's own listing (executors with an object for a page, stored presets for a pool).
 */
async function readContainer(bridge: Gma3Bridge, spec: Extract<Spec, { kind: "pages" | "presetPools" }>, opts: Options, t: number): Promise<Row> {
  const pages = spec.kind === "pages";
  const read = await readAllChildren(bridge, spec.ref, pages ? { fields: ["No"], asText: false } : {}, t);
  const { byNo, unnumbered } = numbered(read.items, pages ? fieldNo : poolNo);
  const used = [...byNo.keys()];
  const rows: unknown[] = [];
  const failed: string[] = [];
  for (const [n, it] of byNo) {
    const ref = it.addr ?? (pages ? `Page ${n}` : `Preset ${n}`);
    if (pages) {
      const ex = await readExecutors(bridge, ref, t);
      rows.push([n, it.name ?? null, ex.used.length, compressRanges(ex.used.map(([x]) => x))]);
      if (!ex.read.complete) failed.push(`page ${n}: ${ex.read.reason}`);
    } else {
      const sub = await readAllChildren(bridge, ref, {}, t);
      const inner = numbered(sub.items, poolNo);
      rows.push([n, it.name ?? null, inner.byNo.size, compressRanges(inner.byNo.keys())]);
      if (!sub.complete) failed.push(`preset pool ${n}: ${sub.reason}`);
      else if (inner.unnumbered) failed.push(`preset pool ${n}: ${inner.unnumbered} object(s) without a number`);
    }
  }
  const row: Row = { pool: spec.label, stored: byNo.size, used: compressRanges(used), [pages ? "pages" : "presetPools"]: rows };
  if (read.complete && unnumbered) Object.assign(read, { complete: false, reason: `${unnumbered} object(s) without a number` });
  if (read.complete && failed.length) Object.assign(read, { complete: false, reason: failed.join("; ") });
  else if (failed.length) read.reason = `${read.reason}; ${failed.join("; ")}`;
  return finish(row, used, read, opts, generalFree);
}

// ---------------------------------------------------------------------------
// gma3_pool_usage
// ---------------------------------------------------------------------------

export const MAX_POOLS = 30;

/** The bridge that reports a failed field read (fieldErrors) instead of an absent field. */
export const FIELD_ERRORS_BRIDGE = "0.47.0";

/** Is version a at least b ("0.47.0" >= "0.46.2"); false for a version that does not parse. */
export function versionAtLeast(a: unknown, b: string): boolean {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const x = typeof a === "string" ? parse(a.trim()) : null;
  const y = parse(b)!;
  if (!x) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * Executor free blocks need bridge 0.47.0: an older one drops a failed Object read, so an occupied executor would read
 * as empty. Returns the reason when they are not offered, undefined when they are.
 */
async function executorFreeGate(bridge: Gma3Bridge, t: number): Promise<string | undefined> {
  let version: unknown;
  try {
    version = ((await bridge.request("ping", {}, t)) as { bridgeVersion?: unknown } | null)?.bridgeVersion;
  } catch (err) {
    return `not offered: the bridge version could not be read (${err instanceof Error ? err.message : String(err)}); executor free blocks need bridge ${FIELD_ERRORS_BRIDGE}`;
  }
  if (versionAtLeast(version, FIELD_ERRORS_BRIDGE)) return undefined;
  return `not offered: bridge ${typeof version === "string" ? version : "(unknown version)"} reads a failed Object read like an empty executor; executor free blocks need bridge ${FIELD_ERRORS_BRIDGE}`;
}

export interface PoolUsageArgs {
  pools?: string[];
  preset_pools?: number[];
  names?: boolean;
  free?: { size: number; from?: number };
  data_pool?: number;
}

export async function poolUsage(ctx: ToolContext, args: PoolUsageArgs): Promise<{ result: Record<string, unknown>; anyRead: boolean }> {
  const specs: Spec[] = [];
  for (const p of args.pools ?? []) specs.push(parsePool(p));
  for (const n of args.preset_pools ?? []) specs.push(parsePool(`Preset ${n}`));
  if (specs.length === 0) throw new Error("give at least one pool in pools or preset_pools");
  const seen = new Set<string>();
  const unique = specs.filter((s) => (seen.has(s.label.toLowerCase()) ? false : (seen.add(s.label.toLowerCase()), true)));
  if (unique.length > MAX_POOLS) throw new Error(`at most ${MAX_POOLS} pools per call (got ${unique.length})`);
  const bridge = scopedBridge(ctx.bridge, args.data_pool);
  const t = ctx.requestTimeoutMs;
  const opts: Options = { names: args.names === true, free: args.free };
  if (args.free && unique.some((s) => s.kind === "page")) opts.executorFreeBlocked = await executorFreeGate(ctx.bridge, t);
  const rows: Row[] = [];
  for (const s of unique) {
    if (s.kind === "pool" || s.kind === "preset") rows.push(await readPool(bridge, s, opts, t));
    else if (s.kind === "page") rows.push(await readPage(bridge, s, opts, t));
    else rows.push(await readContainer(bridge, s, opts, t));
  }
  const complete = rows.every((r) => r.complete === true);
  const result: Record<string, unknown> = { ...(args.data_pool !== undefined ? { dataPool: args.data_pool } : {}), complete, pools: rows };
  return { result, anyRead: rows.some((r) => ANSWERED.has(r)) };
}

/** Compact JSON with one line per pool, so a large pool's names stay short and each pool is easy to find. */
export function renderUsage(result: Record<string, unknown>): string {
  const { pools, ...head } = result as { pools: unknown[] };
  const headText = JSON.stringify(head);
  return `${headText.slice(0, -1)}${headText.length > 2 ? "," : ""}"pools":[\n${pools.map((p) => JSON.stringify(p)).join(",\n")}\n]}`;
}

const DESCRIPTION =
  "Read-only: which numbers a show already uses, per pool, before you store into it. For each pool: stored (the number of stored objects), used (their numbers as ranges, \"1-11, 5001-5534\"), " +
  "with names: true [no, name] pairs, and with free: {size, from?} the first free block of that size (\"21-40\"; null when there is none up to 9999 or the read is incomplete). " +
  'Pools: DataPool pools by name ("Groups", "Sequences", "Macros", "MAtricks", "Timecodes", "Layouts", ...); a preset pool as "Preset 4" or in preset_pools (stored presets, not the pool\'s 1000 slots); "PresetPools" (every preset pool as [no, name, stored, used]); ' +
  '"Page 2" (its executors with an assigned object as [no, class, name]; covered: the numbers a wider executor (Width > 1) spans, never free; an assignment that cannot be read (an invalid handle, or a read that raised: bridge 0.47.0) is listed as unreadable and makes the page incomplete; executor free blocks need bridge 0.47.0; free searches one row: 101-198, 201-298, 301-390, 401-490, from 101 by default); "Pages" (every page as [no, name, executors used, used]). ' +
  "Every pool is read to its end page by page; complete: false with reason (keeping what was read) when a read fails, the pool changes during the read or an object has no number; the call is an error only when no pool could be read at all. Ranges such as \"Page 1.101 Thru 1.115\" are not accepted (executor ranges can hang onPC). " +
  "Use this instead of gma3_objects \"Macro Thru\" or a Lua walk of the pools.";

export const registerPoolUsageTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_pool_usage",
    {
      title: "Used and free pool numbers",
      description: DESCRIPTION,
      inputSchema: {
        ...dataPoolShape,
        pools: z
          .array(z.string())
          .optional()
          .describe('Pools to read: "Groups", "Sequences", "Macros", "MAtricks", "Timecodes", "Layouts" (any DataPool pool name), "Preset 4", "PresetPools", "Page 2", "Pages".'),
        preset_pools: z.array(z.number().int().min(1).max(MAX_POOL_NUMBER)).optional().describe("Preset pool numbers, e.g. [1, 4, 21] (the same as \"Preset 1\", ... in pools)."),
        names: z.boolean().optional().describe("Also list [no, name] per stored object (default false)."),
        free: z
          .object({
            size: z.number().int().min(1).max(MAX_POOL_NUMBER).describe("How many consecutive free numbers."),
            from: z.number().int().min(1).max(MAX_POOL_NUMBER).optional().describe("Search from this number (default 1; 101 for a page's executors)."),
          })
          .optional()
          .describe("Find the first free block of size numbers in each pool."),
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        const { result, anyRead } = await poolUsage(ctx, args as PoolUsageArgs);
        return { content: [{ type: "text", text: renderUsage(result) }], ...(anyRead ? {} : { isError: true }) };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );
};
