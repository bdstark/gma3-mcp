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
import { COMMAND_KEYWORDS } from "./commandkeywords.js";
import { readFields, readObjects } from "./common.js";
import { displaySeconds, tokenize } from "./macros.js";

const LOCK_FIELDS = ["Lock", "StructureLocked", "SystemLocked"];
/** The console's own locks: read-only, so Unlock does not remove them (docs/probes/sb-01-playback-macos-2.5.1.md). */
const READ_ONLY_LOCKS = ["StructureLocked", "SystemLocked"];

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
 * names only: ForwardCommands and AddToCmdline are Yes/No, and Appearance is an object reference. The object's property
 * list cannot say which are text (PropertyType is nil on a handle, docs/probes/kb-10-cmdtext-write-macos-2.5.1.md), so
 * the text properties the other tools write are listed (an OSC Prefix, src/tools/osc.ts), and the command line's CmdText,
 * which silently refuses writes (docs/probes/kb-10-cmdtext-write-macos-2.5.1.md).
 */
const TEXTUAL = /^(name|note|label|text|description|comment|title|command|cmdtext|path|filename|filepath|prefix|destinationip)$/i;

/**
 * Compare a read-back with a requested value. Free-text properties (Name, Note, ...) compare exactly with the text the
 * bridge sets (Lua tostring: 2.5 is "2.5", false is "false"), whatever the request's type. Otherwise case,
 * spacing, number format and Yes/No spellings aside: a property set from a boolean or a number, or one whose name is
 * not a text field (HazeEnabled "Yes" for true, FadeTime "2.500" for 2.5, Trigger "Follow" for "follow"). Yes/No
 * spellings count only for a property that reads Yes or No: an On/Off/Auto enum ignores "Yes" (the DMX Request,
 * docs/probes/su-09-dmx-output-macos-2.5.1.md).
 */
export function sameValue(got: unknown, want: unknown, property = "", opts: { consoleForm?: boolean } = {}): boolean {
  const exactA = text(got);
  if (/^command$/i.test(property)) return exactA !== undefined && (exactA === String(want) || (opts.consoleForm !== false && consoleForm(exactA, String(want))));
  // A macro line's Wait 0 is Follow (SB-07); any other text still has to match.
  if (/^wait$/i.test(property) && /^follow$/i.test(exactA ?? "") && (want === 0 || String(want).trim() === "0")) return true;
  if (TEXTUAL.test(property)) return exactA !== undefined && exactA === String(want);
  // A macro line's Wait written "0:05" reads 0.05: the colon is not minutes:seconds (SB-07).
  if (/^wait$/i.test(property) && typeof want === "string" && /^\d+:\d+$/.test(want.trim())) want = want.trim().replace(":", ".");
  const exactB = typeof want === "boolean" || typeof want === "number" ? undefined : text(want);
  if (exactA !== undefined && exactA === exactB) return true;
  const a = exactA?.trim().toLowerCase().replace(/\s+/g, " ");
  const b = text(want)?.trim().toLowerCase().replace(/\s+/g, " ");
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const yes = /^(yes|on|true|enabled)$/;
  const no = /^(no|off|false|disabled)$/;
  if ((a === "yes" && yes.test(b)) || (a === "no" && no.test(b))) return true;
  // "2.5" against "2.500", "2.5s" or "50%": the number, the unit only when both have one.
  const num = /^(-?\d+(?:\.\d+)?)\s*([a-z%°]*)$/;
  const x = a.match(num);
  const y = b.match(num);
  if (x && y && Math.abs(Number(x[1]) - Number(y[1])) < 1e-6 && (!x[2] || !y[2] || x[2] === y[2])) return true;
  // A duration reads back as the console's duration text (a macro line's Wait 3600 reads "1h00m00.00", SB-07).
  if (/^\d+[dhm]/.test(a)) {
    const sa = displaySeconds(a);
    const sb = typeof want === "number" ? want : displaySeconds(b);
    // The text rounds to its last digit (1h00m00.00: hundredths), so a request within half of one reads the same.
    const digits = a.match(/\.(\d+)s?$/)?.[1].length ?? 0;
    if (sa !== null && sb !== null && Math.abs(sa - sb) <= 0.5 * 10 ** -digits + 1e-9) return true;
  }
  return false;
}

