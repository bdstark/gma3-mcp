import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import {
  registerGroupTools,
  expandArrangement,
  rowOffsets,
  type Arrangement,
  expandFixtures,
  explicitItems,
  analyzeGrid,
  compareGrid,
  matricksValue,
  matricksWanted,
  allMatricksProps,
  MATRICKS_OTHER_DEFAULTS,
  type GridItem,
} from "../src/tools/groups.ts";
import { ValidationError } from "../src/validate.ts";

/**
 * A model of the console objects SB-02 touches, with the onPC 2.5.1 behaviour the probe established
 * (docs/probes/sb-02-groups-macos-2.5.1.md):
 *   - `Grid x/y/z` moves the cursor; `Fixture <id>` selects at the cursor; selecting a selected fixture is ignored;
 *   - Store Group keeps the selection in PATCH order (subfixture index), overwrites an existing group and keeps its
 *     name; a locked group answers "Object locked";
 *   - recalling `Group n` adds the cursor to the stored cells (with PreserveGridPositions);
 *   - Store MAtricks copies the selection MAtricks; MAtricks values the console does not accept are silently
 *     ignored; speed is read back in Hz in the edit role.
 */
interface Cell {
  id: string;
  x: number;
  y: number;
  z: number;
}

const PATCH: Record<string, number> = { "401": 63, "402": 64, "403": 65, "404": 66, "701": 5, "702": 6, "501": 10, "501.1": 11, "501.2": 12, "501.3": 13 };
/** Cell 501.3 also has its own FID 9001: the console selects it by either id and reads it back as 9001. */
const ALIAS: Record<string, string> = { "9001": "501.3" };
const OWN_FID: Record<string, number> = { "501.3": 9001 };
const canonical = (id: string) => ALIAS[id] ?? id;
const MTX_PROPS = [...allMatricksProps(), ...Object.keys(MATRICKS_OTHER_DEFAULTS)];
const freshMatricks = (): Record<string, string> => {
  const m: Record<string, string> = {};
  for (const p of allMatricksProps()) m[p] = "None";
  Object.assign(m, MATRICKS_OTHER_DEFAULTS);
  return m;
};

class Console {
  groups = new Map<number, { name: string; lock: string; preserve: string; cells: Cell[] }>();
  matricks = new Map<number, Record<string, string>>();
  selection: Cell[] = [];
  cursor = { x: 0, y: 0, z: 0 };
  selMtx = freshMatricks();
  /** Fixture ids whose Fixture command is answered OK but selects nothing. */
  ignoreSelect = new Set<string>();
  /** Answer the selection.grid / group.read ops as an old bridge would (unknown op). */
  oldBridge = false;
  /** Cells to shift after Store (simulating a console that stores something else). */
  corruptStore = false;
  /** MAtricks values the console refuses (silently kept). */
  refuse = new Set<string>();
  /** MAtricks properties every read leaves out (the bridge could not read them). */
  hidden = new Set<string>();
  /** Answer the n-th ClearSelection (1-based) with an error. */
  failClearCall = 0;
  /** #102: the pool listings (children of DataPool.Groups / DataPool.MAtricks) read, in order, and whether they fail. */
  listed: string[] = [];
  failChildren = false;
  /** Review of #115: bridge 0.47.0 answers a failed Children() with enumerationError, a failed field read with fieldErrors. */
  listingFault: "" | "enumeration" | "field" = "";
  /**
   * #102: what a Name write does when another object of the pool has the name. Not probed for groups or MAtricks:
   * "suffix" models the preset pool's rule ("Front" -> "Front#2", live for presets 2026-10-25), "keep" a console
   * that allows the duplicate.
   */
  duplicateName: "suffix" | "keep" = "suffix";
  /** #102: groups whose Name write the console rejects. */
  rejectNameFor = new Set<number>();
  private uniqueName<T extends { name?: string; Name?: string }>(pool: Map<number, T>, n: number, value: string): string {
    const taken = [...pool].some(([k, o]) => k !== n && String(o.name ?? o.Name ?? "").toLowerCase() === value.toLowerCase());
    return taken && this.duplicateName === "suffix" ? `${value}#2` : value;
  }
  private clearCalls = 0;

  private read(c: Cell) {
    const own = OWN_FID[c.id] ?? (c.id.includes(".") ? null : Number(c.id));
    return { sfIndex: PATCH[c.id], fixture: own !== null ? String(own) : c.id, fid: own, path: c.id.includes(".") ? c.id : null, addr: `addr:${c.id}`, name: `fx ${c.id}`, x: c.x, y: c.y, z: c.z };
  }

