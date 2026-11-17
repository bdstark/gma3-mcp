import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError } from "../src/bridge.ts";
import { MutationLock, HeldLock } from "../src/mutations.ts";
import { UndoGroups, inToolScope, undoGroupsEnabled } from "../src/undo.ts";

/** A bridge that records undo requests; `fail` makes an op throw. */
function fakeBridge(fail: Record<string, Error> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    request: async (op: string, args: Record<string, unknown>) => {
      calls.push([op, args]);
      if (fail[op]) throw fail[op];
      return { ok: true };
    },
  };
}
const quiet = { log: () => {} };

test("undoGroupsEnabled: only an explicit on value turns grouping on", () => {
  for (const v of [undefined, "", "0", "off", "false", "no", "maybe"]) assert.equal(undoGroupsEnabled(v), false, String(v));
  for (const v of ["1", "on", "true", "yes", " ON "]) assert.equal(undoGroupsEnabled(v), true, v);
});

test("off by default: nothing is sent", async () => {
  const b = fakeBridge();
  const lock = new MutationLock(new UndoGroups(b, { env: {}, ...quiet }));
  await inToolScope("gma3_store_macro", () => lock.run(async () => "x"));
  assert.deepEqual(b.calls, []);
});

test("on: one group per outermost span, named after the tool; nested spans add none; a failed mutation still closes it", async () => {
  const b = fakeBridge();
  const lock = new MutationLock(new UndoGroups(b, { enabled: true, ...quiet }));
  const r = await inToolScope("gma3_store_macro", () => lock.run(async () => new HeldLock().run(async () => 7)));
  assert.equal(r, 7);
  assert.deepEqual(b.calls, [["undo.open", { name: "gma3_store_macro" }], ["undo.close", {}]]);
  b.calls.length = 0;
  await assert.rejects(inToolScope("gma3_command", () => lock.run(async () => { throw new Error("boom"); })), /boom/);
  assert.deepEqual(b.calls.map((c) => c[0]), ["undo.open", "undo.close"]);
});

test("on: excluded tools (show load/save, patch tools, GMA3_UNDO_EXCLUDE) and spans outside a tool call get no group", async () => {
  const b = fakeBridge();
  const lock = new MutationLock(new UndoGroups(b, { enabled: true, env: { GMA3_UNDO_EXCLUDE: "gma3_build_phaser" }, ...quiet }));
  for (const tool of ["gma3_load_show", "gma3_save_show", "gma3_patch_add", "gma3_patch_set", "gma3_build_phaser"]) await inToolScope(tool, () => lock.run(async () => 1));
  await lock.run(async () => 1);
  assert.deepEqual(b.calls, []);
});

test("on: an older bridge (unknown op) switches grouping off; other failures never fail the mutation", async () => {
  const old = fakeBridge({ "undo.open": new BridgeError("unknown op 'undo.open'", "undo.open", false) });
  const logs: string[] = [];
  const g = new UndoGroups(old, { enabled: true, log: (m) => logs.push(m) });
  const lock = new MutationLock(g);
  assert.equal(await inToolScope("gma3_command", () => lock.run(async () => "a")), "a");
  assert.equal(g.unsupported, true);
  await inToolScope("gma3_command", () => lock.run(async () => "b"));
  assert.equal(old.calls.length, 1, "not asked again");
  assert.match(logs[0], /needs bridge 0\.55\.0/);
  // A lost reply may have opened the group: it is closed; a refused close is logged, not thrown.
  const lost = fakeBridge({ "undo.open": new BridgeError("timeout", "undo.open", true), "undo.close": new Error("no group") });
  const lock2 = new MutationLock(new UndoGroups(lost, { enabled: true, ...quiet }));
  assert.equal(await inToolScope("gma3_command", () => lock2.run(async () => "c")), "c");
  assert.deepEqual(lost.calls.map((c) => c[0]), ["undo.open", "undo.close"]);
});
