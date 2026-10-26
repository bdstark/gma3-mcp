import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { FakeBridge } from "./helpers/fake-bridge.ts";
import { mcpIsError, mcpText, startMcpServer } from "./helpers/mcp-server.ts";
import {
  compressRanges,
  firstFreeBlock,
  firstFreeExecutors,
  markTruncated,
  PAGE_SIZE,
  parsePool,
  registerPoolUsageTools,
  versionAtLeast,
} from "../src/tools/poolusage.ts";

/**
 * Issue #96: gma3_pool_usage against a fake bridge whose `children` op pages like the plugin's listChildren
 * (dense children, total = the number of children, limit/offset), and the truncated flag of gma3_objects /
 * gma3_list_children over the real server.
 */

type Kid = { index: number; name: string; class?: string; addr?: string; childCount?: number; fields?: Record<string, unknown>; fieldErrors?: Record<string, string> };

/** A show: listings by reference or address. */
class FakeShow {
  listings = new Map<string, Kid[]>();
  /** Fail the read of a reference at this offset. */
  failAt?: { ref: string; offset: number };
  /** Grow the listing between pages. */
  growAfterFirstPage?: string;
  /** What ping reports as bridgeVersion (an Error: ping fails). */
  bridgeVersion: string | Error = "0.47.0";

  set(ref: string, kids: Kid[]): this {
    this.listings.set(ref, kids);
    return this;
  }

