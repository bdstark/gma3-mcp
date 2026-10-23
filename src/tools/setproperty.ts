/**
 * gma3_set_property's check: the value read back after Set() is compared with the one requested.
 *
 * The console keeps the previous value without an error when it does not take a Set() (live 2026-10-22: HazeEnabled
 * on the Show Start's locked RenderQuality "Gobo Animated" read back "No", and only the command line said "Object
 * locked"). So the property and the object's Lock are read before the write; a read-back that is still the old value
 * (or, with no old value, differs from the request) is reported as not applied, naming the lock when there is one.
 * A read-back equal to the request only in the console's own spelling (see sameValue) is applied; any other read-back is
 * not, even when it changed: the console coerces a value it does not accept (an invalid macro-line Wait reads Follow).
 */
import type { Gma3Bridge } from "../bridge.js";
import { readFields, readObjects } from "./common.js";

const LOCK_FIELDS = ["Lock", "SystemLocked"];

const text = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") {
    const name = (v as { name?: unknown }).name;
    return typeof name === "string" ? name : JSON.stringify(v);
  }
  return String(v);
};

/**
 * Properties holding free text: a name "Off" is not the value No, and a case-only rename is a change. Whole property
 * names only: ForwardCommands and AddToCmdline are Yes/No, and Appearance is an object reference.
 */
const TEXTUAL = /^(name|note|label|text|description|comment|title|command|path|filename|filepath)$/i;

/**
 * Compare a read-back with a requested value. Free-text properties (Name, Note, ...) compare exactly with the text the
 * bridge sets (Lua tostring: 2.5 is "2.5", false is "false"), whatever the request's type. Otherwise case,
 * spacing, number format and Yes/No spellings aside: a property set from a boolean or a number, or one whose name is
 * not a text field (HazeEnabled "Yes" for true, FadeTime "2.500" for 2.5, Trigger "Follow" for "follow").
 */
export function sameValue(got: unknown, want: unknown, property = ""): boolean {
  const exactA = text(got);
  if (TEXTUAL.test(property)) return exactA !== undefined && exactA === String(want);
  const exactB = typeof want === "boolean" || typeof want === "number" ? undefined : text(want);
  if (exactA !== undefined && exactA === exactB) return true;
  const a = exactA?.trim().toLowerCase().replace(/\s+/g, " ");
  const b = text(want)?.trim().toLowerCase().replace(/\s+/g, " ");
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const yes = /^(yes|on|true|enabled)$/;
  const no = /^(no|off|false|disabled)$/;
  if ((yes.test(a) && yes.test(b)) || (no.test(a) && no.test(b))) return true;
  // "2.5" against "2.500", "2.5s" or "50%": the number, the unit only when both have one.
  const num = /^(-?\d+(?:\.\d+)?)\s*([a-z%°]*)$/;
  const x = a.match(num);
  const y = b.match(num);
  return Boolean(x && y && Math.abs(Number(x[1]) - Number(y[1])) < 1e-6 && (!x[2] || !y[2] || x[2] === y[2]));
}

/**
 * A reference property (Appearance, Object, ...) reads back as the referenced object's name or a handle summary, not
 * the reference that was sent ("Appearance 3"): the request is resolved to its object and compared by address or name.
 */
async function sameObject(bridge: Gma3Bridge, ref: string, got: unknown, want: unknown, property: string): Promise<boolean | undefined> {
  // undefined: the request is not a reference to exactly one object, so the text comparison decides.
  if (typeof want !== "string" || TEXTUAL.test(property) || got === null || got === undefined || !/^[A-Za-z][A-Za-z ]*\s+\d+(\.\d+)*$/.test(want.trim())) return undefined;
  // The property's current object, as a handle summary (the read-back text is only a name).
  const handle = async (): Promise<unknown> => {
    if (typeof got === "object" && (got as { addr?: unknown }).addr !== undefined) return got;
    const fields = await readFields(bridge, ref, [property], { asText: false }).catch(() => null);
    return fields?.[property];
  };
  const isHandle = (v: unknown) => typeof v === "object" && v !== null && typeof (v as { addr?: unknown }).addr === "string";
  const res = await readObjects(bridge, want.trim(), [], 2, { asText: false }).catch(() => null);
  const items = res?.items ?? [];
  if (items.length !== 1) {
    // A request that names no single object, on a property that holds an object, is not applied, even when the
    // current object happens to be named like it.
    return isHandle(await handle()) ? false : undefined;
  }
  const target = items[0] as { addr?: string };
  if (typeof target.addr !== "string") return false;
  // By address, never by name: two objects can share a name (Appearance 3 and 4 both "Red"), so a refused write
  // would read back as the requested one.
  const current = await handle();
  return isHandle(current) && (current as { addr: string }).addr === target.addr;
}