  install(h: Harness): void {
    h.fake.on("objects", (args) => {
      const ref = String(args.ref);
      const fields = (args.fields as string[]) ?? [];
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Fixture (\S+)$/))) {
        const id = canonical(m[1]);
        if (!(id in PATCH)) throw new Error(`no objects found for '${ref}'`);
        return { total: 1, offset: 0, count: 1, items: [{ name: `fx ${id}`, class: id.includes(".") ? "SubFixture" : "Fixture", addr: `addr:${id}`, fields: {} }] };
      }
      if ((m = ref.match(/^Group (\d+)$/))) {
        const g = this.groups.get(Number(m[1]));
        if (!g) throw new Error(`no objects found for '${ref}'`);
        return { total: 1, offset: 0, count: 1, items: [{ name: g.name, class: "Group", fields: pick({ Name: g.name, Lock: g.lock, StructureLocked: "No", SystemLocked: "No" }, fields) }] };
      }
      if ((m = ref.match(/^MAtricks (\d+)$/))) {
        const mt = this.matricks.get(Number(m[1]));
        if (!mt) throw new Error(`no objects found for '${ref}'`);
        return { total: 1, offset: 0, count: 1, items: [{ name: mt.Name, class: "MAtrick", fields: pick({ ...this.editRole(mt), StructureLocked: "No", SystemLocked: "No" }, fields) }] };
      }
      throw new Error(`unexpected objects ref ${ref}`);
    });
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      this.listed.push(ref);
      if (this.failChildren) throw new Error("timeout");
      const pool: Array<[number, string]> =
        ref === "DataPool.Groups" ? [...this.groups].map(([n, g]) => [n, g.name]) : ref === "DataPool.MAtricks" ? [...this.matricks].map(([n, m]) => [n, m.Name]) : (() => { throw new Error(`unexpected children ${ref}`); })();
      if (this.listingFault === "enumeration") return { total: 0, offset: 0, count: 0, items: [], enumerationError: "Children failed" };
      const items = pool.sort(([a], [b]) => a - b).map(([n, name]) => ({ name, index: n, addr: `addr.${n}`, fields: { No: String(n), Name: name } }));
      if (this.listingFault === "field") Object.assign(items[0], { fields: { No: items[0].fields.No }, fieldErrors: { Name: "Get failed" } });
      return { total: items.length, offset: 0, count: items.length, items };
    });
    h.fake.on("selection.grid", () => {
      if (this.oldBridge) throw new Error("unknown op 'selection.grid'");
      return { count: this.selection.length, items: this.selection.map((c) => this.read(c)) };
    });
    h.fake.on("group.read", (args) => {
      if (this.oldBridge) throw new Error("unknown op 'group.read'");
      const n = Number(String(args.ref).replace("Group ", ""));
      const g = this.groups.get(n);
      if (!g) throw new Error(`no object found for '${args.ref}'`);
      return { ref: args.ref, no: n, name: g.name, lock: g.lock, preserveGridPositions: g.preserve, count: g.cells.length, unreadable: 0, items: g.cells.map((c) => this.read(c)) };
    });
    h.fake.on("set", (args) => {
      const ref = String(args.ref);
      const property = String(args.property);
      const value = String(args.value);
      let m: RegExpMatchArray | null;
      if ((m = ref.match(/^Group (\d+)$/))) {
        const g = this.groups.get(Number(m[1]))!;
        if (property === "Name" && this.rejectNameFor.has(Number(m[1]))) throw new Error("Illegal value");
        if (g.lock === "") {
          if (property === "Name") g.name = this.uniqueName(this.groups, Number(m[1]), value);
          if (property === "PreserveGridPositions") g.preserve = value;
        }
        return { ref, property, value: property === "Name" ? g.name : g.preserve };
      }
      if ((m = ref.match(/^MAtricks (\d+)$/))) {
        const mt = this.matricks.get(Number(m[1]))!;
        const accepted = property === "SpeedMasterOverride" ? /^\d+$/.test(value) : true;
        if (accepted && !this.refuse.has(`${property}=${value}`) && mt.Lock === "") {
          // As on 2.5.1: changing the override while SpeedFromX is None sets SpeedFromX to 60 BPM.
          if (property === "SpeedMasterOverride" && mt.SpeedFromX === "None") mt.SpeedFromX = "60";
          mt[property] = property === "SpeedMasterOverride" ? (value === "0" ? "" : `Master ${value}`) : property === "Name" ? this.uniqueName(this.matricks, Number(m[1]), value) : value;
        }
        return { ref, property, value: this.editRole(mt)[property] };
      }
      throw new Error(`unexpected set ref ${ref}`);
    });
    h.fake.on("cmd", (args) => {
      const c = String(args.command);
      let m: RegExpMatchArray | null;
      if (c === "ClearSelection") {
        if (++this.clearCalls === this.failClearCall) return { feedback: "Error #72: Command not executed" };
        this.selection = [];
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Grid (-?\d+)\/(-?\d+)\/(-?\d+)$/))) { this.cursor = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }; return { feedback: "OK" }; }
      if ((m = c.match(/^Fixture (\S+)$/))) {
        const id = canonical(m[1]);
        if (!(id in PATCH)) return { feedback: "Object not found" };
        if (!this.ignoreSelect.has(id) && !this.selection.some((s) => s.id === id)) this.selection.push({ id, ...this.cursor });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Store Group (\d+)( \/Overwrite)? \/NoConfirmation$/))) {
        const n = Number(m[1]);
        const old = this.groups.get(n);
        if (old?.lock) return { feedback: "Object locked" };
        const cells = [...this.selection].sort((a, b) => PATCH[a.id] - PATCH[b.id]).map((s) => ({ ...s }));
        if (this.corruptStore) cells[0].x += 1;
        this.groups.set(n, { name: old?.name ?? `Group ${n}`, lock: "", preserve: "Yes", cells });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Group (\d+)$/))) {
        const g = this.groups.get(Number(m[1]));
        if (!g) return { feedback: "Object not found" };
        // A lone fixture is recalled at the cursor, whatever its stored cell (live 2026-10-22).
        if (g.cells.length === 1) {
          if (!this.selection.some((x) => x.id === g.cells[0].id)) this.selection.push({ id: g.cells[0].id, ...this.cursor });
          return { feedback: "OK" };
        }
        for (const s of g.cells) if (!this.selection.some((x) => x.id === s.id)) this.selection.push({ id: s.id, x: s.x + this.cursor.x, y: s.y + this.cursor.y, z: s.z + this.cursor.z });
        return { feedback: "OK" };
      }
      if ((m = c.match(/^Store MAtricks (\d+) \/NoConfirmation$/))) {
        this.matricks.set(Number(m[1]), { ...this.selMtx, Name: `MAtrick ${m[1]}`, Lock: "" });
        return { feedback: "OK" };
      }
      throw new Error(`unexpected command ${c}`);
    });
  }

  /** Edit-role display: times "2.00", phase "360°" (up to 360) or "720.00", speed in Hz, "None". */
  editRole(mt: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(mt)) {
      if (this.hidden.has(k)) continue;
      if (v === "None" || !/^-?\d+(\.\d+)?$/.test(v)) { out[k] = v; continue; }
      if (k.startsWith("Speed")) out[k] = (Number(v) / 60).toFixed(6);
      else if (k.startsWith("Phase")) out[k] = Math.abs(Number(v)) <= 360 ? `${Number(v)}°` : Number(v).toFixed(2);
      else if (k.startsWith("Fade") || k.startsWith("Delay")) out[k] = Number(v).toFixed(2);
      else out[k] = Number(v) === 0 ? "None" : String(Number(v));
    }
    return out;
  }
}

function pick(all: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in all) out[f] = all[f];
  return out;
}

