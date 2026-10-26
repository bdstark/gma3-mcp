/**
 * Pool names before a named store (#102), shared by the store tools.
 *
 * The console keeps names unique within a preset pool and stores a taken name as "<name>#2" (live 2026-10-25,
 * Preset 4.101 "Orange" became "Orange#2" next to 4.5 "Orange"); tags and Quickeys do the same (SU-21, KB-28). For
 * groups, macros, sequences and MAtricks no probe shows what the console does with a duplicate, so the tools refuse one
 * there too: two objects of one pool under one name make every lookup by name ambiguous.
 *
 * A store tool lists the target pool once per pool and call with the existing `children` op (fields No and Name),
 * refuses a name another object of the pool has before anything is sent, and after each store records the name the
 * object was left with, so a later item of the same call sees it taken. A name nobody confirmed drops the pool from
 * the call's cache, so the next item reads the pool again (review of #108).
 */
import type { Gma3Bridge } from "../bridge.js";
import type { StepStatus } from "../results.js";

/** What a store does when another object of the pool already has the requested name. */
export const ON_NAME_TAKEN = ["refuse", "allow_suffix"] as const;
export type OnNameTaken = (typeof ON_NAME_TAKEN)[number];

export interface PoolName {
  name: string;
  /** Stored by an earlier item of the same call. */
  thisCall?: boolean;
}

/**
 * The names of each target pool (pool key -> object number -> name), read once per pool and call and shared by the
 * items of one call; every store of the call records the name it left, so a later item asking for the same name sees
 * it taken.
 */
export type PoolNameCache<K> = Map<K, Map<number, PoolName>>;

/** Trimmed and case-insensitive: whether the console's uniqueness is case-sensitive is not established. */
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The name exactly, or the console's rename of a taken one ("Orange#2"). */
export const nameOrSuffixed = (got: string, name: string) => {
  const g = got.trim();
  return g === name || (g.startsWith(`${name}#`) && /^\d+$/.test(g.slice(name.length + 1)));
};

/** How a pool's objects are named in the listing's errors ("a preset of pool 4", "preset pool 4", "presets"). */
export interface PoolWords {
  one: string;
  all: string;
  plural: string;
}

/** The names of a pool, from the cache or listed with the bridge's children op (No and Name per object). */
export async function readPoolNames<K>(bridge: Gma3Bridge, key: K, ref: string, words: PoolWords, t: number, cache: PoolNameCache<K>): Promise<Map<number, PoolName>> {
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Map<number, PoolName>();
  const PAGE = 10000;
  for (let offset = 0; ; ) {
    const r = (await bridge.request("children", { ref, fields: ["No", "Name"], limit: PAGE, offset }, t)) as { total?: unknown; enumerationError?: unknown; items?: Array<{ name?: string; addr?: string; invalid?: boolean; fields?: Record<string, unknown>; fieldErrors?: Record<string, unknown> }> };
    // Bridge 0.47.0 (#96): a Children() that raised gives an empty listing with enumerationError, and a field read that
    // raised is named in fieldErrors; either leaves the names unknown, never an empty pool (review of #115).
    if (r?.enumerationError !== undefined && r.enumerationError !== null) throw new Error(`${words.all} could not be listed: ${String(r.enumerationError)}`);
    const items = r?.items ?? [];
    for (const it of items) {
      if (it.invalid) continue;
      const bad = ["No", "Name"].find((f) => it.fieldErrors?.[f] !== undefined && it.fieldErrors?.[f] !== null);
      if (bad) throw new Error(`${words.one} (${it.addr ?? it.name ?? "?"}) has no readable ${bad === "No" ? "number" : "name"}: ${String(it.fieldErrors![bad])}`);
      const no = Number.parseInt(String(it.fields?.No ?? ""), 10);
      if (!Number.isInteger(no)) throw new Error(`${words.one} (${it.addr ?? it.name ?? "?"}) has no readable number`);
      const name = String(it.fields?.Name ?? it.name ?? "").trim();
      if (name) out.set(no, { name });
    }
    offset += items.length;
    if (typeof r?.total !== "number" || offset >= r.total) break;
    if (!items.length) throw new Error(`${words.all} lists ${r.total} ${words.plural} but only ${offset} could be read`);
  }
  cache.set(key, out);
  return out;
}

/** Another object of the pool (not `number`) with the name, or undefined. */
export function nameHolder(names: Map<number, PoolName>, number: number, name: string): ({ no: number } & PoolName) | undefined {
  for (const [no, e] of names) if (no !== number && sameName(e.name, name)) return { no, ...e };
  return undefined;
}