const isLocked = (v: unknown): boolean => typeof v === "string" ? v.trim() !== "" && !/^(no|off|false|0)$/i.test(v.trim()) : v === true;

export interface SetPropertyArgs {
  ref: string;
  property: string;
  value: string | number | boolean;
}

/** Set, read back, compare. failed: the read-back is not the requested value (kept, coerced, or unknown). */
export async function setPropertyChecked(bridge: Gma3Bridge, args: SetPropertyArgs): Promise<{ result: Record<string, unknown>; failed: boolean }> {
  const { ref, property, value } = args;
  // Setting a lock itself: that field is not what blocks the write, and Lock reads "" when unlocked.
  const lockField = LOCK_FIELDS.find((f) => f.toLowerCase() === property.toLowerCase());
  const fields = lockField ? LOCK_FIELDS : [property, ...LOCK_FIELDS];
  const before = await readFields(bridge, ref, fields).catch(() => null);
  const res = (await bridge.request("set", { ref, property, value })) as Record<string, unknown>;
  // A lock reads "" when unlocked and "UL" when locked (onPC 2.5.1, docs/probes/sb-01-playback-macos-2.5.1.md), so
  // a lock field's read-back counts as No or Yes.
  const lockState = (v: unknown) => (isLocked(v) ? "Yes" : "No");
  // Clearing a reference ("") can read back as nothing at all: the bridge sends no value for a nil property.
  const got = lockField ? lockState(res.value) : value === "" && (res.value === undefined || res.value === null) ? "" : res.value;
  const old = lockField ? (before ? lockState(before[lockField]) : undefined) : before?.[property];
  // Unchanged means the very same text: any other read-back is a change the console made.
  const unchanged = old !== undefined && old !== null && text(got) === text(old);
  const locks = LOCK_FIELDS.filter((f) => f !== lockField && isLocked(before?.[f]));
  // A reference request is decided by the object it resolves to, before any text: a kept object can be named like the
  // requested reference (Appearance 3 named "Appearance 5").
  const byObject = await sameObject(bridge, ref, got, value, property);
  if (byObject ?? sameValue(got, value, property)) {
    // Already the requested value: the end state is right, but on a locked object the write itself was refused.
    const note = unchanged && locks.length ? { note: `${property} already read ${JSON.stringify(old)}; ${ref} is locked (${locks.map((f) => `${f} = ${JSON.stringify(before?.[f])}`).join(", ")}), so the console did not take the write itself`, locked: Object.fromEntries(locks.map((f) => [f, before?.[f]])) } : {};
    return { result: { ...res, requested: value, verified: true, ...note }, failed: false };
  }
  const lockText = locks.map((f) => `${f} = ${JSON.stringify(before?.[f])}`).join(", ");
  const error = locks.length
    ? `${ref} is locked (${lockText}): the console kept ${property} = ${JSON.stringify(got)} and did not apply ${JSON.stringify(value)}. Unlock it first (Unlock ${ref}), set the property, and lock it again`
    : unchanged
      ? `the console did not apply ${property} = ${JSON.stringify(value)} on ${ref}: it still reads ${JSON.stringify(got)} (the console silently keeps the previous value when it does not accept one)`
      : old !== undefined && old !== null
        ? `${property} of ${ref} reads ${JSON.stringify(got)} after the write (it was ${JSON.stringify(old)}), not ${JSON.stringify(value)}: the console put its own value in place of one it does not accept`
      : `${property} of ${ref} reads ${JSON.stringify(got)} after the write, not ${JSON.stringify(value)}; the value before could not be read, so whether the console applied it is unknown`;
  return { result: { ...res, requested: value, before: old ?? null, verified: false, ...(locks.length ? { locked: Object.fromEntries(locks.map((f) => [f, before?.[f]])) } : {}), error }, failed: true };
}
