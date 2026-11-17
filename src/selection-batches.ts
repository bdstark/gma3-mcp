/**
 * Bounded fixture selections.
 *
 * grandMA3 rejected a 9,273-character `Fixture a + b + …` selection (530 fixtures, Night Shift console, 2026-10) and
 * accepted a 5,663-character one. The parser's exact limit is not known; the evidence is about characters, so a
 * selection command is kept within 4,096 characters, the bound Night Shift's authorer used natively.
 *
 * A selection within the bound is returned unchanged, character for character. Only a selection over it is rewritten,
 * and only in exact ways:
 *   1. compact: a keyword that repeats the one in force is dropped (`Fixture 1 + Fixture 3` -> `Fixture 1 + 3`), and
 *      three or more consecutive ascending fixture ids become one range (`Fixture 1 + 2 + 3` -> `Fixture 1 Thru 3`).
 *      The set and the selection order are the same; sub-fixture ids (`501.1`) and other keywords keep their entries.
 *   2. split: when the compact form is still over the bound, it is cut into several selections, each within it.
 *      A split selection is never sent as consecutive select commands: grandMA3 adds a second `Fixture …` to the
 *      selection only while the selected fixtures have no active values and replaces it otherwise. Callers instead
 *      run their whole per-selection work (ClearSelection, select, values, read-back) once per part.
 * A selection this cannot read exactly (one that removes fixtures with `-`, or an open `Thru`) is left as it is, and a
 * caller that cannot split (a phaser, which spreads across its whole selection) sends the compact form: in both cases
 * one command, as before, and the console decides.
 */
export const MAX_SELECTION_CHARACTERS = 4096;

export interface SelectionEntry {
  keyword: string;
  from: string;
  to?: string;
}
type Entry = SelectionEntry;

const KEYWORDS = new Map(["fixture", "group", "channel", "subfixture"].map((k) => [k, k[0].toUpperCase() + k.slice(1)]));
const ID = /^\d+(?:\.\d+)*$/;

/**
 * The entries of `Keyword id [Thru id] (+ [Keyword] id [Thru id])*`, each with the keyword it inherits (grandMA3
 * keeps the last keyword: in `Group 3 + 4`, 4 is a group). Null for anything else, including `-` and open ranges.
 */
function parse(selection: string): Entry[] | null {
  const tokens = selection.trim().split(/\s+/);
  const entries: Entry[] = [];
  let keyword: string | undefined;
  let i = 0;
  while (i < tokens.length) {
    if (entries.length) {
      if (tokens[i] !== "+") return null;
      i++;
    }
    const named = KEYWORDS.get(tokens[i]?.toLowerCase());
    if (named) {
      keyword = named;
      i++;
    }
    if (!keyword || !ID.test(tokens[i] ?? "")) return null;
    const entry: Entry = { keyword, from: tokens[i++] };
    if (tokens[i]?.toLowerCase() === "thru") {
      if (!ID.test(tokens[i + 1] ?? "")) return null;
      entry.to = tokens[i + 1];
      i += 2;
    }
    entries.push(entry);
  }
  return entries.length ? entries : null;
}

function plainId(e: Entry): number | null {
  if (e.keyword !== "Fixture" || e.to !== undefined || !/^\d+$/.test(e.from)) return null;
  const n = Number(e.from);
  return Number.isSafeInteger(n) ? n : null;
}

/** Runs of three or more consecutive ascending plain fixture ids become one `a Thru b` entry, in place. */
function compact(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; ) {
    let j = i;
    const first = plainId(entries[i]);
    if (first !== null) while (j + 1 < entries.length && plainId(entries[j + 1]) === first + (j + 1 - i)) j++;
    if (j - i >= 2) out.push({ keyword: "Fixture", from: entries[i].from, to: entries[j].from });
    else for (let k = i; k <= j; k++) out.push(entries[k]);
    i = j + 1;
  }
  return out;
}

function render(entries: Entry[]): string {
  return entries
    .map((e, i) => `${i === 0 || entries[i - 1].keyword !== e.keyword ? `${e.keyword} ` : ""}${e.from}${e.to === undefined ? "" : ` Thru ${e.to}`}`)
    .join(" + ");
}

/** The entries of a selection read exactly (`Keyword id [Thru id] (+ ...)`, keywords inherited), or null (`-`, open ranges). */
export function selectionEntries(selection: string): SelectionEntry[] | null {
  return parse(selection);
}

/** Entries as one selection, the keyword written only where it changes. */
export function renderSelection(entries: SelectionEntry[]): string {
  return render(entries);
}

/** The same selection, shorter when it is over the bound, otherwise unchanged. The result may still be over it. */
export function compactSelection(selection: string): string {
  if (selection.length <= MAX_SELECTION_CHARACTERS) return selection;
  const entries = parse(selection);
  return entries ? render(compact(entries)) : selection;
}

/**
 * The selection as one or more selections that each fit one command. One part: within the bound (unchanged), compacted
 * to fit, or not readable exactly (unchanged, may be over the bound). Several parts: each needs its own ClearSelection
 * and per-selection work.
 */
export function splitSelection(selection: string): string[] {
  if (selection.length <= MAX_SELECTION_CHARACTERS) return [selection];
  const entries = parse(selection);
  if (!entries) return [selection];
  const compacted = compact(entries);
  const whole = render(compacted);
  if (whole.length <= MAX_SELECTION_CHARACTERS) return [whole];
  const parts: Entry[][] = [];
  let part: Entry[] = [];
  for (const entry of compacted) {
    if (part.length && render([...part, entry]).length > MAX_SELECTION_CHARACTERS) {
      parts.push(part);
      part = [];
    }
    part.push(entry);
  }
  if (part.length) parts.push(part);
  return parts.map(render);
}
