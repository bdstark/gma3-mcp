import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError, type Gma3Bridge } from "../src/bridge.ts";
import { MutationLock } from "../src/mutations.ts";
import { UndoGroups, inToolScope } from "../src/undo.ts";
import { pickGroups, undoTool } from "../src/tools/undo.ts";
import type { ToolContext } from "../src/tools/context.ts";

const quiet = { log: () => {} };

/**
 * A bridge with undo groups as bridge 0.56.0 has them: undo.close answers an id for a group with commands; undo.undo
 * answers from `undoReply` (a function of the request) or throws what it returns.
 */
function fakeBridge(opts: { closeId?: boolean; commands?: number; undoReply?: (args: Record<string, unknown>) => unknown } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let seq = 0;
  const bridge = {
    calls,
    request: async (op: string, args: Record<string, unknown>) => {
      calls.push([op, args]);
      if (op === "undo.open") return { open: true };
      if (op === "undo.close") {
        const commands = opts.commands ?? 1;
        seq++;
        return { closed: true, commands, ...(opts.closeId !== false && commands > 0 ? { id: `i:${seq}` } : {}) };
      }
      if (op === "undo.undo") {
        const r = opts.undoReply ? opts.undoReply(args) : { undone: (args.ids as string[]).map((id) => ({ id, gone: true, feedback: "OK" })) };
        if (r instanceof Error) throw r;
        return r;
      }
      return {};
    },
  };
  return bridge;
}

function setup(opts: Parameters<typeof fakeBridge>[0] & { enabled?: boolean; env?: Record<string, string> } = {}) {
  const bridge = fakeBridge(opts);
  const undo = new UndoGroups(bridge, { enabled: opts.enabled ?? true, env: opts.env ?? {}, ...quiet });
  const mutations = new MutationLock(undo);
  const ctx = { bridge: bridge as unknown as Gma3Bridge, mutations, undo, requestTimeoutMs: 1000, luaToolAllowed: false } as ToolContext;
  const call = (tool: string) => inToolScope(tool, () => mutations.run(async () => "done"));
  return { bridge, undo, ctx, call };
}

test("history: closed groups are recorded with their id; excluded calls and id-less groups are markers; empty groups and gma3_undo are not recorded", async () => {
  const s = setup();
  await s.call("gma3_store_macro");
  await s.call("gma3_patch_add");
  await inToolScope("gma3_undo", () => s.ctx.mutations.run(async () => 1));
  assert.deepEqual(
    s.undo.history.map((e) => (e.kind === "group" ? `${e.tool}=${e.id}` : `${e.tool}:ungrouped`)),
    ["gma3_store_macro=i:1", "gma3_patch_add:ungrouped"],
  );
  assert.ok(!s.bridge.calls.some(([op, a]) => op === "undo.open" && a.name === "gma3_undo"), "gma3_undo opens no group");
  const empty = setup({ commands: 0 });
  await empty.call("gma3_select");
  assert.deepEqual(empty.undo.history, [], "an empty group is no Oops step");
  const old = setup({ closeId: false });
  await old.call("gma3_store_macro");
  assert.equal(old.undo.history[0].kind, "ungrouped", "a 0.55.0 bridge closes without an id: not undoable by id");
});

test("pickGroups: newest first; an ungrouped call after them blocks; too few is refused", () => {
  const g = (id: string, tool = "t") => ({ kind: "group" as const, id, tool, commands: 1, closedAt: "" });
  const u = (tool: string) => ({ kind: "ungrouped" as const, tool, reason: "excluded", at: "" });
  assert.deepEqual((pickGroups([g("a"), g("b")], 2) as { groups: Array<{ id: string }> }).groups.map((x) => x.id), ["b", "a"]);
  assert.match((pickGroups([g("a"), u("gma3_patch_add")], 1) as { error: string }).error, /gma3_patch_add has no undo group/);
  assert.match((pickGroups([u("gma3_load_show"), g("a")], 2) as { error: string }).error, /gma3_load_show after 1 grouped call/);
  assert.match((pickGroups([g("a")], 2) as { error: string }).error, /only 1 grouped tool call/);
  assert.match((pickGroups([], 1) as { error: string }).error, /no tool call of this server/);
});

test("refused before anything is sent: groups off, bad count, nothing to undo, an ungrouped call since", async () => {
  const off = setup({ enabled: false });
  let r = await undoTool(off.ctx, {});
  assert.equal(r.outcome, "failed");
  assert.match(r.summary, /GMA3_UNDO_GROUPS=1/);
  const s = setup();
  r = await undoTool(s.ctx, { count: 0 });
  assert.match(r.summary, /count must be/);
  r = await undoTool(s.ctx, {});
  assert.match(r.summary, /no tool call of this server/);
  await s.call("gma3_store_macro");
  await s.call("gma3_save_show");
  r = await undoTool(s.ctx, {});
  assert.match(r.summary, /gma3_save_show has no undo group/);
  assert.ok(!s.bridge.calls.some(([op]) => op === "undo.undo"), "nothing was sent");
});