let h: Harness;
let con: Console;
before(async () => {
  h = await startHarness(registerGroupTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  con = new Console();
  con.install(h);
});

const commands = () => h.fake.requests.filter((r) => r.op === "cmd").map((r) => String(r.args.command));
const mutations = () => h.fake.requests.filter((r) => r.op === "cmd" || r.op === "set");
const cells = (items: GridItem[]) => items.map((i) => `${i.fixture}@${i.x}/${i.y}/${i.z}`);

// ---------------------------------------------------------------------------
// Expansion, analysis, comparison
// ---------------------------------------------------------------------------

test("fixture ids and ranges expand and normalise; bad ids and ranges are refused", () => {
  assert.deepEqual(expandFixtures("f", "401 Thru 404"), ["401", "402", "403", "404"]);
  assert.deepEqual(expandFixtures("f", "501.1 thru 501.3"), ["501.1", "501.2", "501.3"]);
  assert.deepEqual(expandFixtures("f", 401), ["401"]);
  assert.deepEqual(expandFixtures("f", "0401"), ["401"]);
  assert.deepEqual(expandFixtures("f", "99999999"), ["99999999"]);
  assert.equal(expandFixtures("f", "1 Thru 512").length, 512);
  assert.equal(expandFixtures("f", "99999488 Thru 99999999").length, 512);
  // SU-12: a range runs in its own direction (the Festoon's string listed from its far end).
  assert.deepEqual(expandFixtures("f", "404 Thru 401"), ["404", "403", "402", "401"]);
  assert.deepEqual(expandFixtures("f", "402.36 Thru 402.34"), ["402.36", "402.35", "402.34"]);
  assert.equal(expandFixtures("f", "512 Thru 1").length, 512);
  for (const bad of [
    "513 Thru 1", "501.1 Thru 502.2", "501 Thru 501.3", "Group 3", "4a", "", 0, 1.5, "1 Thru 9999",
    // Unbounded parts are refused before any expansion (2^53 cannot be incremented).
    "9007199254740992 Thru 9007199254740992", 9007199254740992, "1.9007199254740992", "100000000", 100000000, "1.100000", "1.1.1.1.1.1.1.1.1",
  ]) {
    assert.throws(() => expandFixtures("f", bad), ValidationError, String(bad));
  }
});

test("SU-12: rows of different lengths spread over one width; start and center pack them; too long a row is refused", () => {
  // Spread: first and last fixture at the edges, the rest as evenly as whole cells allow.
  assert.deepEqual(rowOffsets(5, 9, "spread"), [0, 2, 4, 6, 8]);
  assert.deepEqual(rowOffsets(3, 8, "spread"), [0, 4, 7]);
  assert.deepEqual(rowOffsets(1, 7, "spread"), [3]);
  assert.deepEqual(rowOffsets(4, 4, "spread"), [0, 1, 2, 3]);
  assert.deepEqual(rowOffsets(2, 6, "center"), [2, 3]);
  assert.deepEqual(rowOffsets(2, 6, "start"), [0, 1]);
  for (let n = 1; n <= 12; n++) for (let w = n; w <= 14; w++) assert.equal(new Set(rowOffsets(n, w, "spread")).size, n, `${n} in ${w}: no shared cell`);

  const items = expandArrangement({ type: "rows", rows: [["101 Thru 105"], ["204 Thru 202"], [301]], origin: { x: 1, y: 2 } } as Arrangement);
  assert.deepEqual(items, [
    { fixture: "101", x: 1, y: 2, z: 0 }, { fixture: "102", x: 2, y: 2, z: 0 }, { fixture: "103", x: 3, y: 2, z: 0 }, { fixture: "104", x: 4, y: 2, z: 0 }, { fixture: "105", x: 5, y: 2, z: 0 },
    { fixture: "204", x: 1, y: 3, z: 0 }, { fixture: "203", x: 3, y: 3, z: 0 }, { fixture: "202", x: 5, y: 3, z: 0 },
    { fixture: "301", x: 3, y: 4, z: 0 },
  ]);
  const wide = expandArrangement({ type: "rows", rows: [[1, 2], [3]], width: 5, align: "center", step_y: -1 } as Arrangement);
  assert.deepEqual(wide.map((i) => `${i.fixture}@${i.x}/${i.y}`), ["1@1/0", "2@2/0", "3@2/-1"]);
  assert.throws(() => expandArrangement({ type: "rows", rows: [["1 Thru 6"]], width: 5 } as Arrangement), /6 fixtures, more than the width of 5/);
  assert.throws(() => expandArrangement({ type: "rows", rows: [] } as unknown as Arrangement), /non-empty list of rows/);
  assert.throws(() => expandArrangement({ type: "rows", rows: [[1]], align: "left" } as unknown as Arrangement), /align must be spread, start or center/);
});

test("row, rectangle and mirror helpers expand into explicit cells", () => {
  assert.deepEqual(cells(expandArrangement({ type: "row", fixtures: ["401 Thru 403"], origin: { x: 2, y: 1 }, step: 2 })), ["401@2/1/0", "402@4/1/0", "403@6/1/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "row", fixtures: [401, 402], axis: "z", step: -1 })), ["401@0/0/0", "402@0/0/-1"]);
  assert.deepEqual(cells(expandArrangement({ type: "rectangle", fixtures: ["401 Thru 404", 701], columns: 2 })), ["401@0/0/0", "402@1/0/0", "403@0/1/0", "404@1/1/0", "701@0/2/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "rectangle", fixtures: ["401 Thru 404"], columns: 2, serpentine: true, step_y: -1 })), ["401@0/0/0", "402@1/0/0", "403@1/-1/0", "404@0/-1/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "mirror", left: [401, 402], right: [702, 701] })), ["401@0/0/0", "402@1/0/0", "702@3/0/0", "701@2/0/0"]);
  assert.deepEqual(cells(expandArrangement({ type: "mirror", left: [401], right: [701], center_gap: 2, origin: { x: -1 } })), ["401@-1/0/0", "701@2/0/0"]);
  for (const bad of [
    { type: "mirror", left: [401, 402], right: [701] },
    { type: "row", fixtures: [] },
    { type: "row", fixtures: [401], step: 0 },
    { type: "rectangle", fixtures: [401], columns: 0 },
    { type: "row", fixtures: ["401 Thru 402"], origin: { x: 9999 } },
    { type: "spiral", fixtures: [401] },
  ]) {
    assert.throws(() => expandArrangement(bad as never), ValidationError, JSON.stringify(bad));
  }
  assert.deepEqual(cells(explicitItems([{ fixture: "501.1", x: -1, y: 2, z: 1 }])), ["501.1@-1/2/1"]);
  for (const bad of [[], [{ fixture: 401, x: 0 }], [{ fixture: 401, x: 0.5, y: 0 }], [{ fixture: "x", x: 0, y: 0 }]]) assert.throws(() => explicitItems(bad), ValidationError, JSON.stringify(bad));
});

test("analysis reports duplicates, shared cells, a fixture with its cells, bounds, gaps and an offset", () => {
  const a = analyzeGrid(explicitItems([{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 0, y: 0 }, { fixture: 401, x: 3, y: 0 }, { fixture: 501, x: 2, y: 1 }, { fixture: "501.1", x: 1, y: 1 }]));
  assert.deepEqual(a.duplicates, [{ fixture: "401", positions: [1, 3] }]);
  assert.deepEqual(a.sharedCells, [{ cell: "0/0/0", fixtures: ["401", "402"] }]);
  assert.deepEqual(a.parentAndCell, [{ parent: "501", cells: ["501.1"] }]);
  assert.deepEqual(a.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 1, z: 0 } });
  assert.equal(a.gaps, 8 - 4);
  assert.equal(a.offsetFromOrigin, false);
  assert.equal(analyzeGrid(explicitItems([{ fixture: 401, x: 2, y: 2 }])).offsetFromOrigin, true);
});

test("grid comparison matches by fixture, not by list position", () => {
  const want = explicitItems([{ fixture: 401, x: 0, y: 0 }, { fixture: 701, x: 1, y: 0 }]);
  const read = [{ fixture: "701", fid: 701, x: 1, y: 0, z: 0 }, { fixture: "401", fid: 401, x: 0, y: 0, z: 0 }];
  assert.deepEqual(compareGrid(want, read, true), []);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 0, y: 0, z: 0 }, { fixture: "702", x: 1, y: 0, z: 0 }], true), ["701 is missing", "unexpected 702 at 1/0/0"]);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 0, y: 0, z: 0 }, { fixture: "701", x: 2, y: 0, z: 0 }], true), ["701: expected cell 1/0/0, read 2/0/0"]);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 5, y: 0, z: 0 }, { fixture: "701", x: 9, y: 0, z: 0 }], false), []);
  assert.deepEqual(compareGrid(want, [{ fixture: "401", x: 0, y: 0, z: 0 }, { unreadable: true }], true), ["1 item(s) could not be read", "701 is missing"]);
  // A cell that has its own FID matches by that FID too.
  assert.deepEqual(compareGrid(explicitItems([{ fixture: 9001, x: 0, y: 0 }]), [{ fixture: "9001", fid: 9001, x: 0, y: 0, z: 0 }], true), []);
});

// ---------------------------------------------------------------------------
// gma3_store_group
// ---------------------------------------------------------------------------

