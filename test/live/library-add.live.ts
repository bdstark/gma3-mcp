/**
 * Live console test for SU-22 (gma3_patch_library_add): a GDTF is sent over the bridge into the user library,
 * imported with gma3_patch_import and removed again.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder), AND with
 * GMA3_LIVE_EXCLUSIVE=1 (the import and removal are patch sessions committed with no undo), AND with
 * GMA3_LIVE_GDTF set to a .gdtf file named manufacturer@model[@revision].gdtf. Not part of `npm test`. Needs
 * bridge 0.38.0.
 *
 * Show objects and files used:
 *   - The user library file named like GMA3_LIVE_GDTF (must not exist; written, then deleted from the user library
 *     folder at the end, which the console's machine must be this one for).
 *   - The fixture type it creates (no show type may match it by manufacturer and name; imported, then removed by
 *     GUID; the attributes it brings stay in the show).
 * GMA3_LIVE_RECORD, when set, is a path the results of each step are written to as JSON (for the probe record).
 */
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerPatchTools } from "../../src/tools/patch.ts";
import { registerTypeStructureTools } from "../../src/tools/typestructure.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge } from "./live.ts";

const exclusive = process.env.GMA3_LIVE_EXCLUSIVE === "1";
const GDTF = process.env.GMA3_LIVE_GDTF;
const FILE = GDTF ? basename(GDTF) : "";
const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 15000, luaToolAllowed: false };
const tools = new Map([...captureTools(registerPatchTools, ctx), ...captureTools(registerTypeStructureTools, ctx)]);
const record: Record<string, unknown> = {};

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

const cleanup = { file: undefined as string | undefined, guid: undefined as string | undefined };

after(async () => {
  if (!liveEnabled || !exclusive || !GDTF) return;
  try {
    if (cleanup.guid) {
      const t = await call("gma3_patch_types", {});
      const no = t.result.types.find((x: any) => x.guid === cleanup.guid)?.no;
      if (no !== undefined) record.removeType = (await call("gma3_patch_remove_type", { type: no, exclusive: true })).result;
    }
    if (cleanup.file) {
      await rm(cleanup.file, { force: true });
      record.fileRemoved = cleanup.file;
    }
  } catch (err) {
    record.cleanupError = String(err);
  }
  if (process.env.GMA3_LIVE_RECORD) await writeFile(process.env.GMA3_LIVE_RECORD, JSON.stringify(record, null, 2));
});

liveTest("SU-22: a GDTF sent into the user library, imported and removed", async (t) => {
  if (!exclusive) return t.skip("set GMA3_LIVE_EXCLUSIVE=1: the import is committed with no undo");
  if (!GDTF) return t.skip("set GMA3_LIVE_GDTF to a manufacturer@model[@revision].gdtf file");
  const bytes = await readFile(GDTF);

  const stat0 = (await bridge.request("patch.libraryStat", { file: FILE })) as { exists: boolean; path: string; listedIn: string[] };
  assert.equal(stat0.exists, false, `${FILE} is already in the user library; remove it first`);
  assert.deepEqual(stat0.listedIn, []);

  const add = ok(await call("gma3_patch_library_add", { file_name: FILE, content_base64: bytes.toString("base64") }), "library add");
  cleanup.file = add.path;
  record.add = add;
  assert.equal(add.size, bytes.length);
  assert.equal(add.libraryEntry.source, "user");
  assert.equal(add.libraryEntry.inShow.length, 0, "the show already has a type matching the file");

  const again = await call("gma3_patch_library_add", { file_name: FILE, content_base64: bytes.toString("base64") });
  assert.equal(again.isError, true);
  assert.match(again.result.steps.at(-1).error, /already in the user library .*the same bytes/);
  record.addAgain = again.result.steps.at(-1);

  const lib = await call("gma3_patch_library", { query: FILE.split("@")[0], sources: ["user"] });
  record.library = lib.result;
  assert.ok(lib.result.entries.some((e: any) => e.file === FILE && e.source === "user"));

  const imp = ok(await call("gma3_patch_import", { file: FILE, source: "user", exclusive: true }), "import");
  cleanup.guid = imp.type.guid;
  record.import = imp;
  assert.equal(imp.library.source, "user");
  assert.ok(imp.type.modes.length >= 1);
  for (const m of add.fixtureType.modes) assert.ok(imp.type.modes.some((x: any) => x.name === m), `mode ${m} imported`);

  const structure = await call("gma3_patch_type_structure", { type: imp.type.no, mode: imp.type.modes[0].no });
  assert.equal(structure.isError, false, structure.text);
  record.structure = structure.result;
});
