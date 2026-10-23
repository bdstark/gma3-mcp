/**
 * gma3_set_property's check: the value read back after Set() is compared with the one requested, for plain values.
 *
 * The console keeps the previous value without an error when it does not take a Set() (live 2026-10-22: HazeEnabled
 * on the Show Start's locked RenderQuality "Gobo Animated" read back "No", and only the command line said "Object
 * locked"). So the property and the object's Lock and SystemLocked are read before the write.
 *
 * verification:
 * - "verified": a plain value reads back as requested. A boolean or enum compares case aside (Yes/No spellings only
 *   on a property that reads Yes or No), a number by its raw value when the console gives one, text exactly, spaces
 *   included.
 * - "failed": the read-back is still the old value (an error that names the lock, or says the lock state is unknown),
 *   another plain value, or missing.
 * - "unverified": values the console reformats are not judged here: object references (Appearance, ...), a macro
 *   line's Command and Wait, Tags, durations and other display-converted values. The read-back is returned with the
 *   typed tool that checks it.
 */
import type { Gma3Bridge } from "../bridge.js";
import { readFields } from "./common.js";

const LOCK_FIELDS = ["Lock", "SystemLocked"];

/**
 * Properties holding free text, compared exactly: a name "Off" is not the value No, and a case-only rename is a change.
 * The object's property list cannot say which are text (PropertyType is nil on a handle,
 * docs/probes/kb-10-cmdtext-write-macos-2.5.1.md), so they are listed.
 */
const TEXTUAL = /^(name|note|label|text|description|comment|title|cmdtext|path|filename|filepath|prefix|destinationip)$/i;

/** Properties the console reformats, with the typed tool that checks them. */
const REFORMATTED: Array<[RegExp, string]> = [
  [/^(command|wait)$/i, "gma3_macros reads a macro line's Command and Wait, and gma3_edit_macro_line writes and checks them in the console's form"],
  [/^tags$/i, "gma3_tags reads an object's tags, and gma3_assign_tag assigns and checks them"],
];
const REFERENCE_HINT = "gma3_get_object on the object and the referenced one compares them";

const text = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") {
    const name = (v as { name?: unknown }).name;
    return typeof name === "string" ? name : JSON.stringify(v);
  }
  return String(v);
};

const isLocked = (v: unknown): boolean => typeof v === "string" ? v.trim() !== "" && !/^(no|off|false|0)$/i.test(v.trim()) : v === true;
const isHandle = (v: unknown) => typeof v === "object" && v !== null && typeof (v as { addr?: unknown }).addr === "string";

/**
 * A plain read-back against the request: "match", "differs", or "reformatted" (a number shown in another form: a
 * duration, a unit conversion). raw is the asText false value, which decides a number when it is one (SpeedFromX 60
 * reads "1.000000" in the edit role, docs/probes/sb-02-groups-macos-2.5.1.md).
 */
export function comparePlain(got: unknown, want: string | number | boolean, property = "", raw?: unknown): "match" | "differs" | "reformatted" {
  const a = text(got);
  if (a === undefined) return "differs";
  // Text as the bridge sets it (Lua tostring: 2.5 is "2.5", false is "false"), whatever the request's type.
  if (TEXTUAL.test(property)) return a === String(want) ? "match" : "differs";
  const w = String(want).trim();
  if (typeof want === "number" || /^-?\d+(\.\d+)?$/.test(w)) {
    const n = Number(w);
    if (typeof raw === "number") return Math.abs(raw - n) < 1e-6 ? "match" : "differs";
    // "2.500" for 2.5, "60.00 BPM" for 60.
    const m = a.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-z%°]*)$/i);
    if (!m) return "reformatted";
    return Math.abs(Number(m[1]) - n) < 1e-6 ? "match" : "reformatted";
  }
  const x = a.trim().toLowerCase().replace(/\s+/g, " ");
  const y = w.toLowerCase().replace(/\s+/g, " ");
  if (x === y) return "match";
  // Yes/No spellings only for a property that reads Yes or No: an On/Off/Auto enum ignores "Yes" (the DMX Request,
  // docs/probes/su-09-dmx-output-macos-2.5.1.md).
  if ((x === "yes" && /^(yes|on|true|enabled)$/.test(y)) || (x === "no" && /^(no|off|false|disabled)$/.test(y))) return "match";
  return "differs";
}

export interface SetPropertyArgs {
  ref: string;
  property: string;
  value: string | number | boolean;
}

