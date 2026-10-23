/**
 * Live console test for gma3_patch_move, gma3_dialog and the dialog report of gma3_run_macro (bridge 0.39.0).
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder), AND with GMA3_LIVE_EXCLUSIVE=1:
 * patch changes are committed with no undo. Not part of `npm test`.
 *
 * Show objects used (all must be free; the cleanup removes only what this run created, by FID and name):
 *   - Fixture FID 996 "MCP live move parent", a grouping fixture (type Grouping), placed at x = 1 m.
 *   - Fixtures FID 997, 998 "MCP live move", of the first single-break type with a footprint, patched in the first free
 *     block from 3.001; 997 placed at (2, 3, 4) m.
 *   - Group 996 holding 997 and 998.
 *   - Macro 960 "MCP live dialog": one line, Lua "Confirm(...)", the way the MA Show Start's Position Wizard starts.
 *
 * Procedure (what a reviewer should see at the console): the three fixtures appear; 997 and 998 move under 996 (the
 * Move Fixtures dialog appears for a moment and is answered Absolute), then back to the top level (answered Relative);
 * macro 960 opens "MCP live dialog: press Cancel", which the test cancels; then everything is removed again.
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import { registerPatchMoveTools } from "../../src/tools/patchmove.ts";
import { registerPositionTools } from "../../src/tools/positions.ts";
import { registerGroupTools } from "../../src/tools/groups.ts";
import { registerMacroTools } from "../../src/tools/macros.ts";
import { registerDialogTools } from "../../src/tools/dialog.ts";
import type { ToolContext, RegisterTools } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge, cmd } from "./live.ts";

const PARENT = 996;
const FIDS = [997, 998];
const GROUP = 996;
const MACRO = 960;
const MARK = "MCP live move";
const PROMPT = "MCP live dialog: press Cancel";
const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = new Map<string, ReturnType<typeof captureTools> extends Map<string, infer T> ? T : never>();
for (const r of [registerPatchTools, registerPatchMoveTools, registerPositionTools, registerGroupTools, registerMacroTools, registerDialogTools] as RegisterTools[]) for (const [k, v] of captureTools(r, ctx)) tools.set(k, v);

async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  return { result, isError: Boolean(res.isError), text };
}
const ok = (r: { result: any; isError: boolean; text: string }, what: string) => {
  assert.equal(r.isError, false, `${what}: ${r.text}`);
  assert.equal(r.result.outcome, "succeeded", what);
  assert.equal(r.result.verification.status, "matched", `${what}: ${JSON.stringify(r.result.verification)}`);
  return r.result;
};
async function listed(): Promise<Array<{ fid: number; name: string; parentFid?: number; patch?: string }>> {
  const l = await call("gma3_patch_list", { fromFid: PARENT, toFid: FIDS[FIDS.length - 1] });
  return l.result.fixtures ?? [];
}

const cleanup = { armed: false, group: false, macro: false };
after(async () => {
  if (!liveEnabled || !exclusive || !cleanup.armed) return;
  try {
    const d = (await bridge.request("dialog.read", {})) as { modal: false | { text?: string; buttons: Array<{ text: string }> } };
    if (d.modal && d.modal.text === PROMPT) await bridge.request("dialog.press", { button: "Cancel", expectText: PROMPT, exclusive: true });
    if (cleanup.macro) await cmd(`Delete Macro ${MACRO} /NoConfirmation`);
    if (cleanup.group) await cmd(`Delete Group ${GROUP} /NoConfirmation`);
    const mine = await listed();
    const kids = mine.filter((f) => FIDS.includes(f.fid) && f.name.startsWith(MARK));
    if (kids.some((f) => f.parentFid === PARENT)) await call("gma3_patch_move", { fids: kids.filter((f) => f.parentFid === PARENT).map((f) => f.fid), parent: "root", exclusive: true });
    if (kids.length) await call("gma3_patch_remove", { fids: kids.map((f) => f.fid), exclusive: true });
    if (mine.some((f) => f.fid === PARENT && f.name.startsWith(MARK))) await call("gma3_patch_remove", { fids: [PARENT], exclusive: true });
  } catch {
    // best effort; the test reports what failed
  }
});

liveTest("gma3_patch_move into a grouping fixture (absolute) and back (relative); gma3_dialog answers a macro's Confirm()", async (t) => {
  if (!exclusive) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1 to confirm exclusive console use: patch changes are committed with no undo");
    return;
  }
  assert.deepEqual(await listed(), [], `FIDs ${PARENT}..${FIDS[FIDS.length - 1]} must be free in the disposable show`);
  const g = await call("gma3_selection_grid", { group: GROUP });
  assert.equal(g.result.exists, false, `Group ${GROUP} must be empty`);
  const m = await call("gma3_macros", { macro: MACRO });
  assert.equal(m.result.exists, false, `Macro ${MACRO} must be empty`);
  cleanup.armed = true;

  // Fixtures: a grouping fixture and two dimmers, placed so that absolute and relative differ.
  const types = await call("gma3_patch_types", {});
  const grouping = types.result.types.find((tp: any) => tp.name === "Grouping");
  assert.ok(grouping, "the show has the Grouping fixture type");
  let pick: { type: number; mode: number } | undefined;
  for (const tp of types.result.types) for (const md of tp.modes) if (!pick && tp.name !== "Grouping" && md.breaks === 1 && (md.footprint ?? 0) > 0 && (md.footprint ?? 0) <= 64) pick = { type: tp.no, mode: md.no };
  assert.ok(pick, "the show needs a fixture type with a single-break DMX mode");
  ok(await call("gma3_patch_add", { type: grouping.no, mode: grouping.modes[0].no, fid: PARENT, name: `${MARK} parent`, exclusive: true }), "add grouping fixture");
  ok(await call("gma3_patch_add", { type: pick.type, mode: pick.mode, fid: FIDS[0], count: FIDS.length, name: MARK, findFreeFrom: "3.001", exclusive: true }), "add fixtures");
  ok(await call("gma3_place_fixtures", { unit: "m", placements: [{ fid: PARENT, position: { x: 1, y: 0, z: 0 } }, { fid: FIDS[0], position: { x: 2, y: 3, z: 4 } }], exclusive: true }), "place");
  ok(await call("gma3_store_group", { group: GROUP, name: MARK, items: FIDS.map((f, i) => ({ fixture: f, x: i, y: 0 })), exclusive: true }), "group");
  cleanup.group = true;
  const before = Object.fromEntries((await listed()).map((f) => [f.fid, f]));

  // Into the grouping fixture, keeping the world position.
  const into = ok(await call("gma3_patch_move", { fids: FIDS, parent: PARENT, position: "absolute", exclusive: true }), "move into the grouping fixture");
  assert.equal(into.dialog, "answered", "the console asked Move Fixtures");
  for (const f of into.fixtures) {
    assert.equal(f.parentFid, PARENT);
    assert.equal(f.patch, before[f.fid].patch);
    assert.deepEqual(f.groups, [GROUP]);
  }
  const p0 = into.fixtures.find((f: any) => f.fid === FIDS[0]);
  assert.ok(Math.abs(p0.after.position.x - 1) < 0.001 && Math.abs(p0.world.position.x - 2) < 0.001, `absolute: local x 1 under a parent at x 1, world x 2: ${JSON.stringify(p0)}`);

  // Back to the top level, keeping the offset: the world position becomes the old local one.
  const out = ok(await call("gma3_patch_move", { fids: FIDS, parent: "root", position: "relative", exclusive: true }), "move back to the top level");
  const p1 = out.fixtures.find((f: any) => f.fid === FIDS[0]);
  assert.ok(Math.abs(p1.after.position.x - 1) < 0.001, `relative: the local x stays 1: ${JSON.stringify(p1)}`);
  for (const f of out.fixtures) assert.equal(f.parentFid, null);

  // A macro's Confirm(): gma3_run_macro reports it, gma3_dialog cancels it.
  ok(await call("gma3_store_macro", { macro: MACRO, mode: "create", name: "MCP live dialog", lines: [{ command: `Lua "Confirm(nil, '${PROMPT}', nil, true)"` }] }), "macro");
  cleanup.macro = true;
  const run = await call("gma3_run_macro", { macro: MACRO, action: "go", observe_seconds: 1 });
  assert.equal(run.result.execution.dispatched, true, run.text);
  assert.equal(run.result.execution.dialog?.text, PROMPT, run.text);
  const read = await call("gma3_dialog", { action: "read" });
  assert.equal(read.result.modal.text, PROMPT);
  assert.deepEqual(read.result.modal.buttons.map((b: any) => b.text), ["OK", "Cancel"]);
  const refused = await call("gma3_dialog", { action: "press", button: "OK", expect_text: "Something else", exclusive: true });
  assert.equal(refused.isError, true);
  const press = ok(await call("gma3_dialog", { action: "press", button: "Cancel", expect_title: read.result.modal.title ?? "", expect_text: PROMPT, exclusive: true }), "press Cancel");
  assert.equal(press.state, "closed");
});
