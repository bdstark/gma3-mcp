import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SELECTION_CHARACTERS, compactSelection, splitSelection } from "../src/selection-batches.ts";
import { Validator, fixtureSelection } from "../src/validate.ts";
import { fixtureRange } from "../src/tools/inspection.ts";
import { validateLooks } from "../src/tools/cuelists.ts";

/** Ids of a selection as grandMA3 would read them (ranges expanded, keyword carried), in order. */
function idsOf(selection: string): string[] {
  const out: string[] = [];
  let keyword = "";
  for (const entry of selection.split(" + ")) {
    const m = entry.match(/^(?:(Fixture|Group|Channel|Subfixture) )?(\S+)(?: [Tt]hru (\S+))?$/);
    assert(m, `unexpected entry ${entry}`);
    if (m[1]) keyword = m[1];
    if (m[3] === undefined) out.push(`${keyword} ${m[2]}`);
    else for (let i = Number(m[2]); i <= Number(m[3]); i++) out.push(`${keyword} ${i}`);
  }
  return out;
}

const fits = (s: string) => s.length <= MAX_SELECTION_CHARACTERS;
/** n fixtures with gaps (odd 5-digit ids), so no run collapses: 530 of them is 4,245 characters. */
const odd = (n: number) => Array.from({ length: n }, (_, i) => String(10001 + 2 * i));

test("a selection within the bound is returned unchanged, character for character, however many entries it has", () => {
  const many = `Fixture ${odd(400).join(" + ")}`;
  assert(fits(many));
  for (const s of ["Fixture 1", "Fixture 1 + 2 + 3 + 4", "Fixture 101 Thru 110 - 105", "Group 5 + Fixture 3", "Fixture 1 + Fixture 3", many]) {
    assert.deepEqual(splitSelection(s), [s]);
    assert.equal(compactSelection(s), s);
  }
});

test("1,200 consecutive ids over the bound become one range (same set, same order)", () => {
  const s = `Fixture ${Array.from({ length: 1200 }, (_, i) => i + 1).join(" + ")}`;
  assert(!fits(s));
  assert.equal(compactSelection(s), "Fixture 1 Thru 1200");
  assert.deepEqual(splitSelection(s), ["Fixture 1 Thru 1200"]);
});

test("a repeated keyword is dropped when that alone makes it fit (gma3_store_preset's Fixture a + Fixture b form)", () => {
  const s = odd(300).map((id) => `Fixture ${id}`).join(" + ");
  assert(!fits(s));
  const parts = splitSelection(s);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], `Fixture ${odd(300).join(" + ")}`);
  assert.deepEqual(idsOf(parts[0]), idsOf(s));
});

test("530 ids with gaps over the bound split into parts that each fit, and together select the same fixtures in order", () => {
  const s = `Fixture ${odd(530).join(" + ")}`;
  assert.equal(s.length, 4245);
  const parts = splitSelection(s);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert(fits(part), `${part.length} characters`);
    assert.match(part, /^Fixture \d/, "every part names its keyword");
  }
  assert.deepEqual(parts.flatMap(idsOf), idsOf(s));
});

test("the Night Shift shape (530 sub-fixture ids, as gma3_store_preset writes them, over 9,000 characters) fits in parts", () => {
  const ids = Array.from({ length: 530 }, (_, i) => `${2001 + i}.${(i % 3) + 1}`);
  const s = ids.map((id) => `Fixture ${id}`).join(" + ");
  assert(s.length > 9000);
  const parts = splitSelection(s);
  assert(parts.length >= 2);
  for (const part of parts) assert(fits(part));
  assert.deepEqual(parts.flatMap(idsOf), idsOf(s), "sub-fixture ids are never collapsed into ranges");
});

test("the bound: 4,096 characters fit, 4,097 do not", () => {
  const base = `Fixture ${odd(100).join(" + ")}`;
  const pad = (n: number) => `${base} + ${"9".repeat(n)}`;
  const exact = pad(MAX_SELECTION_CHARACTERS - base.length - 3);
  assert.equal(exact.length, MAX_SELECTION_CHARACTERS);
  assert.deepEqual(splitSelection(exact), [exact]);
  const over = pad(MAX_SELECTION_CHARACTERS - base.length - 2);
  assert.equal(over.length, MAX_SELECTION_CHARACTERS + 1);
  const parts = splitSelection(over);
  assert.equal(parts.length, 2);
  for (const part of parts) assert(fits(part));
  assert.deepEqual(parts.flatMap(idsOf), idsOf(over));
});