test("preview checks through the bridge and sends no Oops; the history is kept", async () => {
  const s = setup({ undoReply: (a) => ({ preview: a.preview === true, groups: [] }) });
  await s.call("gma3_store_macro");
  await s.call("gma3_store_group");
  const r = await undoTool(s.ctx, { count: 2, preview: true });
  assert.equal(r.outcome, "succeeded");
  assert.match(r.summary, /preview: 2 group\(s\).*gma3_store_group, gma3_store_macro/);
  const sent = s.bridge.calls.find(([op]) => op === "undo.undo")![1];
  assert.deepEqual(sent, { ids: ["i:2", "i:1"], preview: true });
  assert.equal(s.undo.history.length, 2);
});

test("undo: one Oops per group, read back gone, then forgotten; gma3_undo itself is not grouped", async () => {
  const s = setup();
  await s.call("gma3_store_macro");
  await s.call("gma3_store_group");
  const before = s.bridge.calls.length;
  const r = await inToolScope("gma3_undo", () => undoTool(s.ctx, { count: 2 }));
  assert.equal(r.outcome, "succeeded");
  assert.equal(r.verification.status, "matched");
  assert.deepEqual(r.steps.map((x) => x.status), ["succeeded", "succeeded"]);
  assert.match(r.summary, /undid 2 tool call\(s\): gma3_store_group, gma3_store_macro/);
  assert.deepEqual(s.undo.history, []);
  assert.deepEqual(s.bridge.calls.slice(before).map(([op]) => op), ["undo.undo"], "no undo.open/close around gma3_undo");
});

test("a console step since (not-latest) refuses with nothing changed; the group stays undoable later", async () => {
  const s = setup({
    undoReply: () => new BridgeError('[not-latest] the console\'s latest undo step is "Fixture 1", not this server\'s group i:1', "undo.undo", false, "not-latest", { expected: "i:1" }),
  });
  await s.call("gma3_store_macro");
  const r = await undoTool(s.ctx, {});
  assert.equal(r.outcome, "failed");
  assert.equal(r.steps[0].kind, "read");
  assert.match(r.summary, /Fixture 1/);
  assert.equal(s.undo.history.length, 1);
});

test("a group the console no longer has is forgotten; an older bridge says what to update", async () => {
  const gone = setup({ undoReply: () => new BridgeError("[group-gone] undo group i:1 is no longer on the console", "undo.undo", false, "group-gone", { id: "i:1" }) });
  await gone.call("gma3_store_macro");
  let r = await undoTool(gone.ctx, {});
  assert.equal(r.outcome, "failed");
  assert.deepEqual(gone.undo.history, []);
  const old = setup({ undoReply: () => new BridgeError("unknown op 'undo.undo'", "undo.undo", false) });
  await old.call("gma3_store_macro");
  r = await undoTool(old.ctx, {});
  assert.match(r.summary, /needs bridge 0\.56\.0/);
});

test("an Oops that does not take: partial when an earlier group was undone, mismatched read-back", async () => {
  const s = setup({
    undoReply: (a) => {
      const ids = a.ids as string[];
      return new BridgeError("[oops-failed] Oops for undo group i:1 ran, but the group is still the latest undo step", "undo.undo", false, "oops-failed", {
        undone: [{ id: ids[0], gone: true, feedback: "OK" }, { id: ids[1], gone: false, feedback: "OK" }],
      });
    },
  });
  await s.call("gma3_store_macro");
  await s.call("gma3_store_group");
  const r = await undoTool(s.ctx, { count: 2 });
  assert.equal(r.outcome, "partial");
  assert.equal(r.verification.status, "mismatched");
  assert.deepEqual(r.steps.map((x) => x.status), ["succeeded", "failed"]);
  assert.deepEqual(s.undo.history.map((e) => (e.kind === "group" ? e.id : "")), ["i:1"], "the group still on the console stays remembered");
});

test("an Oops whose read-back is unreadable is unknown, not undone: the group stays remembered (review of #154)", async () => {
  const s = setup({
    undoReply: (a) => {
      const ids = a.ids as string[];
      return new BridgeError("[readback-unreadable] Oops for undo group ran, but the read-back failed", "undo.undo", false, "readback-unreadable", {
        undone: [{ id: ids[0], gone: false, unreadable: true, feedback: "OK", error: "cannot be identified" }],
      });
    },
  });
  await s.call("gma3_store_macro");
  await s.call("gma3_store_group");
  const r = await undoTool(s.ctx, { count: 2 });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.verification.status, "unavailable");
  assert.deepEqual(r.steps.map((x) => x.status), ["unknown"]);
  assert.equal(s.undo.history.length, 2, "nothing is forgotten");
});

test("busy (input ownership) is a refusal before any Oops: failed, nothing forgotten (review of #154)", async () => {
  const s = setup({ undoReply: () => new BridgeError("[busy] an Oops is refused while input ownership is active", "undo.undo", false, "busy", { owner: "conn-9" }) });
  await s.call("gma3_store_macro");
  const r = await undoTool(s.ctx, {});
  assert.equal(r.outcome, "failed");
  assert.equal(r.steps[0].kind, "read");
  assert.match(r.summary, /input ownership/);
  assert.equal(s.undo.history.length, 1);
});
