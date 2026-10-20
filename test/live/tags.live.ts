/**
 * Live console test for SU-21: tags (gma3_tags, gma3_store_tag, gma3_delete_tag, gma3_assign_tag,
 * gma3_configure_tag), the decoded TAGS in the object reads, playback on a tag read back per sequence, and the kill
 * types with a protected reference.
 *
 * Runs only with GMA3_LIVE=1 against a disposable show (see README.md in this folder). Not part of `npm test`.
 * Needs bridge 0.36.0.
 *
 * Show objects used (each must be absent; everything is deleted at the end):
 *   - Tags 950-952.
 *   - Sequences 950-952 (one empty cue each; started and stopped, also with Forward Commands off; Sequence 952 Cue 1
 *     gets a 2 s in-fade), Group 950
 *     (empty), Macro 950 with one empty line.
 *   - DataPool 2 with its Sequence 950 (DataPool 2 must not exist; created and deleted).
 *   - Appearance 1, when it exists, is assigned to Tag 952 and cleared again (the appearance is not changed).
 */
import assert from "node:assert/strict";
import { after } from "node:test";
import { MutationLock } from "../../src/mutations.ts";
import { registerTagTools, tagPlayback } from "../../src/tools/tags.ts";
import type { ToolContext } from "../../src/tools/context.ts";
import { captureTools } from "../helpers/tool-harness.ts";
import { liveTest, liveEnabled, bridge, cmd } from "./live.ts";

const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 20000, luaToolAllowed: false };
const tools = captureTools(registerTagTools, ctx);
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
const total = async (ref: string) => {
  try {
    return ((await bridge.request("objects", { ref })) as { total?: number }).total ?? 0;
  } catch {
    return 0;
  }
};
const active = async (n: number) => ((await bridge.request("object", { ref: `Sequence ${n}`, properties: false })) as { hasActivePlayback?: boolean }).hasActivePlayback === true;
const states = async () => Promise.all(SEQS.map(active));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEQS = [950, 951, 952];
const objectsOf = (r: any) => (r.result.objects as Array<{ object: string }>).map((o) => o.object).sort();

let started = false;
let poolCreated = false;
after(async () => {
  if (!liveEnabled || !started) return;
  try {
    await cmd("Off Sequence 950 Thru 952");
    for (const c of ["Delete Tag 950 Thru 952 /NoConfirmation", "Delete Sequence 950 Thru 952 /NoConfirmation", "Delete Group 950 /NoConfirmation", "Delete Macro 950 /NoConfirmation"]) await cmd(c);
    if (poolCreated) await cmd("Delete DataPool 2 /NoConfirmation");
  } catch {
    // best effort
  }
});

