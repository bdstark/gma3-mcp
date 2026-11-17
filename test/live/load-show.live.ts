/**
 * Live console test for gma3_load_show: load a scratch copy and bring the bridge back (GMA3_LIVE_LOAD_RESTART: osc,
 * the default, or keystroke on a Mac running onPC), refuse a load over unsaved changes (before LoadShow is sent), load the starting show again.
 *
 * Runs only with GMA3_LIVE=1, GMA3_LIVE_EXCLUSIVE=1 and GMA3_LIVE_LOAD=1 against a disposable show (see README.md in
 * this folder). Not part of `npm test`. Needs:
 *   - bridge 0.54.0 imported into the starting show, so into both scratch copies saved from it;
 *   - a way to restart the bridge after every load, which unloads it: on a Mac running onPC, Accessibility permission
 *     for the process running the test (keystrokes); elsewhere OSC input with Receive Command on in that show
 *     (gma3_osc shows it, gma3_configure_osc sets it) on the line this test sends to (GMA3_OSC_HOST / _PORT / _PREFIX);
 *   - exclusive use of the console: the current show is replaced three times.
 *
 * Show files written: the starting show (saved under its own name first, so its file holds the console's state and
 * nothing unsaved is lost), mcp-load-live-a.show and mcp-load-live-b.show (GMA3_LIVE_LOAD_SCRATCH_A / _B; must not
 * exist; left in the shows folder: nothing deletes show files). Macro 931 (must be empty) is stored in scratch A to
 * mark it changed; that change is discarded by the final load.
 */
import assert from "node:assert/strict";
import { MutationLock } from "../../src/mutations.ts";
import { OscSender } from "../../src/osc.ts";
import { KeystrokeSender } from "../../src/keystroke.ts";
import { registerShowTools } from "../../src/tools/show.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, bridge, cmd } from "./live.ts";

const env = process.env;
const enabled = env.GMA3_LIVE_EXCLUSIVE === "1" && env.GMA3_LIVE_LOAD === "1";
const A = env.GMA3_LIVE_LOAD_SCRATCH_A ?? "mcp-load-live-a";
const B = env.GMA3_LIVE_LOAD_SCRATCH_B ?? "mcp-load-live-b";
const MACRO = "Macro 931";
const osc = new OscSender({ host: env.GMA3_OSC_HOST ?? "127.0.0.1", port: Number(env.GMA3_OSC_PORT ?? 8000), prefix: env.GMA3_OSC_PREFIX?.replace(/^\/+|\/+$/g, "") || undefined });
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false, oscCommand: osc, keystroke: new KeystrokeSender() };
const tools = captureTools(registerShowTools, ctx);
async function call(name: string, args: Record<string, unknown>) {
  const res = await tools.get(name)!.call(args);
  const text = res.content.map((c) => c.text).join("\n");
  return { result: JSON.parse(text) as any, isError: Boolean(res.isError), text };
}
const current = async () => (await call("gma3_show_files", {})).result.current as string;
const total = async (ref: string) => ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;
const RESTART = process.env.GMA3_LIVE_LOAD_RESTART === "keystroke" ? "keystroke" : "osc";
const load = (name: string, extra: Record<string, unknown> = {}) => call("gma3_load_show", { name, exclusive: true, timeout_ms: 90000, restart: RESTART, ...extra });

liveTest("gma3_load_show: load a scratch copy (bridge restarted), refuse over unsaved changes, load the starting show back", async (t) => {
  if (!enabled) {
    t.skip("set GMA3_LIVE_EXCLUSIVE=1 and GMA3_LIVE_LOAD=1: the test writes show files and replaces the console's show");
    return;
  }
  const files = await call("gma3_show_files", {});
  assert.equal(files.isError, false, files.text);
  const start = files.result.current as string;
  for (const s of [A, B]) assert.ok(!files.result.files.some((f: { name: string }) => f.name.toLowerCase() === s), `${s}.show must not exist`);
  assert.equal(await total(MACRO), 0, `${MACRO} must be empty`);
  t.diagnostic(`starting on ${start}; restart ${RESTART}${RESTART === "osc" ? ` (${osc.description})` : ""}`);

  // The starting show's file gets the console's state, then two scratch copies; the console ends this block on B.
  for (const name of [undefined, A, B]) {
    const r = await call("gma3_save_show", { ...(name ? { name } : {}), exclusive: true });
    assert.equal(r.result.verification.status, "matched", r.text);
  }

  try {
    await t.test("load a scratch copy: the bridge comes back in the loaded show", async () => {
      const r = await load(A);
      t.diagnostic(r.result.summary ?? r.text.slice(0, 300));
      assert.equal(r.result.verification.status, "matched", r.text);
      assert.equal(r.result.previous, B);
      assert.equal(r.result.current, A);
      assert.match(r.result.restart.via, /^(keystroke|osc)/);
      assert.ok(r.result.restart.sends >= 1, r.text);
      assert.equal(r.result.unsavedAnswer, undefined);
      assert.equal(await current(), A);
    });

    await t.test("unsaved changes + unsaved: refuse: refused before LoadShow (the ping's saveNeeded), the show unchanged", async () => {
      await cmd(`Store ${MACRO} "McpLiveLoad"`);
      assert.ok((await total(MACRO)) > 0, `${MACRO} was stored`);
      // Bridge 0.54.0 reports show.saveNeeded, so the tool refuses before sending LoadShow; no question comes and no
      // Cancel is pressed. (The dialog path, for a bridge without saveNeeded, is covered offline in test/load-show.test.ts.)
      const r = await load(B);
      t.diagnostic(r.result.summary ?? r.text.slice(0, 300));
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /has unsaved changes \(NeedShowSave\); pass unsaved: save or discard/);
      assert.equal(r.result.steps.find((s: { name: string }) => s.name === "load"), undefined, "LoadShow was not sent");
      assert.equal(r.result.steps.find((s: { name: string }) => s.name === "unsaved_changes"), undefined, "no question was answered");
      assert.equal(await current(), A);
      assert.ok((await total(MACRO)) > 0, `${MACRO} is still there`);
    });
  } finally {
    // Back to the starting show from its file (saved above); only scratch changes are discarded. Skipped when the
    // console never left it (a save above failed), so nothing of the operator's is dropped.
    const now = await current();
    if (now !== start) {
      const back = await load(start, { unsaved: "discard" });
      t.diagnostic(`load back: ${back.result.summary ?? back.text.slice(0, 300)}`);
      assert.equal(back.result.verification.status, "matched", back.text);
      assert.equal(back.result.current, start);
      assert.equal(await total(MACRO), 0, `${MACRO} is not in ${start}`);
    }
  }
});