test("store_group refuses duplicates, unacknowledged shared cells and a missing exclusive before sending anything", async () => {
  for (const [args, re] of [
    [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 401, x: 1, y: 0 }], exclusive: true }, /duplicate fixtures: 401 \(positions 1, 2\).*silently ignores/],
    [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 0, y: 0 }], exclusive: true }, /share grid cells: 0\/0\/0 \(401, 402\)/],
    [{ group: 905, arrangement: { type: "row", fixtures: [401] } }, /exclusive must be true/],
    [{ group: 905, exclusive: true }, /exactly one of items .* or arrangement/],
    [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }], arrangement: { type: "row", fixtures: [401] }, exclusive: true }, /exactly one/],
    [{ group: 0, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true }, /group must be >= 1/],
    [{ group: 905, name: "a.b", items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true }, /removes from names/],
  ] as const) {
    const { result, isError } = await h.callJson("gma3_store_group", args as unknown as Record<string, unknown>);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(result.validationErrors.join("; "), re, JSON.stringify(result.validationErrors));
  }
  assert.equal(h.fake.requests.length, 0, "nothing may reach the bridge");
});

test("store_group preview expands the plan and reads only", async () => {
  con.selection = [{ id: "702", x: 0, y: 0, z: 0 }];
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, arrangement: { type: "mirror", left: ["401 Thru 402"], right: [702, 701], center_gap: 1 }, preview: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(cells(result.plan.items), ["401@0/0/0", "402@1/0/0", "702@4/0/0", "701@3/0/0"]);
  assert.equal(result.plan.gaps, 1);
  assert.equal(result.selectionBefore, 1);
  assert.equal(result.preview, true);
  assert.match(result.summary, /would be created with 4 fixture\(s\); the current selection \(1 selected\) would be cleared/);
  assert.equal(mutations().length, 0);
  assert.equal(con.groups.size, 0);
});

test("store_group builds the selection cell by cell, stores, verifies the stored data and the recall, and cleans up", async () => {
  con.selection = [{ id: "403", x: 0, y: 0, z: 0 }];
  const items = [{ fixture: 402, x: 3, y: 0 }, { fixture: 401, x: 0, y: 0 }, { fixture: "501.1", x: -1, y: 2, z: 1 }, { fixture: 501, x: 5, y: 5 }];
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, name: "Front", items, exclusive: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(commands(), [
    "ClearSelection",
    "Grid 3/0/0", "Fixture 402", "Grid 0/0/0", "Fixture 401", "Grid -1/2/1", "Fixture 501.1", "Grid 5/5/0", "Fixture 501",
    "Store Group 905 /NoConfirmation",
    "ClearSelection", "Grid 0/0/0", "Group 905",
    "ClearSelection", "Grid 0/0/0",
  ]);
  // The console stores the group in patch order; the tool compares by fixture.
  const g = con.groups.get(905)!;
  assert.deepEqual(g.cells.map((c) => c.id), ["501", "501.1", "401", "402"]);
  assert.equal(g.name, "Front");
  assert.equal(g.preserve, "Yes");
  assert.equal(con.selection.length, 0, "no selection is left behind");
  assert.ok(result.warnings.some((w: string) => /501 with 501\.1/.test(w)), JSON.stringify(result.warnings));
  assert.equal(result.selectionBefore, 1);
  assert.deepEqual(result.resulting.items.map((i: { fixture: string }) => i.fixture), ["501", "501.1", "401", "402"]);
});

test("store_group keeps shared cells when allowed and preserve_grid_positions false checks fixtures only on recall", async () => {
  const shared = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 0, y: 0 }], allow_shared_cells: true, exclusive: true });
  assert.equal(shared.isError, false, JSON.stringify(shared.result));
  assert.ok(shared.result.warnings.some((w: string) => w.includes("shared cells kept")));
  h.fake.reset();
  con.install(h);
  const np = await h.callJson("gma3_store_group", { group: 906, items: [{ fixture: 401, x: 2, y: 2 }], preserve_grid_positions: false, exclusive: true });
  assert.equal(np.isError, false, JSON.stringify(np.result));
  assert.equal(con.groups.get(906)!.preserve, "No");
  assert.match(np.result.verification.checked, /fixtures only/);
  assert.ok(np.result.warnings.some((w: string) => /removes the gaps/.test(w)));
});

test("store_group: a one-fixture group off the origin matches; the recall (at the cursor) checks the fixture, read-back its cell (live 2026-10-22)", async () => {
  const { result, isError } = await h.callJson("gma3_store_group", { group: 990, items: [{ fixture: 401, x: 3, y: 2 }], exclusive: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.match(result.verification.checked, /lone fixture at the grid cursor/);
  assert.deepEqual(con.groups.get(990)!.cells.map((c) => `${c.id}@${c.x}/${c.y}/${c.z}`), ["401@3/2/0"]);
  // The stored cell is still checked: a store that lands elsewhere is a mismatch.
  h.fake.reset();
  con.install(h);
  con.corruptStore = true;
  const off = await h.callJson("gma3_store_group", { group: 991, items: [{ fixture: 401, x: 3, y: 2 }], exclusive: true });
  assert.equal(off.result.verification.status, "mismatched", JSON.stringify(off.result.verification));
  assert.match(off.result.verification.detail, /stored: /);
});

test("store_group refuses an existing group without overwrite, overwrites with /Overwrite and keeps the name, and refuses a locked group", async () => {
  con.groups.set(905, { name: "Keep", lock: "", preserve: "Yes", cells: [{ id: "701", x: 0, y: 0, z: 0 }] });
  const refused = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true });
  assert.equal(refused.isError, true);
  assert.match(refused.result.steps[0].error, /already exists; pass overwrite: true/);
  assert.equal(mutations().length, 0);
  const over = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], overwrite: true, exclusive: true });
  assert.equal(over.isError, false, JSON.stringify(over.result));
  assert.ok(commands().includes("Store Group 905 /Overwrite /NoConfirmation"));
  assert.equal(con.groups.get(905)!.name, "Keep");
  assert.deepEqual(con.groups.get(905)!.cells.map((c) => c.id), ["401"]);
  h.fake.reset();
  con.install(h);
  con.groups.get(905)!.lock = "UL";
  const locked = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 402, x: 0, y: 0 }], overwrite: true, exclusive: true });
  assert.equal(locked.isError, true);
  assert.match(locked.result.steps[0].error, /is locked/);
  assert.equal(mutations().length, 0);
});

test("store_group batch (SU-12): groups stored one after the other with compact specs; an existing one fails alone", async () => {
  con.groups.set(906, { name: "Keep", lock: "", preserve: "Yes", cells: [{ id: "701", x: 0, y: 0, z: 0 }] });
  const { result, isError } = await h.callJson("gma3_store_group", {
    exclusive: true,
    groups: [
      { group: 905, name: "Row", arrangement: { type: "row", fixtures: ["402 Thru 401"] } },
      { group: 906, items: [{ fixture: 401, x: 0, y: 0 }] },
      { group: 907, arrangement: { type: "rows", rows: [["401 Thru 402"], [701]], width: 3 } },
    ],
  });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.items.map((i: any) => `${i.target}:${i.outcome}:${i.verification}`), ["Group 905:succeeded:matched", "Group 906:failed:not_requested", "Group 907:succeeded:matched"]);
  assert.match(result.items[1].summary, /already exists; pass overwrite: true/);
  assert.deepEqual(con.groups.get(906)!.cells.map((c) => c.id), ["701"], "the refused group is untouched");
  assert.deepEqual(con.groups.get(905)!.cells.map((c) => `${c.id}@${c.x}`).sort(), ["401@1", "402@0"], "the reversed range runs downwards");
  assert.deepEqual(con.groups.get(907)!.cells.map((c) => `${c.id}@${c.x}/${c.y}`).sort(), ["401@0/0", "402@2/0", "701@1/1"], "the shorter row is spread over the width");
  assert.equal(con.groups.get(905)!.name, "Row");
});