liveTest("SU-21 tags: create, assign (range, cue, second data pool), protect, reverse lookup, configure, tag playback, kill types, unassign, delete", async (t) => {
  const pre = (await call("gma3_tags", { from: 950, to: 952, references: false })).result;
  assert.equal(pre.total, 0, "Tags 950-952 must be free");
  for (const ref of ["Sequence 950 Thru 952", "Group 950", "Macro 950", "DataPool 2"]) assert.equal(await total(ref), 0, `${ref} must not exist`);
  started = true;

  for (const n of SEQS) assert.equal(await cmd(`Store Sequence ${n} Cue 1 /NoConfirmation`), "OK");
  assert.equal(await cmd("Store Group 950 /NoConfirmation"), "OK");
  assert.equal(await cmd("Store Macro 950 /NoConfirmation"), "OK");
  assert.equal(await cmd("Store Macro 950.1 /NoConfirmation"), "OK");
  assert.equal(await cmd("Store DataPool 2 /NoConfirmation"), "OK");
  poolCreated = true;
  assert.equal(await cmd("Store DataPool 2 Sequence 950 Cue 1 /NoConfirmation"), "OK");

  // Create in a batch; a comma is refused before anything is sent.
  const comma = await call("gma3_store_tag", { tag: 952, name: "Mcp,Tag:C" });
  assert.equal(comma.isError, true);
  assert.match(comma.text, /removes from names/);
  const store = await call("gma3_store_tag", { tags: [{ tag: 950, name: "McpTag A" }, { tag: 951, name: "McpTag B" }, { tag: 952, name: "McpTag:C" }] });
  assert.equal(store.isError, false, store.text.slice(0, 2000));

  // An occupied number is refused; rename labels it.
  const occupied = await call("gma3_store_tag", { tag: 950, name: "Other" });
  assert.equal(occupied.isError, true);
  assert.match(occupied.text, /exists/);
  const rename = await call("gma3_store_tag", { tag: 950, name: "McpTag A2", if_exists: "rename" });
  assert.equal(rename.isError, false, rename.text.slice(0, 1500));
  assert.equal(rename.result.name, "McpTag A2");

  // An unknown tag is refused (the console would answer OK and change nothing); a name another tag has is refused
  // (the console would store it as "McpTag A2#2").
  const unknown = await call("gma3_assign_tag", { tag: "McpNoSuchTag", target: "Sequence 950" });
  assert.match(unknown.text, /no tag is named/);
  const dup = await call("gma3_store_tag", { tag: 951, name: "McpTag A2", if_exists: "rename" });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /already named/);

  // Assign by name over a range.
  const range = await call("gma3_assign_tag", { tag: "McpTag:C", target: "Sequence 950 Thru 952" });
  assert.equal(range.isError, false, range.text.slice(0, 2000));
  assert.deepEqual(objectsOf(range), ["Sequence 950", "Sequence 951", "Sequence 952"]);
  assert.equal(range.result.changedCount, 3);

  // A group with protect, a macro line and a cue (its Part 0) in one batch.
  const batch = await call("gma3_assign_tag", { tag: 951, assignments: [{ target: "Group 950", protect: true }, { target: "Macro 950.1" }, { target: "Sequence 950 Cue 1" }], detail: true });
  assert.equal(batch.isError, false, batch.text.slice(0, 2500));
  assert.equal(batch.result.items[2].result.objects[0].object, "Sequence 950 Cue 1 Part 0");
  assert.equal(batch.result.items[0].result.objects[0].protect, true);

  // The second data pool: only its Sequence 950 is tagged.
  const pool2 = await call("gma3_assign_tag", { tag: 951, target: "Sequence 950", data_pool: 2 });
  assert.equal(pool2.isError, false, pool2.text.slice(0, 2000));
  assert.equal(pool2.result.objects[0].dataPool, "Pool 2");
  const seq950 = (await call("gma3_tags", { of: "Sequence 950" })).result.objects[0];
  assert.deepEqual(seq950.tags.map((e: { tag: number }) => e.tag), [952], "Sequence 950 of the current data pool keeps only Tag 952");

  // The reverse lookup: every sequence tagged McpTag:C, and every object carrying Tag 951 with pool and protect.
  const bySeq = (await call("gma3_tags", { tags: ["McpTag:C"], class: "Sequence" })).result;
  assert.deepEqual(bySeq.tags[0].objects.map((o: { object: string }) => o.object).sort(), ["Sequence 950", "Sequence 951", "Sequence 952"]);
  const b = (await call("gma3_tags", { tags: [951] })).result.tags[0];
  t.diagnostic(`Tag 951: ${JSON.stringify(b)}`);
  assert.equal(b.references, 4);
  assert.deepEqual(b.objects.map((o: { object: string; dataPool: string }) => `${o.dataPool}: ${o.object}`).sort(), ["Default: Group 950", "Default: Macro 950.1", "Default: Sequence 950 Cue 1 Part 0", "Pool 2: Sequence 950"]);
  assert.equal(b.objects.find((o: { object: string }) => o.object === "Group 950").protect, true);
  const paged = (await call("gma3_tags", { tags: [951], references_limit: 3 })).result.tags[0];
  assert.equal(paged.objects.length, 3);
  assert.equal(paged.objectsIncomplete, true);

  // Object reads return TAGS decoded.
  const obj = (await bridge.request("objects", { ref: "Sequence 950", fields: ["Tags"] })) as { items: Array<{ fields: { Tags: Array<{ tag: number; name: string; protect: boolean }> } }> };
  assert.deepEqual(obj.items[0].fields.Tags.map((e) => e.tag), [952]);
  assert.equal(obj.items[0].fields.Tags[0].name, "McpTag:C");

  // Go+ / Off on the tag, read back per sequence (Forward Commands on, type None).
  const go = await ctx.mutations.run(() => tagPlayback(ctx, "Go+", 'Tag "McpTag:C"'));
  t.diagnostic(`Go+ Tag: ${JSON.stringify(go.playbackState)}`);
  assert.deepEqual((go.playbackState as any).sequences.map((s: { active: boolean }) => s.active), [true, true, true]);
  const offTag = await ctx.mutations.run(() => tagPlayback(ctx, "Off", "Tag 952"));
  assert.deepEqual((offTag.playbackState as any).sequences.map((s: { active: boolean }) => s.active), [false, false, false]);

  // Forward Commands off: Go+ Tag reaches no tagged sequence, and the result says so; on again, it reaches all.
  assert.equal((await call("gma3_configure_tag", { tag: 952, forward_commands: false })).isError, false);
  const goOff = await ctx.mutations.run(() => tagPlayback(ctx, "Go+", "Tag 952"));
  t.diagnostic(`Go+ Tag with Forward Commands off: ${JSON.stringify(goOff)}`);
  assert.deepEqual((goOff.playbackState as any).sequences.map((s: { active: boolean }) => s.active), [false, false, false]);
  assert.match(String(goOff.warnings), /Forward Commands is off/);
  assert.equal((await call("gma3_configure_tag", { tag: 952, forward_commands: true })).isError, false);
  const goOn = await ctx.mutations.run(() => tagPlayback(ctx, "Go+", "Tag 952"));
  assert.deepEqual((goOn.playbackState as any).sequences.map((s: { active: boolean }) => s.active), [true, true, true]);
  await ctx.mutations.run(() => tagPlayback(ctx, "Off", "Tag 952"));

  // Settings: refused before sending when outside the enum, applied and read back otherwise.
  const bad = await call("gma3_configure_tag", { tag: 952, type: "KillDelayed" });
  assert.equal(bad.isError, true);
  const app = (await total("Appearance 1")) > 0 ? 1 : undefined;
  const conf = await call("gma3_configure_tag", { tag: 952, forward_commands: false, action: "Toggle", note: "mcp live encore", ...(app ? { appearance: app } : {}) });
  assert.equal(conf.isError, false, conf.text.slice(0, 2000));
  const back = await call("gma3_configure_tag", { tag: 952, forward_commands: true, action: "Pool Default", note: "", ...(app ? { appearance: null } : {}) });
  assert.equal(back.isError, false, back.text.slice(0, 2000));

  // Kill Instant: starting one tagged sequence turns the others off at once; a protected reference keeps running.
  assert.equal((await call("gma3_configure_tag", { tag: 952, type: "Kill Instant" })).isError, false);
  const prot = await call("gma3_assign_tag", { tag: 952, target: "Sequence 951", protect: true });
  assert.equal(prot.isError, false, prot.text.slice(0, 1500));
  await cmd("Go+ Sequence 950");
  await sleep(200);
  await cmd("Go+ Sequence 951");
  await sleep(300);
  assert.deepEqual(await states(), [false, true, false], "starting 951 turned 950 off");
  await cmd("Go+ Sequence 952");
  await sleep(300);
  assert.deepEqual(await states(), [false, true, true], "starting 952 left the protected 951 running");
  await cmd("Off Sequence 950 Thru 952");
  await sleep(200);
  const afterKill = (await call("gma3_tags", { of: "Sequence 950 Thru 952" })).result;
  t.diagnostic(`TAGS after a kill: ${JSON.stringify(afterKill.objects.map((o: any) => o.tags))}`);

  // Kill Delayed: the others go off after the started cue's in-fade (2 s on Sequence 952 Cue 1).
  const unprot = await call("gma3_assign_tag", { tag: 952, target: "Sequence 951", protect: false });
  assert.equal(unprot.isError, false, unprot.text.slice(0, 1500));
  assert.equal(unprot.result.objects[0].protect, false);
  assert.equal((await call("gma3_configure_tag", { tag: 952, type: "Kill Delayed" })).isError, false);
  await bridge.request("set", { ref: "Sequence 952 Cue 1 Part 0", property: "CueInFade", value: "2" });
  await cmd("Go+ Sequence 951");
  await sleep(300);
  const t0 = Date.now();
  await cmd("Go+ Sequence 952");
  await sleep(700 - (Date.now() - t0));
  assert.deepEqual(await states(), [false, true, true], "Kill Delayed: 951 still runs during 952's fade");
  await sleep(3000 - (Date.now() - t0));
  assert.deepEqual(await states(), [false, false, true], "Kill Delayed: 951 is off after 952's fade");
  await cmd("Off Sequence 950 Thru 952");
  assert.equal((await call("gma3_configure_tag", { tag: 952, type: "None" })).isError, false);

  // Unassign from one object.
  const off = await call("gma3_assign_tag", { tag: 952, target: "Sequence 951", off: true });
  assert.equal(off.isError, false, off.text.slice(0, 1500));
  assert.equal(off.result.objects[0].carries, false);

  // Delete: the objects each tag was removed from, re-read.
  const del = await call("gma3_delete_tag", { tags: [{ tag: 952 }, { tag: "McpTag B" }, { tag: 950 }], detail: true });
  assert.equal(del.isError, false, del.text.slice(0, 2500));
  const removed = (i: number) => del.result.items[i].result.removedFrom.map((o: { object: string; dataPool: string }) => `${o.dataPool}: ${o.object}`).sort();
  assert.deepEqual(removed(0), ["Default: Sequence 950", "Default: Sequence 952"]);
  assert.deepEqual(removed(1), ["Default: Group 950", "Default: Macro 950.1", "Default: Sequence 950 Cue 1 Part 0", "Pool 2: Sequence 950"]);
  assert.deepEqual(removed(2), []);
  assert.ok(del.result.items.every((it: any) => it.result.removedFrom.every((o: { stillCarries: boolean }) => o.stillCarries === false)));
  const left = (await call("gma3_tags", { tags: [950, 951, 952] })).result;
  assert.deepEqual(left.missing, [950, 951, 952]);
});
