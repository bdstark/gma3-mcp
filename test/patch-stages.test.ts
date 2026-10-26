import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.js";
import { BridgeReplyError, SILENT } from "./helpers/fake-bridge.js";
import { registerPatchStagesTool, findStage, notEmpty, removalClash, type StageRow } from "../src/tools/patchstages.js";

/**
 * gma3_patch_stages (#97) against a fake bridge whose patch.* ops behave like the bridge's (0.48.0): the copy opens
 * and commits on the next patch.state poll, patch.stageEdit changes the copy's stages only, and the Stages fingerprint
 * derives from the stages minus the positions left out (excludeStages) and without the Name and number of the bare
 * ones (bareStages). The bridge ops themselves are covered by test/lua/patch_ops_test.lua.
 */

interface St {
  /** An explicit Name; without one the stage reads "Stage <its position>". */
  name?: string;
  fixtures: number;
  spaces?: number;
  children?: string[];
  /** Fields of the bridge's row to override (fixtures: undefined for an unreadable count; the *Error fields). */
  row?: Partial<StageRow>;
}

class StageWorld {
  live: St[] = [{ fixtures: 5 }];
  copy: St[] | null = null;
  dest = "Root";
  pending: string[] = [];
  /** patch.stageEdit never answers; apply: whether it still changed the copy. */
  editSilent: false | { apply: boolean } = false;
  editError: BridgeReplyError | null = null;
  /** The commit loses the change (the read-back must catch it). */
  commitLoses = false;
  /** A bridge before 0.48.0. */
  oldBridge = false;
  /** Runs on the live stages right after a commit (something else changing them). */
  onCommit: ((live: St[]) => void) | null = null;

  static rows(list: St[]): StageRow[] {
    return list.map((s, i) => {
      const name = s.name ?? `Stage ${i + 1}`;
      return { index: i + 1, no: i + 1, name, nameKind: s.name === undefined || s.name === `Stage ${i + 1}` ? "default" : "explicit", children: s.children ?? ["Spaces", "Fixtures"], fixturesList: true, fixtures: s.fixtures, topLevel: s.fixtures, otherObjects: 0, spacesList: true, spaces: s.spaces ?? 0, ...(s.row ?? {}) };
    });
  }

  frame() {
    for (const cmd of this.pending) {
      if (cmd === "enter") {
        this.copy = this.live.map((s) => ({ ...s }));
        this.dest = this.live[0].name ? `Stage 1 '${this.live[0].name}'.Fixtures` : "Stage 1.Fixtures";
      } else if (cmd === "root") {
        if (this.copy && !this.commitLoses) this.live = this.copy;
        this.onCommit?.(this.live);
        this.copy = null;
        this.dest = "Root";
      }
    }
    this.pending = [];
  }

  apply(args: Record<string, unknown>) {
    const c = this.copy!;
    if (args.action === "create") for (const n of args.names as string[]) c.push({ name: n, fixtures: 0 });
    else if (args.action === "rename") c[(args.index as number) - 1].name = args.name as string;
    else c.splice((args.index as number) - 1, 1);
  }

  fingerprint(list: St[], args: Record<string, unknown>) {
    if (args.collection !== "Stages") return { objects: 2, hash: 7, complete: true };
    const ex = (args.excludeStages as number[] | undefined) ?? [];
    const bare = (args.bareStages as number[] | undefined) ?? [];
    const kept = StageWorld.rows(list)
      .filter((r) => !ex.includes(r.index))
      .map((r) => (bare.includes(r.index) ? { fixtures: r.fixtures } : { no: r.no, name: r.name, fixtures: r.fixtures }));
    return { objects: kept.length, hash: JSON.stringify(kept), complete: true };
  }