test("store_group batch (SU-12): a group listed twice or a top-level group refuses the call; exclusive applies to every item", async () => {
  const dup = await h.callJson("gma3_store_group", { exclusive: true, groups: [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }] }, { group: 905, items: [{ fixture: 402, x: 0, y: 0 }] }] });
  assert.match(dup.result.validationErrors.join(" "), /Group 905 appears more than once/);
  const top = await h.callJson("gma3_store_group", { group: 905, exclusive: true, groups: [{ group: 906, items: [{ fixture: 401, x: 0, y: 0 }] }] });
  assert.match(top.result.validationErrors.join(" "), /give group in each item/);
  const noExcl = await h.callJson("gma3_store_group", { groups: [{ group: 905, items: [{ fixture: 401, x: 0, y: 0 }] }] });
  assert.match(noExcl.result.items[0].summary, /exclusive must be true/);
  assert.equal(mutations().length, 0);
});

test("store_group refuses fixtures that are not patched, before anything is sent", async () => {
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 999, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.steps.find((s: { name: string }) => s.name === "check_fixtures").detail.missing, ["999"]);
  assert.equal(mutations().length, 0);
});

test("store_group stores nothing when the built selection is not the plan, and still cleans up", async () => {
  con.ignoreSelect.add("402");
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  const check = result.steps.find((s: { name: string }) => s.name === "check_selection");
  assert.equal(check.status, "failed");
  assert.match(check.error, /402 is missing/);
  assert.equal(result.steps.find((s: { name: string }) => s.name === "store").status, "skipped");
  assert.equal(con.groups.size, 0);
  assert.ok(result.warnings.some((w: string) => /nothing was stored/.test(w)));
  assert.deepEqual(commands().slice(-2), ["ClearSelection", "Grid 0/0/0"]);
});

test("store_group reports a mismatch when the stored group differs from the plan", async () => {
  con.corruptStore = true;
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }, { fixture: 402, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /stored: 401: expected cell 0\/0\/0, read 1\/0\/0/);
  assert.match(result.verification.detail, /recalled: /);
});

test("store_group on an old bridge stops in the read phase with an update hint", async () => {
  con.oldBridge = true;
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.match(result.steps.find((s: { name: string }) => s.name === "read_selection").error, /bridge 0\.21\.0/);
  assert.equal(mutations().length, 0);
});

// ---------------------------------------------------------------------------
// gma3_selection_grid
// ---------------------------------------------------------------------------

test("selection_grid reads a stored group without selecting, and the current selection", async () => {
  con.groups.set(7, { name: "Grid", lock: "UL", preserve: "No", cells: [{ id: "501.1", x: -1, y: 2, z: 1 }, { id: "401", x: 0, y: 0, z: 0 }, { id: "402", x: 0, y: 0, z: 0 }] });
  const g = await h.callJson("gma3_selection_grid", { group: 7 });
  assert.equal(g.isError, false, g.text);
  assert.equal(g.result.locked, true);
  assert.equal(g.result.preserveGridPositions, false);
  assert.deepEqual(g.result.items.map((i: { fixture: string; x: number }) => `${i.fixture}@${i.x}`), ["501.1@-1", "401@0", "402@0"]);
  assert.deepEqual(g.result.sharedCells, [{ cell: "0/0/0", fixtures: ["401", "402"] }]);
  assert.match(g.result.note, /not physical stage positions.*PreserveGridPositions is off/);
  assert.equal(mutations().length, 0);
  const missing = await h.callJson("gma3_selection_grid", { group: 8 });
  assert.equal(missing.result.exists, false);
  con.selection = [{ id: "402", x: 3, y: 0, z: 0 }];
  const s = await h.callJson("gma3_selection_grid", {});
  assert.equal(s.result.source, "selection");
  assert.equal(s.result.items[0].fixture, "402");
  con.oldBridge = true;
  const old = await h.callJson("gma3_selection_grid", {});
  assert.equal(old.isError, true);
  assert.match(old.text, /bridge 0\.21\.0/);
});

// ---------------------------------------------------------------------------
// MAtricks
// ---------------------------------------------------------------------------

test("MAtricks display values are interpreted per kind", () => {
  assert.equal(matricksValue("int", "None"), null);
  assert.equal(matricksValue("int", "2"), 2);
  assert.equal(matricksValue("int", "-1"), -1);
  assert.equal(matricksValue("int", "x"), undefined);
  assert.equal(matricksValue("fade", "2.50"), 2.5);
  assert.equal(matricksValue("phase", "360°"), 360);
  assert.equal(matricksValue("phase", "720.00"), 720);
  assert.equal(matricksValue("phase", "-90.00"), -90);
  assert.equal(matricksValue("speed", "1.000000"), 60, "edit role: Hz");
  assert.equal(matricksValue("speed", "60.00 BPM"), 60, "display role: BPM");
  assert.equal(matricksValue("speed", "2 Hz"), 120);
  assert.equal(matricksValue("fade", undefined), undefined);
});

test("MAtricks specs validate per setting", () => {
  const w = matricksWanted({ x: { wings: 2, shift: -1, delay: { from: 1, to: 0 } }, y: { blocks: 0, speed: null } });
  assert.deepEqual(w.map((x) => `${x.property}=${x.value}`), ["XWings=2", "XShift=-1", "DelayFromX=1", "DelayToX=0", "YBlock=null", "SpeedFromY=null", "SpeedToY=null"]);
  for (const bad of [{ x: { wings: -1 } }, { x: { wings: 1.5 } }, { x: { delay: { from: -1, to: 0 } } }, { x: { delay: 2 } }, { x: { speed: { from: 0, to: 60 } } }, { x: { bogus: 1 } }, { x: 5 }]) {
    assert.throws(() => matricksWanted(bad as never), ValidationError, JSON.stringify(bad));
  }
});

test("configure_matricks creates an object holding exactly the request although Store copied a dirty selection MAtricks", async () => {
  con.selMtx.XGroup = "3";
  con.selMtx.FadeToY = "2";
  con.selMtx.InvertStyle = "All";
  const { result, isError } = await h.callJson("gma3_configure_matricks", { matricks: 905, name: "Centre out", create: true, x: { wings: 2, delay: { from: 1, to: 0 }, speed: { from: 60, to: 120 } } });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  const m = con.matricks.get(905)!;
  assert.equal(m.XWings, "2");
  assert.equal(m.DelayFromX, "1");
  assert.equal(m.DelayToX, "0");
  assert.equal(m.SpeedToX, "120");
  assert.equal(m.XGroup, "None");
  assert.equal(m.FadeToY, "None");
  assert.equal(m.InvertStyle, "Pan");
  assert.equal(m.Name, "Centre out");
  assert.deepEqual(result.intended.afterStore.resets.map((r: { property: string }) => r.property).sort(), ["FadeToY", "InvertStyle", "XGroup"]);
  assert.equal(con.selMtx.XGroup, "3", "the selection MAtricks is not changed");
  // Only what differs after Store is written.
  assert.equal(h.fake.requests.filter((r) => r.op === "set").length, 5 + 3 + 1);
  const read = await h.callJson("gma3_matricks", { matricks: 905 });
  assert.deepEqual(read.result.axes.x.delay, { from: 1, to: 0 });
  assert.deepEqual(read.result.axes.x.speed, { from: 60, to: 120 });
  assert.equal(read.result.axes.x.wings, 2);
  assert.equal(read.result.axes.y.fade, null);
});