/**
 * The console's form of a command line (SB-07: "go+ seq 1" is stored as "Go+ Sequence 1", "store cue 5 /merge /nc" as
 * "Store Cue 5 /Merge /NoConfirmation"): the same statements and tokens, quoted text and numbers exactly. A word may
 * differ only where the console wrote a command keyword (COMMAND_KEYWORDS: "Sequence", not "Xyzzy") or an option
 * ("/NoConfirmation"), capitalised, that the sent word abbreviates (its letters in order, from the first); other words
 * are literal arguments ("Echo xyzzy", "Echo Xyzzy") and compare exactly. A literal that spells a keyword ("Echo
 * Sequence") cannot be told from one here, so setPropertyChecked takes this form only when the console wrote the line.
 */
export function consoleForm(stored: string, sent: string): boolean {
  const a = tokenize(stored);
  const b = tokenize(sent);
  if (a.length !== b.length) return false;
  const abbreviates = (full: string, short: string) => {
    const f = full.toLowerCase();
    const s = short.toLowerCase();
    if (!s || f[0] !== s[0]) return false;
    let i = 0;
    for (const ch of f) if (ch === s[i]) i++;
    return i === s.length;
  };
  return a.every((st, i) => st.length === b[i].length && st.every((tok, j) => {
    const want = b[i][j];
    if (tok === want) return true;
    if (/^["']/.test(tok) || /^["']/.test(want) || /^[\d.]+$/.test(tok) || /^[\d.]+$/.test(want)) return false;
    const keyword = tok.startsWith("/") ? /^\/[A-Z]/.test(tok) && want.startsWith("/") : /^[A-Z]/.test(tok) && COMMAND_KEYWORDS.has(tok.toLowerCase());
    return keyword && abbreviates(tok, want);
  }));
}

/**
 * The property's raw value (asText false) decides before its edit text. A reference property (Appearance, Object, ...)
 * reads back as the referenced object's name or a handle summary, not the reference that was sent ("Appearance 3", 3):
 * the request is resolved to its object and compared by address. A number is compared with a raw number, whose edit
 * text can be in other units or rounded (SpeedFromX 60 reads "1.000000", docs/probes/sb-02-groups-macos-2.5.1.md).
 */
async function sameObject(bridge: Gma3Bridge, ref: string, got: unknown, want: unknown, property: string): Promise<boolean | undefined> {
  // undefined: the raw value does not decide (no object, not the requested number), so the text comparison does.
  if (TEXTUAL.test(property) || got === null || got === undefined) return undefined;
  // A reference is a keyword and a number or a quoted name (Appearance 3, Appearance "Red"), or the number or quoted
  // name alone (3, "Red") in the class of the object the property holds.
  const w = String(want).trim();
  const keyed = typeof want === "string" && /^[A-Za-z][A-Za-z ]*\s+(\d+(\.\d+)*|"[^"]+")$/.test(w);
  const bare = typeof want !== "boolean" && /^(\d+(\.\d+)*|"[^"]+")$/.test(w);
  // First, does the property hold an object, whatever the request? Its current one, as a handle summary (the read-back
  // text is a name). Bridge errors propagate: a failed read must not decide either way (readFields / readObjects give
  // null only for "not found").
  const isHandle = (v: unknown) => typeof v === "object" && v !== null && typeof (v as { addr?: unknown }).addr === "string";
  const current = isHandle(got) ? got : (await readFields(bridge, ref, [property], { asText: false }))?.[property];
  // The bridge leaves out a field whose read raised (childSummary), so no raw value where the text read-back had one is
  // a failed read: unknown, never a fall back to the display name (a kept object can be named "Appearance 7").
  // Empty text and no raw value: an empty property.
  if (current === undefined || current === null) {
    if (text(got) !== "") throw new Error(`the raw read of ${property} returned no value`);
    return undefined;
  }
  if (!isHandle(current)) {
    const n = typeof want === "number" ? want : typeof want === "string" && /^-?\d+(\.\d+)?$/.test(w) ? Number(w) : NaN;
    return typeof current === "number" && Number.isFinite(n) && Math.abs(current - n) < 1e-6 ? true : undefined;
  }
  // A reference property: an empty name does not mean no object (an appearance named "" or blanks), so a clear that
  // still holds one is not applied; nor is a request that does not name one object (true, an unsupported form), never
  // compared with the display name (a kept appearance can be named "Yes").
  if (want === "") return false;
  const cls = (current as { class?: unknown }).class;
  if (!keyed && !(bare && typeof cls === "string" && /^[A-Za-z]+$/.test(cls))) return false;
  const res = await readObjects(bridge, keyed ? w : `${cls} ${w}`, [], 2, { asText: false });
  const items = res?.items ?? [];
  // A request that names no single object is not applied, even when the current object is named like it.
  if (items.length !== 1) return false;
  const target = items[0] as { addr?: string };
  // By address, never by name: two objects can share a name (Appearance 3 and 4 both "Red").
  return typeof target.addr === "string" && (current as { addr: string }).addr === target.addr;
}

async function hasProperty(bridge: Gma3Bridge, ref: string, property: string): Promise<boolean> {
  try {
    const o = (await bridge.request("object", { ref, properties: false, schema: true })) as { schema?: Array<{ name?: unknown }> };
    return (o.schema ?? []).some((p) => typeof p.name === "string" && p.name.toLowerCase() === property.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The objects a child reference belongs to, nearest first (Page 91.201: Page 91; Sequence 1 Cue 2 Part 1: Sequence 1
 * Cue 2, Sequence 1). A locked page silently ignores writes to its executors, whose own Lock still reads ""
 * (docs/probes/sb-01-playback-macos-2.5.1.md).
 */
export function ownerRefs(ref: string): string[] {
  const owners: string[] = [];
  let r = ref.trim();
  while (owners.length < 4) {
    // A keyword and its number or name after an owner first: "Cue 2.5" is a cue number, not a child of Cue 2.
    const next = r.match(/^(.*\S)\s+[A-Za-z]+\s+(\d+(\.\d+)*|"[^"]*")$/)?.[1] ?? r.match(/^([A-Za-z].*\S)\.\d+$/)?.[1];
    if (!next) break;
    owners.push(next);
    r = next;
  }
  return owners;
}

/** The nearest owner whose Lock is set, if any; unread: owners whose Lock could not be read (not taken as unlocked). */
async function lockedOwner(bridge: Gma3Bridge, ref: string): Promise<{ locked?: { ref: string; lock: unknown }; unread: string[] }> {
  const unread: string[] = [];
  for (const o of ownerRefs(ref)) {
    let fields: Record<string, unknown> | null;
    try {
      fields = await readFields(bridge, o, ["Lock"]);
    } catch {
      unread.push(o);
      continue;
    }
    // Not found: no such owner (Cue 2.5 is a cue number, not a child of Cue 2).
    if (fields === null) continue;
    if (fields.Lock === undefined || fields.Lock === null) unread.push(o);
    else if (isLocked(fields.Lock)) return { locked: { ref: o, lock: fields.Lock }, unread };
  }
  return { unread };
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
  // No value at all stays unknown: the set op sends none when the read-back fails.
  const lockState = (v: unknown) => (v === undefined || v === null ? undefined : isLocked(v) ? "Yes" : "No");
  const old = lockField ? (before ? lockState(before[lockField]) : undefined) : before?.[property];
  // An empty property (a cleared reference) reads back as nothing at all: the bridge sends no value for nil. A failed
  // read, or a misspelled property, sends none either, so it counts as empty only when the bridge says the read worked
  // (readOk, 0.44.0) and the property held a value before or is in the object's property list (a misspelled one reads
  // empty too). Whatever the request: a refused write over an empty reference reads empty, not unknown.
  const absent = res.value === undefined || res.value === null;
  const oldEmpty = old === undefined || old === null || text(old) === "";
  const empty = !lockField && absent && res.readOk === true && (!oldEmpty || (await hasProperty(bridge, ref, property)));
  // Empty before and after in reads that worked: unchanged, so a lock still shows.
  const repeatedClear = empty && before !== null && oldEmpty;
  const got = lockField ? lockState(res.value) : empty ? "" : res.value;
  // A text property compares with the text as stored: the read-back value is trimmed, exact (0.44.0) is not.
  const asStored = TEXTUAL.test(property) && typeof res.exact === "string" ? res.exact : got;
  // Unchanged means the very same text: any other read-back is a change the console made.
  const unchanged = repeatedClear || (old !== undefined && old !== null && text(got) === text(old));
  const locks = LOCK_FIELDS.filter((f) => f !== lockField && isLocked(before?.[f]));
  // A reference request is decided by the object it resolves to, before any text: a kept object can be named like the
  // requested reference (Appearance 3 named "Appearance 5").
  let byObject: boolean | undefined;
  try {
    byObject = lockField ? undefined : await sameObject(bridge, ref, got, value, property);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { result: { ...res, requested: value, before: old ?? null, verified: false, error: `the write was sent, but the read to verify ${property} of ${ref} by its object failed (${why}); whether the console applied ${JSON.stringify(value)} is unknown` }, failed: true };
  }
  // An unchanged value with no lock on the object: an owner's Lock (a page's for its executors, a macro's for its lines)
  // may be what refused the write.
  const owners = unchanged && !locks.length && !lockField ? await lockedOwner(bridge, ref) : { unread: [] as string[] };
  const owner = owners.locked;
  const lockText = locks.map((f) => `${f} = ${JSON.stringify(before?.[f])}`).join(", ");
  const lockInfo = { ...(locks.length ? { locked: Object.fromEntries(locks.map((f) => [f, before?.[f]])) } : {}), ...(owner ? { lockedOwner: { ref: owner.ref, Lock: owner.lock } } : {}) };
  // A cleared Name reads the console's default, "<class> <index>" (a macro line's "MacroLine 1", SB-07).
  let defaultName = false;
  if (/^name$/i.test(property) && value === "" && typeof got === "string" && got !== "") {
    const item = (await readObjects(bridge, ref, [], 1).catch(() => null))?.items?.[0] as { class?: unknown; index?: unknown } | undefined;
    defaultName = typeof item?.class === "string" && typeof item.index === "number" && got === `${item.class} ${item.index}`;
  }
  if (defaultName || (byObject ?? sameValue(asStored, value, property, { consoleForm: false }))) {
    // Already the requested value: the end state is right, but on a locked object (or owner) the write itself was
    // refused.
    const by = locks.length ? `${ref} is locked (${lockText})` : owner ? `${owner.ref} is locked (Lock = ${JSON.stringify(owner.lock)}), which blocks writes to ${ref}` : "";
    const note = unchanged && by ? { note: `${property} already read ${JSON.stringify(old ?? "")}; ${by}, so the console did not take the write itself`, ...lockInfo } : {};
    return { result: { ...res, requested: value, verified: true, ...note }, failed: false };
  }
  // The console's form of a command (abbreviated keywords) shows the console wrote the line only when it changed. An
  // unchanged one with no lock found reads the same after a repeated request as after a refused one ("Echo Sequence"
  // kept for "Echo Seq"): not an error, and not verified.
  if (byObject === undefined && sameValue(asStored, value, property)) {
    if (old !== undefined && old !== null && !unchanged) return { result: { ...res, requested: value, verified: true }, failed: false };
    if (unchanged && !locks.length && !owner) {
      const unread = owners.unread.length ? ` The Lock of ${owners.unread.join(", ")} could not be read.` : "";
      return { result: { ...res, requested: value, verified: false, warning: `${property} of ${ref} reads ${JSON.stringify(got)}, the console's form of ${JSON.stringify(value)}, but it did not change, so whether the console took this write cannot be seen (a repeated request reads the same).${unread}` }, failed: false };
    }
  }
  const unlock = locks.some((f) => !READ_ONLY_LOCKS.includes(f));
  const error = got === undefined || got === null
    ? `${property} of ${ref} could not be read back after the write${typeof res.readError === "string" ? ` (${res.readError})` : ""}; whether the console applied ${JSON.stringify(value)} is unknown`
    : locks.length
    ? `${ref} is locked (${lockText}): the console kept ${property} = ${JSON.stringify(got)} and did not apply ${JSON.stringify(value)}. ${unlock ? `Unlock it first (Unlock ${ref}), set the property, and lock it again` : "StructureLocked and SystemLocked are the console's own read-only locks, which Unlock does not remove"}`
    : owner
    ? `${owner.ref} is locked (Lock = ${JSON.stringify(owner.lock)}), which blocks writes to ${ref}: the console kept ${property} = ${JSON.stringify(got)} and did not apply ${JSON.stringify(value)}. Unlock it first (Unlock ${owner.ref}), set the property, and lock it again`
    : unchanged
      ? `the console did not apply ${property} = ${JSON.stringify(value)} on ${ref}: it still reads ${JSON.stringify(got)} (the console silently keeps the previous value when it does not accept one)`
      : old !== undefined && old !== null
        ? `${property} of ${ref} reads ${JSON.stringify(got)} after the write (it was ${JSON.stringify(old)}), not ${JSON.stringify(value)}: the console put its own value in place of one it does not accept`
      : `${property} of ${ref} reads ${JSON.stringify(got)} after the write, not ${JSON.stringify(value)}; the value before could not be read, so whether the console applied it is unknown`;
  return { result: { ...res, requested: value, before: old ?? null, verified: false, ...lockInfo, error }, failed: true };
}