/** What a store left behind, for the call's name cache. */
export interface LeftName {
  /** Status of the step that stored (or created) the object; "succeeded" for an existing object no step replaced. */
  store: StepStatus | undefined;
  /** The name asked for. */
  requested?: string;
  /** The name write: its status and the name it read back. */
  write?: { status: StepStatus; read?: unknown };
  /** The name a read-back after the store found. */
  readBack?: unknown;
  /** The object existed before: a store without a name keeps its own. */
  existed: boolean;
}

/**
 * Record the name the object was left with (review of #108): the read-back name; else the requested name after a
 * confirmed name write, or the console's read-back of a write that did not take it; else an existing object stored
 * without a name keeps its own. Any other store (an unnamed create gets a default name such as "Preset 102", a failed
 * or unknown store or name write) may have changed a name nobody read, so the pool is dropped from the cache and read
 * again by the next item. So is a name left empty (a macro's name cleared with ""): the console gives it a default
 * nobody read, and the old name must not stay cached as taken (review of #115).
 */
export function recordLeftName<K>(cache: PoolNameCache<K>, key: K, number: number, s: LeftName): void {
  const record = (left: unknown) => {
    const cached = cache.get(key);
    const n = typeof left === "string" && left.trim() ? left.trim() : undefined;
    if (!n) cache.delete(key);
    else if (cached) cached.set(number, { name: n, thisCall: true });
  };
  const stored = s.store === "succeeded";
  if (typeof s.readBack === "string" && s.readBack.trim()) record(s.readBack);
  else if (stored && s.requested !== undefined && s.write?.status === "succeeded") record(s.write.read ?? s.requested);
  else if (stored && s.requested !== undefined && typeof s.write?.read === "string") record(s.write.read);
  else if (!(stored && s.requested === undefined && s.existed)) cache.delete(key);
}

/** The pool a store tool checks names in: where to list it and how to name its objects. */
export interface NamePool {
  /** The listing reference ("DataPool.Groups"). */
  ref: string;
  /** "group" / "groups" in messages. */
  noun: string;
  plural: string;
  /** The object label for a number ("Group 5"). */
  label: (no: number) => string;
}

/**
 * The read-only check_name step of a named store into `pool` (object `number`, `target` its label): refuses, before
 * anything is sent, a name another object of the pool has, naming the holder, unless allow_suffix (then a warning).
 * An unreadable listing refuses (with allow_suffix: a warning). `keepOwn`: when the listing shows the object already
 * under exactly this name, nothing is renamed and nothing is refused.
 */
export async function checkPoolName(o: {
  bridge: Gma3Bridge;
  t: number;
  pool: NamePool;
  cache: PoolNameCache<string>;
  number: number;
  name: string;
  onNameTaken: OnNameTaken;
  warnings: string[];
  keepOwn?: boolean;
}): Promise<{ status: "succeeded" | "failed"; detail: Record<string, unknown>; error?: string }> {
  const { pool, name } = o;
  const target = pool.label(o.number);
  const allowSuffix = o.onNameTaken === "allow_suffix";
  let names: Map<number, PoolName>;
  try {
    names = await readPoolNames(o.bridge, pool.ref, pool.ref, { one: `a ${pool.noun} of ${pool.ref}`, all: pool.ref, plural: pool.plural }, o.t, o.cache);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (allowSuffix) {
      o.warnings.push(`the names of the ${pool.noun} pool could not be read (${msg}); with on_name_taken "allow_suffix" the store goes ahead`);
      return { status: "succeeded", detail: { namesRead: false } };
    }
    return { status: "failed", detail: { namesRead: false }, error: `the names of the ${pool.noun} pool could not be read (${msg}), so a name another ${pool.noun} has cannot be ruled out; nothing was sent` };
  }
  if (o.keepOwn && names.get(o.number)?.name === name) return { status: "succeeded", detail: { unchanged: true } };
  const holder = nameHolder(names, o.number, name);
  if (!holder) return { status: "succeeded", detail: { taken: false } };
  const held = `${JSON.stringify(holder.name)} is ${pool.label(holder.no)}${holder.thisCall ? " (stored earlier in this call)" : ""}${holder.name !== name ? " (names are compared case-insensitively)" : ""}`;
  const detail = { taken: true, holder: holder.no, holderName: holder.name };
  // Not probed for these pools (unlike presets, tags and Quickeys), so the console's rule is not claimed.
  const rule = `two ${pool.plural} under one name make every lookup by name ambiguous (whether the console would store ${target} as ${JSON.stringify(`${name}#2`)} is not verified for ${pool.plural})`;
  if (allowSuffix) {
    o.warnings.push(`${held}: ${rule}; ${target} is stored anyway (on_name_taken "allow_suffix")`);
    return { status: "succeeded", detail: { ...detail, suffixExpected: true } };
  }
  return { status: "failed", detail, error: `the name ${JSON.stringify(name)} is taken: ${held}. ${rule.charAt(0).toUpperCase()}${rule.slice(1)}; choose another name, or pass on_name_taken: "allow_suffix"; nothing was sent` };
}
