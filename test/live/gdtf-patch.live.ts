/**
 * Live console test: a user-library GDTF whose file name spells spaces as underscores is imported with
 * gma3_patch_import and a fixture of it is patched right after with gma3_patch_add (bridge 0.38.1).
 *
 * Both failed before (live 2026-10-21, Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf): the import's new type
 * "Sentinel Spot Q60 ILS" by "Chauvet DJ" was not claimed for the file's "Sentinel_Spot_Q60_ILS" by "Chauvet_DJ",
 * and the first patch session after the import failed its isolation check on the type's ORIGINALFILENAME (set live,
 * empty in the copy). Each left the patch copy open with the command line inside the edit patch.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder), AND with
 * GMA3_LIVE_EXCLUSIVE=1: patch changes are committed with no undo. Not part of `npm test`.
 *
 * Show objects used:
 *   - The user-library file GMA3_LIVE_GDTF_PATCH (required; its name must contain an underscore, and no show type
 *     may match it). Imported, then removed by GUID; its attributes stay in the show.
 *   - Fixture FID 995, named "MCP live gdtf", the file's first mode, patched in the first free block from 3.001.
 *   - The cleanup is armed only after the guard passed; it removes only FID 995 with that name and only the type
 *     this run imported (by GUID).
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const FID = 995;
const MARK = "MCP live gdtf";
const FILE = process.env.GMA3_LIVE_GDTF_PATCH;
const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = captureTools(registerPatchTools, ctx);

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
  assert.equal(r.result.verification.status, "matched", what);
  return r.result;
};

const cleanup = { armed: false, guid: undefined as string | undefined };

after(async () => {
  if (!liveEnabled || !exclusive || !cleanup.armed) return;
  try {
    const l = await call("gma3_patch_list", { fromFid: FID, toFid: FID });
    const f = (l.result.fixtures ?? [])[0];
    if (f && typeof f.name === "string" && f.name.startsWith(MARK)) await call("gma3_patch_remove", { fids: [FID], exclusive: true });
    if (cleanup.guid) {
      const t = await call("gma3_patch_types", {});
      const no = t.result.types.find((x: any) => x.guid === cleanup.guid)?.no;
      if (no !== undefined) await call("gma3_patch_remove_type", { type: no, exclusive: true });
    }
  } catch {
    // best effort; the test itself reports what failed
  }
});

liveTest("a GDTF named with underscores imports and a fixture of it patches right away (bridge 0.38.1)", async (t) => {
  if (!exclusive) return t.skip("set GMA3_LIVE_EXCLUSIVE=1: patch changes are committed with no undo");
  if (!FILE) return t.skip("set GMA3_LIVE_GDTF_PATCH to a user-library .gdtf whose name has an underscore");
  assert.match(FILE, /_/, "GMA3_LIVE_GDTF_PATCH must contain an underscore");

  const lib = await call("gma3_patch_library", { query: FILE.replace(/\.gdtf$/i, "").split("@").join(" "), sources: ["user"] });
  const entry = (lib.result.entries ?? []).find((e: any) => e.file === FILE);
  assert.ok(entry, `${FILE} is not in the user library: ${lib.text}`);
  assert.deepEqual(entry.inShow, [], `the show already has a type matching ${FILE}; remove it first`);
  const free = await call("gma3_patch_list", { fromFid: FID, toFid: FID });
  assert.equal((free.result.fixtures ?? []).length, 0, `FID ${FID} is taken`);
  cleanup.armed = true;

  const imp = ok(await call("gma3_patch_import", { file: FILE, source: "user", exclusive: true }), "import");
  cleanup.guid = imp.type?.guid;
  assert.ok(cleanup.guid, `the import names its type's GUID: ${JSON.stringify(imp)}`);
  assert.equal(imp.copyLeftOpen, false);

  const again = await call("gma3_patch_library", { query: FILE.replace(/\.gdtf$/i, "").split("@").join(" "), sources: ["user"] });
  const after = (again.result.entries ?? []).find((e: any) => e.file === FILE);
  assert.equal(after?.inShow?.length, 1, `inShow finds the imported type: ${again.text}`);

  const add = ok(await call("gma3_patch_add", { type: imp.type.no, mode: 1, fid: FID, name: MARK, findFreeFrom: "3.001", exclusive: true }), "patch_add right after the import");
  assert.equal(add.copyLeftOpen, false);
});