/** Set, read back, compare. failed: the read-back is not the requested value (kept, another value, or unknown). */
export async function setPropertyChecked(bridge: Gma3Bridge, args: SetPropertyArgs): Promise<{ result: Record<string, unknown>; failed: boolean }> {
  const { ref, property, value } = args;
  // Setting a lock itself: that field is not what blocks the write, and Lock reads "" when unlocked.
  const lockField = LOCK_FIELDS.find((f) => f.toLowerCase() === property.toLowerCase());
  const before = await readFields(bridge, ref, lockField ? LOCK_FIELDS : [property, ...LOCK_FIELDS]).catch(() => null);
  const res = (await bridge.request("set", { ref, property, value })) as Record<string, unknown>;
  // A lock reads "" when unlocked and "UL" when locked (onPC 2.5.1, docs/probes/sb-01-playback-macos-2.5.1.md).
  const lockState = (v: unknown) => (v === undefined || v === null ? undefined : isLocked(v) ? "Yes" : "No");
  const old = lockField ? (before ? lockState(before[lockField]) : undefined) : before?.[property];
  const got = lockField ? lockState(res.value) : res.value;
  // A text property compares with the text as stored: value is trimmed, exact (0.44.0) is not.
  const asStored = TEXTUAL.test(property) && typeof res.exact === "string" ? res.exact : got;
  const unchanged = old !== undefined && old !== null && got !== undefined && got !== null && text(got) === text(old);

  const locks = LOCK_FIELDS.filter((f) => f !== lockField && isLocked(before?.[f]));
  const lockRead = before !== null && LOCK_FIELDS.some((f) => f !== lockField && before[f] !== undefined && before[f] !== null);
  const lock = {
    state: locks.length ? "locked" : lockRead ? "unlocked" : "unknown",
    ...Object.fromEntries(LOCK_FIELDS.filter((f) => f !== lockField && before?.[f] !== undefined).map((f) => [f, before?.[f]])),
  };
  const lockText = locks.map((f) => `${f} = ${JSON.stringify(before?.[f])}`).join(", ");
  const base = { ...res, requested: value, before: old ?? null, lock };
  const unverified = (why: string, hint?: string) => ({
    result: { ...base, verification: "unverified", verified: false, unchanged, note: why, ...(hint ? { hint } : {}) },
    failed: false,
  });

  if (got === undefined || got === null) {
    // No value with readOk: the property is empty (a cleared reference reads nil). Without readOk the read failed.
    if (res.readOk === true) return unverified(`${property} of ${ref} reads nothing after the write (an empty property, such as a cleared reference); this tool does not judge it`, REFERENCE_HINT);
    return { result: { ...base, verification: "failed", verified: false, error: `${property} of ${ref} could not be read back after the write${typeof res.readError === "string" ? ` (${res.readError})` : ""}; whether the console applied ${JSON.stringify(value)} is unknown` }, failed: true };
  }
  const reformatted = REFORMATTED.find(([re]) => re.test(property));
  if (reformatted) return unverified(`the console stores ${property} in its own form, which this tool does not judge: it reads ${JSON.stringify(got)}`, reformatted[1]);

  let outcome: "match" | "differs" | "reformatted";
  if (lockField) outcome = got === lockState(value === true ? "Yes" : value === false ? "No" : value) ? "match" : "differs";
  else {
    let raw: unknown;
    if (!TEXTUAL.test(property)) {
      // The raw value tells a reference (a handle) from a plain value. The bridge leaves out a field whose read
      // raised, so no raw value is unknown, never a plain match (a kept appearance can be named "Yes").
      try {
        raw = isHandle(got) ? got : (await readFields(bridge, ref, [property], { asText: false }))?.[property];
      } catch {
        raw = undefined;
      }
      if (raw === undefined || raw === null) return unverified(`the raw value of ${property} could not be read, so whether it is a plain value or a reference is unknown: it reads ${JSON.stringify(got)}`);
      if (isHandle(raw)) return unverified(`${property} holds an object reference, which this tool does not judge: it reads ${JSON.stringify(text(got))}`, REFERENCE_HINT);
    }
    outcome = comparePlain(asStored, value, property, raw);
  }

  if (outcome === "match") {
    // Already the requested value: the end state is right, but on a locked object the write itself was refused.
    const note = unchanged && locks.length ? { note: `${property} already read ${JSON.stringify(old)}; ${ref} is locked (${lockText}), so the console did not take the write itself` } : {};
    return { result: { ...base, verification: "verified", verified: true, ...note }, failed: false };
  }
  if (!unchanged && outcome === "reformatted") return unverified(`${property} reads ${JSON.stringify(got)}, a form of the value this tool does not judge (a duration, a unit, a display conversion)`);
  const unlock = locks.includes("Lock") ? `Unlock it first (Unlock ${ref}), set the property, and lock it again` : "SystemLocked is the console's own read-only lock, which Unlock does not remove";
  const error = unchanged
    ? locks.length
      ? `${ref} is locked (${lockText}): the console kept ${property} = ${JSON.stringify(got)} and did not apply ${JSON.stringify(value)}. ${unlock}`
      : lock.state === "unknown"
        ? `the console did not apply ${property} = ${JSON.stringify(value)} on ${ref}: it still reads ${JSON.stringify(got)}, and whether ${ref} is locked is unknown (its Lock could not be read)`
        : `the console did not apply ${property} = ${JSON.stringify(value)} on ${ref}: it still reads ${JSON.stringify(got)} (the console silently keeps the previous value when it does not accept one)`
    : old !== undefined && old !== null
      ? `${property} of ${ref} reads ${JSON.stringify(got)} after the write (it was ${JSON.stringify(old)}), not ${JSON.stringify(value)}: the console put its own value in place of one it does not accept`
      : `${property} of ${ref} reads ${JSON.stringify(got)} after the write, not ${JSON.stringify(value)}; the value before could not be read, so whether the console applied it is unknown`;
  return { result: { ...base, verification: "failed", verified: false, error }, failed: true };
}