  install(f: import("./helpers/fake-bridge.js").FakeBridge) {
    f.on("patch.state", () => {
      this.frame();
      const copyOpen = this.copy !== null;
      return { destination: this.dest, copyOpen, atRoot: this.dest === "Root" && !copyOpen, modal: false, stages: StageWorld.rows(this.live).map((r) => r.name), ...(copyOpen ? { destinationStage: { index: 1, no: 1, name: StageWorld.rows(this.copy!)[0].name, by: "address" } } : {}) };
    });
    f.on("patch.stages", (args) => {
      if (this.oldBridge) throw new Error("unknown op 'patch.stages'");
      const list = args.side === "copy" ? this.copy : this.live;
      if (!list) throw new BridgeReplyError("[copy-closed] the patch copy is not open", "copy-closed");
      const stages = StageWorld.rows(list);
      return { side: args.side ?? "live", count: stages.length, stages };
    });
    f.on("patch.enter", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      if (this.copy) throw new BridgeReplyError("[copy-open] the patch copy is already open", "copy-open");
      this.pending.push("enter");
      const name = StageWorld.rows(this.live)[0].name;
      return { queued: true, stage: name, stageIndex: 1, expectDestination: "Stage 1.Fixtures" };
    });
    f.on("patch.stageEdit", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      if (!this.copy) throw new BridgeReplyError("[copy-closed] the patch copy is not open", "copy-closed");
      if (this.editSilent) {
        if (this.editSilent.apply) this.apply(args);
        return SILENT;
      }
      if (this.editError) throw this.editError;
      this.apply(args);
      return { action: args.action, stages: StageWorld.rows(this.copy) };
    });
    f.on("patch.collections", () => ({ copyOpen: this.copy !== null, live: ["Stages", "FixtureTypes"], copy: this.copy ? ["Stages", "FixtureTypes"] : false }));
    f.on("patch.fingerprint", (args) => this.fingerprint(args.side === "copy" ? (this.copy ?? []) : this.live, args));
    f.on("patch.commit", (args) => {
      if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
      this.pending.push("root");
      return { queued: true };
    });
  }
}

async function setup() {
  const h = await startHarness(registerPatchStagesTool);
  const w = new StageWorld();
  w.install(h.fake);
  return { h, w, ops: () => h.fake.requests.map((r) => r.op) };
}

const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);
const fpArgs = (h: { fake: { requests: Array<{ op: string; args: Record<string, unknown> }> } }, side: string) =>
  h.fake.requests.filter((r) => r.op === "patch.fingerprint" && r.args.side === side && r.args.collection === "Stages").map((r) => ({ excludeStages: r.args.excludeStages, bareStages: r.args.bareStages }));
const names = (w: StageWorld) => StageWorld.rows(w.live).map((r) => r.name);

test("findStage: by position, exact name, the one name matching ignoring case, and refusals", () => {
  const rows = StageWorld.rows([{ name: "Main Floor", fixtures: 1 }, { name: "Basement", fixtures: 0 }]);
  assert.equal((findStage(rows, 2) as StageRow).name, "Basement");
  assert.equal((findStage(rows, "Main Floor") as StageRow).index, 1);
  assert.equal((findStage(rows, "main floor") as StageRow).index, 1);
  assert.match(findStage(rows, 3) as string, /no stage at position 3/);
  assert.match(findStage(rows, "Attic") as string, /no stage named "Attic" \(stages: 1 "Main Floor", 2 "Basement"\)/);
  const twice = StageWorld.rows([{ name: "Deck", fixtures: 0 }, { name: "DECK", fixtures: 0 }]);
  assert.equal((findStage(twice, "DECK") as StageRow).index, 2, "an exact match wins over a case-insensitive one");
  assert.match(findStage(twice, "deck") as string, /more than one stage is named/);
});