test("configure_matricks updates only changed settings, stops at a value the console ignores, and refuses missing or locked objects", async () => {
  con.matricks.set(5, { ...freshMatricks(), XWings: "2", Name: "M5", Lock: "" });
  const noop = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 2 } });
  assert.equal(noop.isError, false);
  assert.equal(noop.result.noop, true);
  assert.equal(mutations().length, 0);
  const pv = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: null, phase: { from: 0, to: 720 } }, preview: true });
  assert.deepEqual(pv.result.intended.changes.map((c: { property: string; to: string }) => `${c.property}=${c.to}`), ["XWings=None", "PhaseFromX=0", "PhaseToX=720"]);
  assert.equal(mutations().length, 0);
  con.refuse.add("PhaseFromX=0");
  const bad = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: null, phase: { from: 0, to: 720 } } });
  assert.equal(bad.isError, true);
  assert.equal(bad.result.outcome, "partial");
  assert.match(bad.result.steps.find((s: { name: string }) => s.name === "set_PhaseFromX").error, /silently keeps the previous value/);
  assert.equal(bad.result.steps.find((s: { name: string }) => s.name === "set_PhaseToX").status, "skipped");
  const missing = await h.callJson("gma3_configure_matricks", { matricks: 6, x: { wings: 2 } });
  assert.equal(missing.isError, true);
  assert.match(missing.result.steps[0].error, /does not exist; pass create: true/);
  con.matricks.get(5)!.Lock = "UL";
  const locked = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 4 } });
  assert.equal(locked.isError, true);
  assert.match(locked.result.steps[0].error, /is locked/);
  const nothing = await h.callJson("gma3_configure_matricks", { matricks: 5 });
  assert.match(nothing.result.validationErrors.join(" "), /nothing to configure/);
});

test("reset_unspecified clears an existing object's other settings", async () => {
  con.matricks.set(5, { ...freshMatricks(), XWings: "2", YGroup: "4", AlignRangeX: "Yes", Name: "M5", Lock: "" });
  const { result, isError } = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 2 }, reset_unspecified: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(result.intended.resets.map((r: { property: string }) => r.property).sort(), ["AlignRangeX", "YGroup"]);
  assert.equal(con.matricks.get(5)!.YGroup, "None");
  assert.equal(result.verification.checked, "every MAtricks property of MAtricks 5");
  void MTX_PROPS;
});

// ---------------------------------------------------------------------------
// Review round 1
// ---------------------------------------------------------------------------

test("an oversized range is refused at validation, also in preview, without expanding it", async () => {
  const started = Date.now();
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, arrangement: { type: "row", fixtures: ["9007199254740992 Thru 9007199254740992"] }, preview: true });
  assert.equal(isError, true);
  assert.match(result.validationErrors.join(" "), /fixture id/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(h.fake.requests.length, 0);
});

test("a cell with its own FID is matched by address when it is requested by its dotted path", async () => {
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: "501.3", x: 1, y: 0 }, { fixture: 401, x: 0, y: 0 }], exclusive: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.deepEqual(con.groups.get(905)!.cells.map((c) => c.id), ["501.3", "401"]);
  const read = await h.callJson("gma3_selection_grid", { group: 905 });
  assert.deepEqual(read.result.items[0], { order: 1, fixture: "9001", path: "501.3", name: "fx 501.3", x: 1, y: 0, z: 0 });
});

test("two ids for the same fixture are refused before the selection is touched", async () => {
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: "501.3", x: 0, y: 0 }, { fixture: 9001, x: 1, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  const step = result.steps.find((s: { name: string }) => s.name === "check_fixtures");
  assert.deepEqual(step.detail.aliases, ["501.3 and 9001"]);
  assert.match(step.error, /listed twice under different ids/);
  assert.equal(mutations().length, 0);
});

test("a failed cleanup makes the result partial and an error", async () => {
  con.failClearCall = 3; // clear_selection, recall_clear, cleanup
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, items: [{ fixture: 401, x: 0, y: 0 }], exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.verification.status, "matched");
  assert.equal(result.steps.find((s: { name: string }) => s.name === "cleanup_clear_selection").status, "failed");
  assert.ok(result.warnings.some((w: string) => /fixtures may still be selected/.test(w)));
  assert.equal(con.selection.length, 1);
});

test("creating a MAtricks clears a speed-master override copied from the selection", async () => {
  con.selMtx.SpeedMasterOverride = "Position Speed";
  con.selMtx.SpeedFromX = "60";
  const { result, isError } = await h.callJson("gma3_configure_matricks", { matricks: 905, create: true, y: { wings: 2 } });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(con.matricks.get(905)!.SpeedMasterOverride, "");
  assert.equal(con.matricks.get(905)!.SpeedFromX, "None", "the copied speed is reset after the override, not re-filled by it");
  assert.equal(result.steps.filter((s: { op?: string }) => s.op === "set")[0].name, "set_SpeedMasterOverride", "the override is written first");
  assert.deepEqual(result.intended.afterStore.resets.filter((r: { property: string }) => r.property === "SpeedMasterOverride"), [{ property: "SpeedMasterOverride", from: "Position Speed", to: "0" }]);
  const read = await h.callJson("gma3_matricks", { matricks: 905 });
  assert.equal(read.result.otherSettings, undefined);
  con.matricks.get(905)!.SpeedMasterOverride = "Beat";
  const again = await h.callJson("gma3_matricks", { matricks: 905 });
  assert.deepEqual(again.result.otherSettings, { SpeedMasterOverride: "Beat" });
});

test("a reset property that cannot be read is written, and one that stays unreadable is not verified as its default", async () => {
  con.matricks.set(5, { ...freshMatricks(), Name: "M5", Lock: "" });
  delete con.matricks.get(5)!.SpeedMasterOverride;
  const written = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 2 }, reset_unspecified: true });
  assert.equal(written.isError, false, JSON.stringify(written.result));
  assert.deepEqual(written.result.intended.resets.map((r: { property: string }) => r.property), ["SpeedMasterOverride", ...["X", "Y", "Z"].flatMap((a) => [`SpeedFrom${a}`, `SpeedTo${a}`])], "the override first, then every speed it may refill");
  assert.equal(written.result.verification.status, "matched", JSON.stringify(written.result.verification));
  assert.equal(con.matricks.get(5)!.SpeedFromX, "None");
  con.hidden.add("SpeedMasterOverride");
  con.matricks.get(5)!.XWings = "None";
  const { result, isError } = await h.callJson("gma3_configure_matricks", { matricks: 5, x: { wings: 2 }, reset_unspecified: true });
  assert.equal(isError, true, JSON.stringify(result));
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /SpeedMasterOverride: expected "", read null/);
});