test("only ascending runs of three or more plain fixture ids collapse; groups, sub-ids and unsafe ids keep their entries", () => {
  const s = `Fixture 5 + 6 + 9 + 8 + 7 + 20 + 21 + 22 + 23 + 501.1 + 501.2 + 501.3 + Group 1 + 2 + 3 + 4 + Fixture 9007199254740993 + 9007199254740994 + 9007199254740995 + ${odd(600).join(" + ")}`;
  const compacted = compactSelection(s);
  assert.match(compacted, /^Fixture 5 \+ 6 \+ 9 \+ 8 \+ 7 \+ 20 Thru 23 \+ 501\.1 \+ 501\.2 \+ 501\.3 \+ Group 1 \+ 2 \+ 3 \+ 4 \+ Fixture 9007199254740993 \+ 9007199254740994 \+ 9007199254740995 \+ 10001 /);
  const parts = splitSelection(s);
  assert(parts.length >= 2);
  assert.deepEqual(parts.flatMap(idsOf), idsOf(compacted));
  assert(parts.slice(1).every((p) => /^(Fixture|Group) \d/.test(p)), "a part that starts mid-list repeats the keyword it inherits");
});

test("ranges given in an over-bound selection stay ranges (any case of thru)", () => {
  const s = `Fixture 1 thru 10 + ${odd(600).join(" + ")} + 3001 Thru 3005`;
  const parts = splitSelection(s);
  assert(parts.length >= 2);
  assert(parts[0].startsWith("Fixture 1 Thru 10 + 10001"), parts[0].slice(0, 40));
  assert.match(parts.at(-1)!, /\+ 3001 Thru 3005$/);
  assert.deepEqual(parts.flatMap(idsOf), idsOf(s));
});

test("an over-bound selection this cannot read exactly (- or an open Thru) is left as one command, unchanged", () => {
  for (const s of [`Fixture ${odd(600).join(" + ")} - 10001`, `Fixture ${odd(600).join(" + ")} + 3001 Thru`]) {
    assert.deepEqual(splitSelection(s), [s]);
    assert.equal(compactSelection(s), s);
  }
});

test("fixtureSelection and fixtureRange compact an over-bound list and leave a short one as it was", () => {
  const long = Array.from({ length: 1200 }, (_, i) => i + 1).join(" + ");
  assert.equal(fixtureSelection("fixtures", long), "Fixture 1 Thru 1200");
  assert.equal(fixtureRange("fixtures", long), "Fixture 1 Thru 1200");
  assert.equal(fixtureSelection("fixtures", "1 + 2 + 3"), "Fixture 1 + 2 + 3");
  assert.equal(fixtureRange("fixtures", "1 + 2 + 3"), "Fixture 1 + 2 + 3");
});

test("validateLooks splits an over-bound look into parts with the same content; a phaser look stays one command", () => {
  const v = new Validator();
  const looks = validateLooks(v, { fixtures: odd(530).join(" + "), intensity: 70, presets: [{ pool: 4, preset: 1 }] }, "cue", undefined);
  assert.equal(v.errors.length, 0, v.errors.join("; "));
  assert.equal(looks.length, 2);
  assert.deepEqual(looks.map((l) => l.selectionPart), [{ index: 1, of: 2 }, { index: 2, of: 2 }]);
  for (const l of looks) {
    assert.equal(l.intensity, 70);
    assert.deepEqual(l.presets.map((p) => p.ref), ["Preset 4.1"]);
  }
  assert.deepEqual(looks.flatMap((l) => idsOf(l.fixtures)), odd(530).map((id) => `Fixture ${id}`));

  const short = validateLooks(new Validator(), { fixtures: odd(200).join(" + "), intensity: 70 }, "cue", undefined);
  assert.equal(short.length, 1, "200 fixtures in about 1,600 characters are one look, as before");
  assert.equal(short[0].selectionPart, undefined);

  const p = new Validator();
  const phaser = { steps: [{ values: { ColorRGB_R: 100 } }, { values: { ColorRGB_R: 0 } }], phaser: { speed_bpm: 120 } };
  const phaserLooks = validateLooks(p, { fixtures: odd(530).join(" + "), phaser }, "cue", undefined);
  assert.equal(p.errors.length, 0, p.errors.join("; "));
  assert.equal(phaserLooks.length, 1, "a phaser spreads across its whole selection: never split");
  assert.equal(phaserLooks[0].fixtures, `Fixture ${odd(530).join(" + ")}`);
});