test("gma3_patch_stages list: the live stages, read-only, no session", async () => {
  const { h, w, ops } = await setup();
  try {
    w.live = [{ name: "Main Floor", fixtures: 9 }, { fixtures: 0 }];
    const { result, isError } = await h.callJson("gma3_patch_stages", { action: "list" });
    assert.equal(isError, false);
    assert.equal(result.count, 2);
    assert.deepEqual(result.stages.map((s: StageRow) => [s.index, s.name, s.nameKind, s.fixtures]), [[1, "Main Floor", "explicit", 9], [2, "Stage 2", "default", 0]]);
    assert.deepEqual(ops(), ["patch.stages"]);
    assert.deepEqual(h.fake.requests[0].args, {}, "the live patch");
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages create: one session, the appended stages left out of the copy's Stages, committed and read back", async () => {
  const { h, w, ops } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_stages", { action: "create", names: ["Basement", "Outdoors"], exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.verification.status, "matched");
    assert.equal(result.committed, true);
    assert.deepEqual(stepNames(result), ["check_state:succeeded", "check_stages:succeeded", "enter:succeeded", "wait_copy:succeeded", "create_stages:succeeded", "isolation_check:succeeded", "commit:succeeded", "wait_commit:succeeded", "read_back:succeeded"]);
    const edit = h.fake.requests.find((r) => r.op === "patch.stageEdit")!;
    assert.deepEqual(edit.args, { exclusive: true, action: "create", names: ["Basement", "Outdoors"] });
    assert.deepEqual(h.fake.requests.find((r) => r.op === "patch.enter")!.args, { exclusive: true }, "the session enters the first stage, as every patch session does");
    assert.deepEqual(fpArgs(h, "copy"), [{ excludeStages: [2, 3], bareStages: undefined }]);
    assert.deepEqual(fpArgs(h, "live"), [{ excludeStages: undefined, bareStages: undefined }]);
    assert.deepEqual(names(w), ["Stage 1", "Basement", "Outdoors"]);
    assert.deepEqual(result.verification.actual, ["<default name>", "Basement", "Outdoors"]);
    assert.ok(ops().indexOf("patch.commit") > ops().lastIndexOf("patch.fingerprint"));

    // One name: name instead of names, step named in the singular.
    const one = await h.callJson("gma3_patch_stages", { action: "create", name: "Attic", exclusive: true });
    assert.equal(one.result.outcome, "succeeded", one.result.summary);
    assert.ok(stepNames(one.result).includes("create_stage:succeeded"));
    assert.deepEqual(names(w), ["Stage 1", "Basement", "Outdoors", "Attic"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages rename: by position or name (ignoring case); the renamed stage compared bare on both sides", async () => {
  const { h, w } = await setup();
  try {
    let r = await h.callJson("gma3_patch_stages", { action: "rename", stage: 1, name: "Main Floor", exclusive: true });
    assert.equal(r.result.outcome, "succeeded", r.result.summary);
    assert.equal(r.result.verification.status, "matched");
    assert.deepEqual(h.fake.requests.find((x) => x.op === "patch.stageEdit")!.args, { exclusive: true, action: "rename", index: 1, expect: "Stage 1", name: "Main Floor" });
    assert.deepEqual(fpArgs(h, "copy"), [{ excludeStages: undefined, bareStages: [1] }]);
    assert.deepEqual(fpArgs(h, "live"), [{ excludeStages: undefined, bareStages: [1] }]);
    assert.deepEqual(names(w), ["Main Floor"]);
    h.fake.requests.length = 0;
    r = await h.callJson("gma3_patch_stages", { action: "rename", stage: "main floor", name: "MAIN FLOOR", exclusive: true });
    assert.equal(r.result.outcome, "succeeded", "a stage may change the case of its own name");
    assert.deepEqual(names(w), ["MAIN FLOOR"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages remove: an empty stage after the first; the removed one left out of the live side, the ones after it bare", async () => {
  const { h, w } = await setup();
  try {
    w.live = [{ name: "Main Floor", fixtures: 9 }, { name: "Basement", fixtures: 0 }, { fixtures: 0 }, { name: "Outdoors", fixtures: 2 }];
    const { result } = await h.callJson("gma3_patch_stages", { action: "remove", stage: "Basement", exclusive: true });
    assert.equal(result.outcome, "succeeded", result.summary);
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.deepEqual(h.fake.requests.find((x) => x.op === "patch.stageEdit")!.args, { exclusive: true, action: "remove", index: 2, expect: "Basement" });
    assert.deepEqual(fpArgs(h, "live"), [{ excludeStages: [2], bareStages: [3, 4] }]);
    assert.deepEqual(fpArgs(h, "copy"), [{ excludeStages: undefined, bareStages: [2, 3] }]);
    assert.deepEqual(names(w), ["Main Floor", "Stage 2", "Outdoors"], "the unnamed stage moved up and reads its new number");
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages: refusals send no change (pre-checks against the live stages; validation sends nothing at all)", async () => {
  const { h, w, ops } = await setup();
  try {
    w.live = [{ name: "Main Floor", fixtures: 9 }, { name: "Basement", fixtures: 3 }, { name: "Outdoors", fixtures: 0, spaces: 1 }, { name: "Attic", fixtures: 0, children: ["Spaces", "Fixtures", "Mystery"] }];
    const nothing = async (args: Record<string, unknown>, pattern: RegExp) => {
      h.fake.requests.length = 0;
      const { result } = await h.callJson("gma3_patch_stages", args);
      assert.equal(result.outcome, "failed", JSON.stringify(args));
      assert.match([result.summary, ...(result.validationErrors ?? [])].join(" "), pattern, JSON.stringify(args));
      assert.equal(ops().length, 0, `nothing sent for ${JSON.stringify(args)}`);
    };
    await nothing({ action: "create", name: "Basement" }, /exclusive must be true/);
    await nothing({ action: "create", names: ["Deck", "deck"], exclusive: true }, /"deck" is given twice/);
    await nothing({ action: "create", name: "Lvl. 2", exclusive: true }, /grandMA3 removes from names/);
    await nothing({ action: "create", name: 'The "Pit"', exclusive: true }, /grandMA3 removes from names/);
    await nothing({ action: "create", name: "   ", exclusive: true }, /must not be empty/);
    await nothing({ action: "create", exclusive: true }, /create needs name/);
    await nothing({ action: "create", name: "A", names: ["B"], exclusive: true }, /name or names, not both/);
    await nothing({ action: "rename", name: "X", exclusive: true }, /rename needs stage/);
    await nothing({ action: "remove", stage: 0, exclusive: true }, /stage/);
    await nothing({ action: "remove", stage: 2, name: "X", exclusive: true }, /remove takes stage only/);

    const refused = async (args: Record<string, unknown>, pattern: RegExp) => {
      h.fake.requests.length = 0;
      const { result } = await h.callJson("gma3_patch_stages", { exclusive: true, ...args });
      assert.equal(result.outcome, "failed", JSON.stringify(args));
      assert.match(result.summary, /nothing was sent/);
      assert.match(result.summary, pattern, JSON.stringify(args));
      assert.deepEqual(ops(), ["patch.state", "patch.stages"], `only the pre-checks for ${JSON.stringify(args)}`);
    };
    await refused({ action: "create", name: "basement" }, /stage 2 is already named "Basement"/);
    await refused({ action: "rename", stage: 1, name: "OUTDOORS" }, /stage 3 is already named "Outdoors"/);
    await refused({ action: "rename", stage: "Main Floor", name: "Main Floor" }, /already named "Main Floor"; nothing to change/);
    await refused({ action: "rename", stage: "Cellar", name: "X" }, /no stage named "Cellar"/);
    await refused({ action: "remove", stage: 1 }, /first stage/);
    await refused({ action: "remove", stage: "Basement" }, /holds 3 fixture\(s\)/);
    await refused({ action: "remove", stage: "Outdoors" }, /has 1 space\(s\)/);
    await refused({ action: "remove", stage: "Attic" }, /children besides Fixtures and Spaces \(Mystery\)/);
    await refused({ action: "remove", stage: 9 }, /no stage at position 9/);
    w.live = [{ fixtures: 0 }];
    await refused({ action: "remove", stage: 1 }, /one stage; it cannot be removed/);

    // A copy already open (someone in the Patch menu, or an unfinished session): refused by check_state.
    w.copy = [{ fixtures: 0 }];
    w.dest = "Stage 1.Fixtures";
    h.fake.requests.length = 0;
    const { result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Deck", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /nothing was sent.*patch copy is open/);
    assert.deepEqual(ops(), ["patch.state"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages: an edit without a reply is never resent; the copy is closed only when it provably holds no change", async () => {
  const { h, w, ops } = await setup();
  try {
    // The change landed but its reply was lost: the copy differs, so it is left open for the operator.
    w.editSilent = { apply: true };
    let { result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Basement", exclusive: true });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.committed, false);
    assert.equal(result.copyLeftOpen, true);
    assert.match(result.summary, /LEFT OPEN/);
    assert.equal(ops().filter((o) => o === "patch.stageEdit").length, 1, "sent once, never retried");
    assert.ok(!ops().includes("patch.commit"), "nothing committed over a copy that holds a change");
    assert.deepEqual(names(w), ["Stage 1"]);

    // Nothing landed: the copy equals the live patch, so it is closed again.
    w.copy = null;
    w.dest = "Root";
    w.editSilent = { apply: false };
    h.fake.requests.length = 0;
    ({ result } = await h.callJson("gma3_patch_stages", { action: "rename", stage: 1, name: "Main Floor", exclusive: true }));
    assert.equal(result.outcome, "unknown");
    assert.equal(result.copyLeftOpen, false);
    assert.match(result.summary, /closed again without changes/);
    assert.equal(ops().filter((o) => o === "patch.stageEdit").length, 1, "sent once, never retried");
    assert.equal(ops().filter((o) => o === "patch.commit").length, 1, "only the close of the unchanged copy");
    assert.deepEqual(names(w), ["Stage 1"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages: a refused edit closes the unchanged copy; a commit that loses the change reads back mismatched", async () => {
  const { h, w } = await setup();
  try {
    w.editError = new BridgeReplyError("[create-failed] creating stage Basement: Acquire('Stage') raised; the 0 stage(s) this call appended were deleted again", "create-failed", { undone: true });
    let { result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Basement", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.equal(result.committed, false);
    assert.equal(result.copyLeftOpen, false);
    assert.match(result.summary, /create-failed|Acquire/);
    w.editError = null;
    w.commitLoses = true;
    ({ result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Basement", exclusive: true }));
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /1 stage\(s\), expected 2/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages: an older bridge without patch.stages is named, for list and for a change", async () => {
  const { h, w, ops } = await setup();
  try {
    w.oldBridge = true;
    const list = await h.callJson("gma3_patch_stages", { action: "list" });
    assert.equal(list.isError, true);
    assert.match(list.text, /bridge 0\.48\.0/);
    const { result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Basement", exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /nothing was sent.*bridge 0\.48\.0/);
    assert.ok(!ops().includes("patch.enter"));
  } finally {
    await h.close();
  }
});

test("removalClash and notEmpty: the review of #112 (a default name moving up onto an explicit one; unreadable children)", () => {
  const rows = StageWorld.rows([{ name: "Stage 2", fixtures: 1 }, { name: "Basement", fixtures: 0 }, { fixtures: 0 }]);
  assert.match(removalClash(rows, 2)!, /moves stage 3 \("Stage 3", a default name\) up to read "Stage 2", which stage 1 is named/);
  assert.equal(removalClash(StageWorld.rows([{ name: "Main Floor", fixtures: 1 }, { name: "Basement", fixtures: 0 }, { fixtures: 0 }, { fixtures: 0 }]), 2), undefined, "unnamed stages moving up together do not clash");
  assert.equal(removalClash(StageWorld.rows([{ name: "Main Floor", fixtures: 1 }, { name: "Basement", fixtures: 0 }, { name: "Stage 2", fixtures: 0 }]), 2), undefined, "an explicit name that does not move is no clash");
  const empty = StageWorld.rows([{ fixtures: 0 }, { name: "Attic", fixtures: 0 }])[1];
  assert.equal(notEmpty(empty), undefined);
  assert.match(notEmpty({ ...empty, spacesList: undefined, spacesError: "Spaces not readable" })!, /Spaces cannot be read \(Spaces not readable\)/);
  assert.match(notEmpty({ ...empty, spacesList: false })!, /child Spaces that cannot be read as its Spaces list/, "a bridge before 0.49.0 reports a raising Spaces read as no Spaces list");
  assert.match(notEmpty({ ...empty, childrenError: "x", children: [] })!, /children cannot be read/);
  assert.match(notEmpty({ ...empty, fixtures: undefined, fixturesError: "walk failed" })!, /fixtures cannot be read \(walk failed\)/);
});

test("gma3_patch_stages remove: refused before anything is sent when it would leave two stages with one name, or the stage cannot be inspected (review of #112)", async () => {
  const { h, w, ops } = await setup();
  try {
    const refused = async (pattern: RegExp) => {
      h.fake.requests.length = 0;
      const { result } = await h.callJson("gma3_patch_stages", { action: "remove", stage: 2, exclusive: true });
      assert.equal(result.outcome, "failed");
      assert.match(result.summary, /nothing was sent/);
      assert.match(result.summary, pattern);
      assert.deepEqual(ops(), ["patch.state", "patch.stages"]);
    };
    w.live = [{ name: "Stage 2", fixtures: 1 }, { name: "Basement", fixtures: 0 }, { fixtures: 0 }];
    await refused(/up to read "Stage 2", which stage 1 is named; rename one of them first/);
    assert.deepEqual(names(w), ["Stage 2", "Basement", "Stage 3"]);
    w.live = [{ fixtures: 1 }, { name: "Basement", fixtures: 0, row: { spacesList: undefined, spacesError: "Spaces not readable" } }];
    await refused(/Spaces cannot be read/);
    w.live = [{ fixtures: 1 }, { name: "Basement", fixtures: 0, row: { spacesList: false } }];
    await refused(/child Spaces that cannot be read as its Spaces list/);
    w.live = [{ fixtures: 1 }, { name: "Basement", fixtures: 0, row: { children: [], childrenError: "children not readable" } }];
    await refused(/children cannot be read/);
    w.live = [{ fixtures: 1 }, { name: "Basement", fixtures: 0, row: { fixtures: undefined, fixturesError: "walk failed" } }];
    await refused(/fixtures cannot be read/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_stages read-back: an unreadable fixture count is unavailable, never matched; two stages sharing a name are a mismatch (review of #112)", async () => {
  const { h, w } = await setup();
  try {
    // The count unreadable before the session (create): the names match, the count is not checked.
    w.live = [{ fixtures: 5, row: { fixtures: undefined, fixturesError: "walk failed" } }];
    let { result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Basement", exclusive: true });
    assert.equal(result.committed, true);
    assert.equal(result.verification.status, "unavailable", JSON.stringify(result.verification));
    assert.match(result.verification.detail, /not checked: the fixture count of stage 1 .*unreadable before the session.*\(the names matched\)/);
    assert.match(result.summary, /Read-back unavailable/);

    // The count unreadable in the read-back (rename).
    w.live = [{ fixtures: 5 }];
    w.onCommit = (live) => {
      live[0].row = { fixtures: undefined, fixturesError: "walk failed" };
    };
    ({ result } = await h.callJson("gma3_patch_stages", { action: "rename", stage: 1, name: "Main Floor", exclusive: true }));
    assert.equal(result.verification.status, "unavailable", JSON.stringify(result.verification));
    assert.match(result.verification.detail, /unreadable in the read-back/);

    // Two stages reading one name after the commit.
    w.live = [{ fixtures: 5 }];
    w.onCommit = (live) => {
      live[0].name = "deck";
    };
    ({ result } = await h.callJson("gma3_patch_stages", { action: "create", name: "Deck", exclusive: true }));
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /stages 1 and 2 are both named "deck"/);
  } finally {
    await h.close();
  }
});