test("SU-19: store_group preview expands {cells_of, order: dmx} through the console's type data", async () => {
  // Fixture 501's three cells sit along the string in DMX order 3, 1, 2.
  h.fake.on("patch.cellLayout", () => ({ type: { no: 7, name: "Strip" }, mode: { no: 1, name: "3 cell" }, cells: [{ index: 1 }, { index: 2 }, { index: 3 }] }));
  h.fake.on("patch.typeStructure", () => ({ modes: [{ cellList: [{ index: 1, breakOffsets: "1:4" }, { index: 2, breakOffsets: "1:7" }, { index: 3, breakOffsets: "1:1" }] }] }));
  const { result, isError } = await h.callJson("gma3_store_group", { group: 906, arrangement: { type: "row", fixtures: [{ cells_of: 501, order: "dmx" }, 401] }, preview: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.deepEqual(cells(result.plan.items), ["501.3@0/0/0", "501.1@1/0/0", "501.2@2/0/0", "401@3/0/0"]);
  assert.deepEqual(result.cellLists, [{ cells_of: 501, order: "dmx", ids: "501.3, 501.1-501.2" }]);
  assert.equal(mutations().length, 0);
  // A fixture without cells: refused before anything is sent.
  h.fake.on("patch.cellLayout", () => ({ type: { no: 1, name: "Par" }, mode: { no: 1, name: "x" }, cells: [] }));
  const none = await h.callJson("gma3_store_group", { group: 906, arrangement: { type: "row", fixtures: [{ cells_of: 401 }] }, preview: true });
  assert.equal(none.isError, true);
  assert.match(none.result.validationErrors.join(" "), /cells_of: Fixture 401 has no cells/);
});

test("SU-19 review 1: the cell order is read inside the store's lock span (single and batch)", async () => {
  h.fake.on("patch.cellLayout", () => ({ type: { no: 7, name: "Strip" }, mode: { no: 1, name: "3 cell" }, cells: [{ index: 1 }, { index: 2 }, { index: 3 }] }));
  h.fake.on("patch.typeStructure", () => ({ modes: [{ cellList: [{ index: 1, breakOffsets: "1:4" }, { index: 2, breakOffsets: "1:7" }, { index: 3, breakOffsets: "1:1" }] }] }));
  const reads = () => h.fake.requests.filter((r) => r.op === "patch.cellLayout").length;
  for (const args of [
    { group: 907, arrangement: { type: "row", fixtures: [{ cells_of: 501 }] }, exclusive: true },
    { groups: [{ group: 908, arrangement: { type: "row", fixtures: [{ cells_of: 501 }] } }], exclusive: true },
  ]) {
    const before = reads();
    let release!: () => void;
    // An earlier mutation (a retype, a layout) holds the lock.
    const earlier = h.ctx.mutations.run(() => new Promise<void>((r) => (release = r)));
    const store = h.callJson("gma3_store_group", args as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(reads(), before, `the cell order is not read while another mutation holds the lock (${JSON.stringify(args).slice(0, 40)})`);
    release();
    await earlier;
    await store;
    assert.ok(reads() > before, "read once the lock is free");
  }
});

// ---------------------------------------------------------------------------
// #102: a name another group or MAtricks has
// ---------------------------------------------------------------------------

const holdGroup = (n: number, name: string) => con.groups.set(n, { name, lock: "", preserve: "Yes", cells: [{ id: "701", x: 0, y: 0, z: 0 }] });
const stepOf = (result: any, name: string) => result.steps.find((s: any) => s.name === name);
const one = [{ fixture: 401, x: 0, y: 0 }];

test("#102 store_group: a name another group has is refused before anything is sent, naming the holder (also in preview, case-insensitively)", async () => {
  holdGroup(5, "Front");
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, name: "Front", items: one, exclusive: true });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.match(stepOf(result, "check_name").error, /the name "Front" is taken: "Front" is Group 5\. .*ambiguous.*not verified for groups.*on_name_taken: "allow_suffix"; nothing was sent/);
  assert.deepEqual(stepOf(result, "check_name").detail, { taken: true, holder: 5, holderName: "Front" });
  assert.match(result.summary, /"Front" is Group 5/);
  assert.equal(mutations().length, 0, "nothing is sent");
  assert.equal(con.groups.has(905), false);
  assert.deepEqual(con.listed, ["DataPool.Groups"]);
  const lower = await h.callJson("gma3_store_group", { group: 905, name: "front", items: one, preview: true });
  assert.match(stepOf(lower.result, "check_name").error, /"Front" is Group 5 \(names are compared case-insensitively\)/);
  assert.equal(mutations().length, 0);
  // Unnamed stores do not read the pool.
  const unnamed = await h.callJson("gma3_store_group", { group: 906, items: one, exclusive: true });
  assert.equal(unnamed.result.verification.status, "matched", JSON.stringify(unnamed.result));
  assert.equal(con.listed.length, 2);
});

test("#102 store_group: overwriting a group under its own name is no collision, and the pool is not read", async () => {
  holdGroup(5, "Front");
  const { result, isError } = await h.callJson("gma3_store_group", { group: 5, name: "Front", items: one, overwrite: true, exclusive: true });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(stepOf(result, "check_name").detail, { unchanged: true });
  assert.deepEqual(con.listed, []);
  assert.equal(con.groups.get(5)!.name, "Front");
  // Renaming it to a free name reads the pool and goes ahead.
  const renamed = await h.callJson("gma3_store_group", { group: 5, name: "Back", items: one, overwrite: true, exclusive: true });
  assert.equal(renamed.result.verification.status, "matched", JSON.stringify(renamed.result));
  assert.equal(con.groups.get(5)!.name, "Back");
});

test("#102 store_group: on_name_taken allow_suffix stores; a \"#2\" or an unchanged duplicate read-back is expected, with warnings", async () => {
  holdGroup(5, "Front");
  const { result, isError } = await h.callJson("gma3_store_group", { group: 905, name: "Front", items: one, exclusive: true, on_name_taken: "allow_suffix" });
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
  assert.equal(con.groups.get(905)!.name, "Front#2");
  assert.equal(result.resulting.name, "Front#2");
  assert.ok(result.warnings.some((w: string) => /"Front" is Group 5.*allow_suffix/.test(w)), JSON.stringify(result.warnings));
  assert.ok(result.warnings.some((w: string) => /stored the name as "Front#2"/.test(w)), JSON.stringify(result.warnings));
  // A console that keeps the duplicate as asked (not verified either way for groups).
  con.duplicateName = "keep";
  const kept = await h.callJson("gma3_store_group", { group: 906, name: "Front", items: one, exclusive: true, on_name_taken: "allow_suffix" });
  assert.equal(kept.result.verification.status, "matched", JSON.stringify(kept.result));
  assert.equal(con.groups.get(906)!.name, "Front");
});

test("#102 store_group: an unreadable pool listing refuses a named store; with allow_suffix it is a warning", async () => {
  con.failChildren = true;
  const refused = await h.callJson("gma3_store_group", { group: 905, name: "Front", items: one, exclusive: true });
  assert.equal(refused.isError, true);
  assert.match(stepOf(refused.result, "check_name").error, /the names of the group pool could not be read \(timeout\).*nothing was sent/);
  assert.equal(mutations().length, 0);
  const allowed = await h.callJson("gma3_store_group", { group: 905, name: "Front", items: one, exclusive: true, on_name_taken: "allow_suffix" });
  assert.equal(allowed.result.verification.status, "matched", JSON.stringify(allowed.result));
  assert.ok(allowed.result.warnings.some((w: string) => /could not be read.*allow_suffix/.test(w)));
});

test("#102 store_group batch: a taken name fails only its group, a name an earlier group took is taken, the pool is read once", async () => {
  holdGroup(5, "Front");
  const { result } = await h.callJson("gma3_store_group", {
    exclusive: true,
    groups: [
      { group: 901, name: "Front", items: one },
      { group: 902, name: "Wash", items: one },
      { group: 903, name: "wash", items: [{ fixture: 402, x: 0, y: 0 }] },
      { group: 904, name: "Back", items: one },
    ],
  });
  assert.deepEqual(result.items.map((i: any) => `${i.target}:${i.outcome}`), ["Group 901:failed", "Group 902:succeeded", "Group 903:failed", "Group 904:succeeded"], JSON.stringify(result.items));
  assert.match(result.items[0].summary, /"Front" is Group 5/);
  assert.match(result.items[2].summary, /"Wash" is Group 902 \(stored earlier in this call\)/);
  assert.equal(commands().some((c) => /^Store Group 90[13] /.test(c)), false, "no store for the refused groups");
  assert.deepEqual([901, 902, 903, 904].map((n) => con.groups.get(n)?.name ?? null), [null, "Wash", null, "Back"]);
  assert.deepEqual(con.listed, ["DataPool.Groups"], "the pool's names are read once for the call");
  // With allow_suffix every group is stored and the console suffixes the taken names.
  con.groups.clear();
  holdGroup(5, "Front");
  con.listed = [];
  const allowed = await h.callJson("gma3_store_group", { exclusive: true, on_name_taken: "allow_suffix", groups: [{ group: 901, name: "Front", items: one }, { group: 902, name: "Wash", items: one }, { group: 903, name: "Wash", items: one }] });
  assert.deepEqual(allowed.result.items.map((i: any) => `${i.target}:${i.outcome}:${i.verification}`), ["Group 901:succeeded:matched", "Group 902:succeeded:matched", "Group 903:succeeded:matched"], JSON.stringify(allowed.result.items));
  assert.deepEqual([901, 902, 903].map((n) => con.groups.get(n)!.name), ["Front#2", "Wash", "Wash#2"]);
});

test("#102 store_group batch (verify off): a rejected rename keeps the holder's real name, an unnamed create's default name is taken", async () => {
  holdGroup(5, "Front");
  con.rejectNameFor.add(5);
  const { result } = await h.callJson("gma3_store_group", {
    exclusive: true,
    verify: false,
    groups: [
      { group: 5, name: "Blue", overwrite: true, items: one },
      { group: 901, name: "Front", items: one },
      { group: 902, name: "Blue", items: one },
      { group: 903, items: one },
      { group: 904, name: "Group 903", items: one },
    ],
  });
  assert.deepEqual(result.items.map((i: any) => `${i.target}:${i.outcome}`), ["Group 5:partial", "Group 901:failed", "Group 902:succeeded", "Group 903:succeeded", "Group 904:failed"], JSON.stringify(result.items));
  assert.match(result.items[1].summary, /"Front" is Group 5/, "the rename did not take: Front is still held");
  assert.match(result.items[4].summary, /"Group 903" is Group 903/, "the unnamed group's default name was read again");
  assert.equal(commands().some((c) => /^Store Group 90[14] /.test(c)), false);
  assert.deepEqual([5, 901, 902, 903].map((n) => con.groups.get(n)?.name ?? null), ["Front", null, "Blue", "Group 903"]);
  assert.deepEqual(con.listed, ["DataPool.Groups", "DataPool.Groups", "DataPool.Groups"], "the failed rename and the unnamed create each made the next item read the pool again");
});

test("#102 configure_matricks: a name another MAtricks has is refused before anything is sent; its own name, allow_suffix and an unreadable listing", async () => {
  con.matricks.set(5, { ...freshMatricks(), Name: "Centre out", Lock: "" });
  con.matricks.set(6, { ...freshMatricks(), Name: "M6", Lock: "" });
  const taken = await h.callJson("gma3_configure_matricks", { matricks: 905, name: "Centre out", create: true, x: { wings: 2 } });
  assert.equal(taken.isError, true);
  assert.match(stepOf(taken.result, "check_name").error, /the name "Centre out" is taken: "Centre out" is MAtricks 5\. .*not verified for MAtricks.*nothing was sent/);
  assert.equal(mutations().length, 0);
  assert.equal(con.matricks.has(905), false);
  const rename = await h.callJson("gma3_configure_matricks", { matricks: 6, name: "centre out", preview: true });
  assert.match(stepOf(rename.result, "check_name").error, /\(names are compared case-insensitively\)/, "preview reports it too");
  assert.equal(mutations().length, 0);
  // Its own name: nothing to rename, the pool is not read.
  con.listed = [];
  const own = await h.callJson("gma3_configure_matricks", { matricks: 5, name: "Centre out", x: { wings: 2 } });
  assert.equal(own.result.verification.status, "matched", JSON.stringify(own.result));
  assert.deepEqual(con.listed, []);
  // allow_suffix: written anyway, the "#2" read-back is expected.
  const allowed = await h.callJson("gma3_configure_matricks", { matricks: 6, name: "Centre out", on_name_taken: "allow_suffix" });
  assert.equal(allowed.isError, false, JSON.stringify(allowed.result));
  assert.equal(allowed.result.verification.status, "matched", JSON.stringify(allowed.result.verification));
  assert.equal(con.matricks.get(6)!.Name, "Centre out#2");
  assert.ok(allowed.result.warnings.some((w: string) => /stored the name as "Centre out#2"/.test(w)), JSON.stringify(allowed.result.warnings));
  // An unreadable listing refuses.
  con.failChildren = true;
  h.fake.requests.length = 0;
  const unread = await h.callJson("gma3_configure_matricks", { matricks: 6, name: "Fan" });
  assert.match(stepOf(unread.result, "check_name").error, /the names of the MAtricks pool could not be read.*nothing was sent/);
  assert.equal(mutations().length, 0);
});

test("#102 review of #115: a listing with enumerationError or a name in fieldErrors is unreadable: refused, or a warning with allow_suffix", async () => {
  holdGroup(5, "Front");
  for (const fault of ["enumeration", "field"] as const) {
    con.listingFault = fault;
    h.fake.requests.length = 0;
    const refused = await h.callJson("gma3_store_group", { group: 905, name: "Front", items: one, exclusive: true });
    assert.equal(refused.isError, true, fault);
    assert.match(stepOf(refused.result, "check_name").error, fault === "enumeration" ? /the names of the group pool could not be read \(DataPool\.Groups could not be listed: Children failed\).*nothing was sent/ : /could not be read \(a group of DataPool\.Groups \(addr\.5\) has no readable name: Get failed\).*nothing was sent/, fault);
    assert.equal(mutations().length, 0, fault);
    assert.equal(con.groups.has(905), false, fault);
    const allowed = await h.callJson("gma3_store_group", { group: 906, name: "Back", items: one, exclusive: true, on_name_taken: "allow_suffix" });
    assert.equal(allowed.result.verification.status, "matched", JSON.stringify(allowed.result));
    assert.ok(allowed.result.warnings.some((w: string) => /could not be read.*allow_suffix/.test(w)), fault);
    con.groups.delete(906);
  }
});