  install(h: Harness): void {
    h.fake.on("ping", () => {
      if (this.bridgeVersion instanceof Error) throw this.bridgeVersion;
      return { bridgeVersion: this.bridgeVersion };
    });
    h.fake.on("children", (args) => {
      const ref = String(args.ref);
      const kids = this.listings.get(ref);
      if (!kids) throw new Error(ref.startsWith("DataPool.") ? `path not found: ${ref}` : `no object found for '${ref}'`);
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 200);
      if (this.failAt && this.failAt.ref === ref && this.failAt.offset === offset) throw new Error("request timed out");
      const fields = Array.isArray(args.fields) ? (args.fields as string[]) : [];
      const items = kids.slice(offset, offset + limit).map((k) => {
        const s: Record<string, unknown> = { name: k.name, class: k.class ?? "Object", addr: k.addr ?? `1.2.${k.index}`, addrNative: `ShowData.${k.name}`, index: k.index, childCount: k.childCount ?? 0 };
        if (fields.length) s.fields = Object.fromEntries(fields.map((f) => [f, k.fields?.[f] ?? null]));
        if (fields.length && k.fieldErrors) s.fieldErrors = Object.fromEntries(Object.entries(k.fieldErrors).filter(([f]) => fields.includes(f)));
        return s;
      });
      const total = kids.length;
      if (this.growAfterFirstPage === ref) kids.push({ index: 99999, name: "late" });
      return { total, offset, count: items.length, items };
    });
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const objs = (nos: number[], prefix: string, cls = "Object") => nos.map((n) => ({ index: n, name: `${prefix} ${n}`, class: cls }));

let h: Harness;
let show: FakeShow;

before(async () => {
  h = await startHarness(registerPoolUsageTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  h.fake.requests.length = 0;
  show = new FakeShow();
  show.install(h);
});

type Usage = { complete: boolean; dataPool?: number; pools: Array<Record<string, any>> };
const usage = async (args: Record<string, unknown>) => {
  const r = await h.callJson<Usage>("gma3_pool_usage", args);
  return { ...r, pool: (label: string) => r.result.pools.find((p) => p.pool === label)! };
};
const childReads = () => h.fake.requests.filter((r) => r.op === "children").map((r) => ({ ref: r.args.ref, offset: r.args.offset, limit: r.args.limit }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("compressRanges: sorted, distinct, single numbers and runs", () => {
  assert.equal(compressRanges([]), "");
  assert.equal(compressRanges([7]), "7");
  assert.equal(compressRanges([5001, 3, 1, 2, 2, 5002, 9, 11, 10]), "1-3, 9-11, 5001-5002");
  assert.equal(compressRanges([...range(1, 11), ...range(5001, 5534)]), "1-11, 5001-5534");
});

test("firstFreeBlock: none free, exact fit, from, the upper bound", () => {
  assert.equal(firstFreeBlock([], 20), "1-20");
  assert.equal(firstFreeBlock(range(1, 20), 20), "21-40");
  // An exact fit between two used blocks.
  assert.equal(firstFreeBlock([...range(1, 10), ...range(16, 30)], 5), "11-15");
  assert.equal(firstFreeBlock([...range(1, 10), ...range(16, 30)], 6), "31-36");
  assert.equal(firstFreeBlock([...range(1, 10), ...range(16, 30)], 1), "11");
  // from skips what is below it and starts inside a gap.
  assert.equal(firstFreeBlock([...range(1, 10), ...range(16, 30)], 3, 12), "12-14");
  assert.equal(firstFreeBlock([...range(1, 10), ...range(16, 30)], 3, 14), "31-33");
  assert.equal(firstFreeBlock(range(1, 9999), 1), null);
  assert.equal(firstFreeBlock([5], 3, 1, 6), "1-3");
  assert.equal(firstFreeBlock([3], 3, 1, 6), "4-6");
  assert.equal(firstFreeBlock([4], 3, 1, 6), "1-3");
  assert.equal(firstFreeBlock([2, 5], 3, 1, 6), null);
});

test("firstFreeExecutors: a block stays inside one row", () => {
  assert.equal(firstFreeExecutors([], 15), "101-115");
  assert.equal(firstFreeExecutors(range(101, 190), 10), "201-210", "191-198 hold only 8");
  assert.equal(firstFreeExecutors(range(101, 190), 8), "191-198");
  assert.equal(firstFreeExecutors([201, 202], 5, 201), "203-207");
  assert.equal(firstFreeExecutors([...range(101, 198), ...range(201, 298), ...range(301, 390), ...range(401, 490)], 1), null);
  assert.equal(firstFreeExecutors([], 91, 301), null, "rows 3 and 4 have 90 executors");
});

test("markTruncated: only when more items follow", () => {
  assert.deepEqual(markTruncated({ total: 3, offset: 0, count: 3, items: [1, 2, 3] }), { total: 3, offset: 0, count: 3, items: [1, 2, 3] });
  const r = markTruncated({ total: 770, offset: 0, count: 500, items: [] }) as Record<string, unknown>;
  assert.equal(r.truncated, true);
  assert.match(String(r.note), /500 of 770 .* offset 500/);
  assert.equal((markTruncated({ total: 770, offset: 500, count: 270, items: [] }) as Record<string, unknown>).truncated, undefined, "the last page");
  assert.equal(markTruncated("text"), "text");
});

test("parsePool refuses ranges and executor numbers", () => {
  assert.equal(parsePool("macros").label, "Macros");
  assert.equal(parsePool("matricks").label, "MAtricks");
  assert.deepEqual(parsePool("Preset 4"), { kind: "preset", label: "Preset 4", ref: "Preset 4", pool: 4 });
  assert.equal(parsePool("presets").kind, "presetPools");
  assert.equal(parsePool("page  2").label, "Page 2");
  for (const bad of ["Page 1.101 Thru 1.115", "Page 1.201", "Page Thru", "Macro 1 Thru 5", "Page 0", "Preset 4.1"]) assert.throws(() => parsePool(bad), /not a pool|number must be/, bad);
});

// ---------------------------------------------------------------------------
// gma3_pool_usage
// ---------------------------------------------------------------------------

test("a pool of more than one page of children is read to its end", async () => {
  const nos = [...range(1, 11), ...range(5001, 5534), ...range(5600, 5824)];
  assert.equal(nos.length, 770);
  show.set("DataPool.Macros", objs(nos, "Macro"));
  const { result, isError, text, pool } = await usage({ pools: ["Macros"], names: true });
  assert.equal(isError, false);
  assert.equal(result.complete, true);
  const m = pool("Macros");
  assert.equal(m.stored, 770);
  assert.equal(m.used, "1-11, 5001-5534, 5600-5824");
  assert.equal(m.names.length, 770);
  assert.deepEqual(m.names[0], [1, "Macro 1"]);
  assert.deepEqual(m.names[769], [5824, "Macro 5824"]);
  assert.deepEqual(childReads(), [
    { ref: "DataPool.Macros", offset: 0, limit: PAGE_SIZE },
    { ref: "DataPool.Macros", offset: 500, limit: PAGE_SIZE },
  ]);
  // Compact: one line per pool, no indentation.
  assert.equal(text.split("\n").length, 3);
  assert.ok(text.includes('[1,"Macro 1"]'));
});

test("a failed page leaves the pool incomplete with the reason and no free block", async () => {
  show.set("DataPool.Macros", objs(range(1, 770), "Macro"));
  show.set("DataPool.Groups", objs(range(1, 5), "Group"));
  show.failAt = { ref: "DataPool.Macros", offset: 500 };
  const { result, isError, pool } = await usage({ pools: ["Macros", "Groups"], free: { size: 10 } });
  assert.equal(isError, false, "one pool was read");
  assert.equal(result.complete, false);
  const m = pool("Macros");
  assert.equal(m.complete, false);
  assert.match(m.reason, /offset 500 failed after 500 objects: request timed out/);
  assert.equal(m.stored, 500);
  assert.equal(m.free, null);
  assert.match(m.freeNote, /incomplete/);
  assert.equal(pool("Groups").complete, true);
  assert.equal(pool("Groups").free, "6-15");
});

test("a single pool that is only partly readable is incomplete, not an error", async () => {
  show.set("DataPool.Macros", objs(range(1, 770), "Macro"));
  show.failAt = { ref: "DataPool.Macros", offset: 500 };
  const { result, isError, pool } = await usage({ pools: ["Macros"], free: { size: 10 } });
  assert.equal(isError, false, "500 macros were read");
  assert.equal(result.complete, false);
  assert.equal(pool("Macros").stored, 500);
  assert.equal(pool("Macros").used, "1-500");
  assert.equal(pool("Macros").free, null);
  // Nothing read at all is still an error.
  show.failAt = { ref: "DataPool.Macros", offset: 0 };
  assert.equal((await usage({ pools: ["Macros"] })).isError, true);
});

test("a pool that changes between pages is incomplete", async () => {
  show.set("DataPool.Sequences", objs(range(1, 600), "Seq"));
  show.growAfterFirstPage = "DataPool.Sequences";
  const { pool } = await usage({ pools: ["Sequences"] });
  assert.equal(pool("Sequences").complete, false);
  assert.match(pool("Sequences").reason, /changed while it was read \(600 objects, then 601\)/);
});

test("an unknown pool fails on its own; a call where nothing could be read is an error", async () => {
  show.set("DataPool.Groups", objs([1, 2], "Group"));
  const one = await usage({ pools: ["Groups", "Bogus"] });
  assert.equal(one.isError, false);
  assert.equal(one.pool("Bogus").complete, false);
  assert.match(one.pool("Bogus").reason, /path not found: DataPool.Bogus/);
  const none = await usage({ pools: ["Bogus"] });
  assert.equal(none.isError, true);
});

test("refusals are made before any read", async () => {
  for (const args of [{ pools: ["Page 1.101 Thru 1.115"] }, { pools: [] }, {}, { pools: Array.from({ length: 31 }, (_, i) => `Preset ${i + 1}`) }]) {
    const r = await h.callJson("gma3_pool_usage", args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(h.fake.requests.length, 0);
});

test("a preset pool counts its stored presets, not its 1000 slots", async () => {
  // The pool itself reads No "4 (1000)" (test/datapool.test.ts): Count() is the slots; children are the presets.
  show.set("DataPool.PresetPools", [
    { index: 1, name: "Dimmer", class: "Presets", addr: "1.9.1", childCount: 1000 },
    { index: 4, name: "Color", class: "Presets", addr: "1.9.4", childCount: 1000 },
    { index: 21, name: "All 1", class: "Presets", addr: "1.9.21", childCount: 1000 },
  ]);
  show.set("Preset 4", objs([...range(1, 12), 20], "Color", "Preset"));
  show.set("Preset 21", objs(range(1, 41), "Phaser", "Preset"));
  show.set("Preset 1", []);
  show.set("1.9.1", show.listings.get("Preset 1")!);
  show.set("1.9.4", show.listings.get("Preset 4")!);
  show.set("1.9.21", show.listings.get("Preset 21")!);
  const { result, pool } = await usage({ preset_pools: [4, 21, 1], pools: ["preset 4", "PresetPools"], free: { size: 5 } });
  assert.equal(result.complete, true);
  assert.equal(result.pools.length, 4, "Preset 4 once");
  assert.equal(pool("Preset 4").stored, 13);
  assert.equal(pool("Preset 4").used, "1-12, 20");
  assert.equal(pool("Preset 4").free, "13-17");
  assert.equal(pool("Preset 21").stored, 41);
  assert.equal(pool("Preset 1").stored, 0);
  assert.equal(pool("Preset 1").used, "");
  assert.equal(pool("Preset 1").free, "1-5");
  const all = pool("PresetPools");
  assert.equal(all.stored, 3);
  assert.equal(all.used, "1, 4, 21");
  assert.deepEqual(all.presetPools, [
    [1, "Dimmer", 0, ""],
    [4, "Color", 13, "1-12, 20"],
    [21, "All 1", 41, "1-41"],
  ]);
  assert.equal(all.free, "5-9");
  assert.ok(!childReads().some((r) => /Thru/.test(String(r.ref))));
});

const exec = (no: number, obj?: { class: string; name: string }): Kid => ({ index: no, name: obj?.name ?? `Exec ${no}`, class: "Exec", fields: { No: no, Object: obj ? { name: obj.name, class: obj.class, addr: `1.7.${no}`, index: 1 } : null } });

test("a page lists its used executors with the assigned object; free stays inside a row", async () => {
  show.set("Page 1", [
    ...range(178, 189).map((n) => exec(n, { class: "Quickey", name: "MCP RESERVED" })),
    ...range(191, 198).map((n) => exec(n, { class: "Sequence", name: `LOS2 ${n}` })),
    ...range(201, 215).map((n) => exec(n, { class: "Sequence", name: `StartShow ${n}` })),
    exec(216),
  ]);
  const { result, pool } = await usage({ pools: ["Page 1"], free: { size: 10 } });
  assert.equal(result.complete, true);
  const p = pool("Page 1");
  assert.equal(p.stored, 35);
  assert.equal(p.used, "178-189, 191-198, 201-215");
  assert.equal(p.unassigned, "216", "an executor without an object is not used");
  assert.deepEqual(p.executors[0], [178, "Quickey", "MCP RESERVED"]);
  assert.deepEqual(p.executors.at(-1), [215, "Sequence", "StartShow 215"]);
  assert.equal(p.free, "101-110");
  assert.deepEqual(childReads(), [{ ref: "Page 1", offset: 0, limit: PAGE_SIZE }]);
  const req = h.fake.requests.find((r) => r.op === "children")!;
  assert.deepEqual(req.args.fields, ["No", "Object", "Width"]);
  assert.equal(req.args.asText, false, "handles keep their class");

  const from = await usage({ pools: ["Page 1"], free: { size: 12, from: 180 } });
  assert.equal(from.pool("Page 1").free, "216-227", "190 is a single gap and row 1 ends at 198; 216 has no object");
});

test("an executor whose assignment reads as an invalid handle is not free and makes the page incomplete", async () => {
  const invalid = (no: number): Kid => ({ index: no, name: `Exec ${no}`, class: "Exec", fields: { No: no, Object: { invalid: true } } });
  show.set("Page 1", [exec(101, { class: "Sequence", name: "A" }), invalid(102), exec(103)]);
  const { result, isError, pool } = await usage({ pools: ["Page 1"], free: { size: 1 } });
  assert.equal(isError, false);
  assert.equal(result.complete, false);
  const p = pool("Page 1");
  assert.equal(p.complete, false);
  assert.match(p.reason, /assignment of executor\(s\) 102 could not be read/);
  assert.equal(p.used, "101");
  assert.equal(p.unreadable, "102");
  assert.equal(p.unassigned, "103");
  assert.equal(p.free, null, "no free block from an incomplete read");
  assert.match(p.freeNote, /incomplete/);

  // Under Pages the same page makes the listing incomplete, still without an error.
  show.set("DataPool.Pages", [{ index: 1, name: "Main", class: "Page", addr: "1.6.1", fields: { No: 1 } }]);
  show.set("1.6.1", show.listings.get("Page 1")!);
  const all = await usage({ pools: ["Pages"], free: { size: 1 } });
  assert.equal(all.isError, false);
  assert.equal(all.pool("Pages").complete, false);
  assert.match(all.pool("Pages").reason, /page 1: the assignment of executor\(s\) 102 could not be read/);
  assert.equal(all.pool("Pages").free, null);
});

test("a wider executor's covered numbers are neither unassigned nor free (KB-21: 180 with Width 2 covers 181)", async () => {
  const wide = (no: number, width: unknown): Kid => ({ ...exec(no, { class: "Sequence", name: `Wide ${no}` }), fields: { No: no, Width: width, Object: { name: `Wide ${no}`, class: "Sequence", addr: `1.7.${no}`, index: 1 } } });
  // 181 is listed as the covered Proxy without an Object; 186-187 (covered by 185) are not listed at all.
  const proxy = (no: number): Kid => ({ index: no, name: `Proxy ${no}`, class: "Proxy", fields: { No: no, Object: null } });
  show.set("Page 1", [wide(180, 2), proxy(181), exec(182), wide(185, 3), wide(197, 4)]);
  const { result, pool } = await usage({ pools: ["Page 1"], free: { size: 1, from: 181 } });
  assert.equal(result.complete, true);
  const p = pool("Page 1");
  assert.equal(p.used, "180, 185, 197");
  assert.equal(p.covered, "181, 186-187, 198", "a span stops at the row's end");
  assert.equal(p.unassigned, "182");
  assert.equal(p.free, "182", "181 belongs to 180");
  assert.equal((await usage({ pools: ["Page 1"], free: { size: 2, from: 181 } })).pool("Page 1").free, "182-183");
  assert.equal((await usage({ pools: ["Page 1"], free: { size: 3, from: 186 } })).pool("Page 1").free, "188-190");

  // An unreadable Width leaves the covered numbers unknown: incomplete, no free block.
  show.set("Page 1", [wide(180, "wide"), exec(182)]);
  const bad = await usage({ pools: ["Page 1"], free: { size: 1, from: 181 } });
  assert.equal(bad.pool("Page 1").complete, false);
  assert.match(bad.pool("Page 1").reason, /Width of executor\(s\) 180 could not be read/);
  assert.equal(bad.pool("Page 1").free, null);
});

test("an executor whose Object read raised (bridge 0.47.0 fieldErrors) is unreadable, not free", async () => {
  const failed: Kid = { index: 102, name: "Exec 102", class: "Exec", fields: { No: 102 }, fieldErrors: { Object: "cannot read Object" } };
  const failedWidth: Kid = { ...exec(104, { class: "Sequence", name: "B" }), fieldErrors: { Width: "cannot read Width" } };
  show.set("Page 1", [exec(101, { class: "Sequence", name: "A" }), failed, exec(103)]);
  const { result, isError, pool } = await usage({ pools: ["Page 1"], free: { size: 1, from: 102 } });
  assert.equal(isError, false);
  assert.equal(result.complete, false);
  const p = pool("Page 1");
  assert.equal(p.unreadable, "102");
  assert.equal(p.unassigned, "103");
  assert.match(p.reason, /assignment of executor\(s\) 102 could not be read/);
  assert.equal(p.free, null, "102 may be occupied");
  // A Width read that raised leaves the numbers it covers unknown.
  show.set("Page 1", [failedWidth]);
  const w = await usage({ pools: ["Page 1"], free: { size: 1 } });
  assert.equal(w.pool("Page 1").complete, false);
  assert.match(w.pool("Page 1").reason, /Width of executor\(s\) 104 could not be read/);
  assert.equal(w.pool("Page 1").free, null);
});

test("with a bridge before 0.47.0 no executor free block is offered, and the reason says why; pool blocks stay", async () => {
  show.set("Page 1", [exec(101, { class: "Sequence", name: "A" })]);
  show.set("DataPool.Groups", objs([1, 2], "Group"));
  show.bridgeVersion = "0.46.0";
  const { result, pool } = await usage({ pools: ["Page 1", "Groups"], free: { size: 2 } });
  assert.equal(result.complete, true, "the reads themselves are complete");
  assert.equal(pool("Page 1").free, null);
  assert.match(pool("Page 1").freeNote, /bridge 0\.46\.0 .*need bridge 0\.47\.0/);
  assert.equal(pool("Page 1").used, "101");
  assert.equal(pool("Groups").free, "3-4");
  assert.equal(h.fake.requests.filter((r) => r.op === "ping").length, 1);

  show.bridgeVersion = new Error("request timed out");
  assert.match((await usage({ pools: ["Page 1"], free: { size: 2 } })).pool("Page 1").freeNote, /version could not be read \(request timed out\)/);
  show.bridgeVersion = "0.47.1";
  assert.equal((await usage({ pools: ["Page 1"], free: { size: 2 } })).pool("Page 1").free, "102-103");
  // Without free, and without a page, no ping is sent.
  h.fake.requests.length = 0;
  await usage({ pools: ["Page 1"] });
  await usage({ pools: ["Groups"], free: { size: 1 } });
  assert.equal(h.fake.requests.filter((r) => r.op === "ping").length, 0);
});

test("versionAtLeast", () => {
  assert.equal(versionAtLeast("0.47.0", "0.47.0"), true);
  assert.equal(versionAtLeast("0.48.0", "0.47.0"), true);
  assert.equal(versionAtLeast("1.0", "0.47.0"), true);
  assert.equal(versionAtLeast("0.46.9", "0.47.0"), false);
  assert.equal(versionAtLeast("0.9.0", "0.47.0"), false);
  assert.equal(versionAtLeast(undefined, "0.47.0"), false);
  assert.equal(versionAtLeast("test", "0.47.0"), false);
});

test("Pages lists every page with its used executor count, read per page by address", async () => {
  show.set("DataPool.Pages", [
    { index: 1, name: "Main", class: "Page", addr: "1.6.1", fields: { No: 1 } },
    { index: 2, name: "Busk", class: "Page", addr: "1.6.2", fields: { No: 2 } },
    { index: 3, name: "Spare", class: "Page", addr: "1.6.3", fields: { No: 3 } },
  ]);
  show.set("1.6.1", range(201, 205).map((n) => exec(n, { class: "Sequence", name: `S${n}` })));
  show.set("1.6.2", [exec(101, { class: "Macro", name: "Blackout" })]);
  show.set("1.6.3", []);
  const { result, pool } = await usage({ pools: ["Pages"], free: { size: 2 } });
  assert.equal(result.complete, true);
  const p = pool("Pages");
  assert.equal(p.stored, 3);
  assert.equal(p.used, "1-3");
  assert.deepEqual(p.pages, [
    [1, "Main", 5, "201-205"],
    [2, "Busk", 1, "101"],
    [3, "Spare", 0, ""],
  ]);
  assert.equal(p.free, "4-5");
  assert.deepEqual(childReads().map((r) => r.ref), ["DataPool.Pages", "1.6.1", "1.6.2", "1.6.3"]);

  // One page that cannot be read makes the whole listing incomplete, naming the page.
  show.failAt = { ref: "1.6.2", offset: 0 };
  const bad = await usage({ pools: ["Pages"], free: { size: 2 } });
  assert.equal(bad.pool("Pages").complete, false);
  assert.match(bad.pool("Pages").reason, /page 2: request timed out/);
  assert.equal(bad.pool("Pages").free, null);
  assert.equal(bad.isError, false, "the other pages were read");
});

test("data_pool reads the pools of that data pool", async () => {
  show.set("DataPool 2", [{ index: 1, name: "Groups", addr: "1.5.2.1" }]);
  show.set("1.5.2.1", objs([1, 2, 3], "Group"));
  show.set("DataPool 2 Preset 4", objs([1], "Red", "Preset"));
  const { result, pool } = await usage({ data_pool: 2, pools: ["groups", "Preset 4"] });
  assert.equal(result.dataPool, 2);
  assert.equal(result.complete, true);
  assert.equal(pool("Groups").used, "1-3");
  assert.equal(pool("Preset 4").stored, 1);
});

// ---------------------------------------------------------------------------
// gma3_objects / gma3_list_children over the real server: the truncated flag and the compact form
// ---------------------------------------------------------------------------

test("gma3_objects and gma3_list_children say truncated when more items follow; compact drops the addresses", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  let client: Client | undefined;
  try {
    client = await startMcpServer({ GMA3_BRIDGE_PORT: String(port), GMA3_BRIDGE_TIMEOUT_MS: "2000", GMA3_OSC_PORT: "1" });
    const all = range(1, 770).map((n) => ({ name: `M${n}`, class: "Macro", addr: `1.3.${n}`, addrNative: `ShowData.Macros.M${n}`, index: n, childCount: 1, fields: { No: n, Name: `M${n}` } }));
    const listing = (args: Record<string, unknown>, def: number) => {
      const offset = Number(args.offset ?? 0);
      const items = all.slice(offset, offset + Number(args.limit ?? def));
      return { total: all.length, offset, count: items.length, items };
    };
    fake.on("objects", (args) => listing(args, 500));
    fake.on("children", (args) => listing(args, 200));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client!.callTool({ name, arguments: args });
      assert.equal(mcpIsError(r), false);
      return mcpText(r);
    };

    const first = JSON.parse(await call("gma3_objects", { ref: "Macro Thru", fields: ["No", "Name"] }));
    assert.equal(first.count, 500);
    assert.equal(first.truncated, true);
    assert.match(first.note, /500 of 770 .* offset 500/);
    const rest = JSON.parse(await call("gma3_objects", { ref: "Macro Thru", offset: 500 }));
    assert.equal(rest.truncated, undefined);
    const kids = JSON.parse(await call("gma3_list_children", { ref: "DataPool.Macros" }));
    assert.equal(kids.truncated, true);
    assert.equal(JSON.parse(await call("gma3_list_children", { ref: "DataPool.Macros", limit: 1000 })).truncated, undefined);

    const compactText = await call("gma3_objects", { ref: "Macro Thru", fields: ["No", "Name"], compact: true, limit: 2 });
    assert.ok(!compactText.includes("\n"), "minified");
    const compact = JSON.parse(compactText);
    assert.equal(compact.truncated, true);
    assert.deepEqual(compact.items[0], { name: "M1", class: "Macro", index: 1, childCount: 1, fields: { No: 1, Name: "M1" } });
    const compactKids = JSON.parse(await call("gma3_list_children", { ref: "DataPool.Macros", fields: ["Name"], compact: true, limit: 1 }));
    assert.equal(compactKids.items[0].addr, undefined);
    // Without fields compact changes nothing: the address is all that identifies an object.
    const plain = JSON.parse(await call("gma3_objects", { ref: "Macro Thru", compact: true, limit: 1 }));
    assert.equal(plain.items[0].addr, "1.3.1");
  } finally {
    await client?.close().catch(() => {});
    await fake.close();
  }
});
