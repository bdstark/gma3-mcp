import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError, SILENT } from "./helpers/fake-bridge.js";
import { registerPatchMoveTools, samePose, worldPose } from "../src/tools/patchmove.js";

/**
 * gma3_patch_move against a fake bridge whose patch.move* ops behave like the bridge's on the console (live
 * 2026-10-23): each queued command lands on the next poll (a console frame), Cut moves nothing, Paste opens the Move
 * Fixtures dialog and the fixtures move only when it is answered. Absolute keeps the world position (the local one
 * changes under a parent away from the origin), Relative the local one. The bridge ops themselves are covered by
 * test/lua/patch_ops_test.lua.
 */

interface Fx {
  fid: number;
  name: string;
  patch: string;
  parent: number | null;
  pos: { x: number; y: number; z: number };
  grouping?: boolean;
}

const MOVE_TEXT = "Do you want the fixtures to keep their absolute position and rotation in 3D space? Or do you want to keep their position and rotation offset which are relative to their parent?";

class MoveWorld {
  live: Fx[] = [
    { fid: 1, name: "MA StartShow 1", patch: "", parent: null, pos: { x: 0, y: 0, z: 0 }, grouping: true },
    { fid: 2, name: "MA StartShow 2", patch: "", parent: null, pos: { x: 1, y: 0, z: 0 }, grouping: true },
    { fid: 101, name: "Beam 1", patch: "1.001", parent: null, pos: { x: 2, y: 3, z: 4 } },
    { fid: 102, name: "Beam 2", patch: "1.020", parent: null, pos: { x: -2, y: 3, z: 4 } },
    { fid: 201, name: "Spot 1", patch: "1.100", parent: 1, pos: { x: 0, y: 1, z: 0 } },
  ];
  groups: Record<number, string[]> = { 101: ["1.5", "1.211"], 102: ["1.5", "1.211"], 201: ["1.6"] };
  copy: Fx[] | null = null;
  dest = "Root";
  pending: Array<() => void> = [];
  last = "";
  modal: false | { title?: string; text?: string; buttons: Array<{ text: string; enabled: boolean }> } = false;
  moveDialog = false;
  clip: number[] | null = null;
  pasteCmd = "";
  /** The console ignores Absolute (keeps the local pose): the read-back must catch it. */
  ignoreAbsolute = false;
  /** A different dialog opens instead of Move Fixtures. */
  otherDialog = false;
  /** The answer gets refused by the bridge. */
  answerError = false;
  /** The move drops a group membership. */
  dropGroup = false;
  /** The paste is queued but its reply is lost. */
  pasteSilent = false;
  answered: string[] = [];

  frame() {
    const p = this.pending;
    this.pending = [];
    for (const f of p) f();
  }

  side(): Fx[] {
    return this.copy ?? this.live;
  }

  holderName(h: number | null) {
    return h === null ? "Stage 1.Fixtures" : this.side().find((x) => x.fid === h)!.name;
  }

  install(h: Harness) {
    const f = h.fake;
    f.on("patch.state", () => {
      this.frame();
      const copyOpen = this.copy !== null;
      return { destination: this.dest, copyOpen, atRoot: this.dest === "Root" && !copyOpen, modal: this.modal, stages: ["Stage 1"] };
    });
    f.on("patch.moveCheck", (args) => {
      const fids = args.fids as number[];
      const rows = fids.map((fid) => this.live.find((x) => x.fid === fid));
      if (rows.some((r) => !r)) throw new BridgeReplyError("[no-fixture] no fixture", "no-fixture");
      const parents = new Set(rows.map((r) => r!.parent));
      if (parents.size > 1) throw new BridgeReplyError("[mixed-parents] the fixtures have different parents", "mixed-parents");
      const target = args.parent === "root" ? null : this.live.find((x) => x.fid === args.parent);
      if (target === undefined || (target && !target.grouping)) throw new BridgeReplyError("[not-grouping] not a grouping fixture", "not-grouping");
      const src = rows[0]!.parent;
      return { stage: "Stage 1", source: { fid: src ?? "root" }, target: { fid: target ? target.fid : "root", type: target ? "Grouping" : undefined }, fixtures: rows.map((r) => this.row(r!)) };
    });
    f.on("patch.enter", (args) => {
      if (this.copy) throw new BridgeReplyError("[copy-open] open", "copy-open");
      assert.equal(args.stage, "Stage 1");
      this.pending.push(() => {
        this.copy = this.live.map((x) => ({ ...x, pos: { ...x.pos } }));
        this.dest = "Stage 1.Fixtures";
      });
      return { queued: true, stage: "Stage 1", expectDestination: "Stage 1.Fixtures" };
    });
    const state = (args: Record<string, unknown>) => {
      this.frame();
      const fids = args.fids as number[];
      const target = args.parent === "root" ? null : (args.parent as number);
      const source = args.source === "root" ? null : (args.source as number);
      const side = this.side();
      const under = fids.filter((fid) => side.find((x) => x.fid === fid)?.parent === target).length;
      const underSource = fids.filter((fid) => side.find((x) => x.fid === fid)?.parent === source).length;
      return {
        destination: this.dest,
        atStage: this.dest === "Stage 1.Fixtures",
        atSource: this.dest === this.holderName(source),
        atTarget: this.dest === this.holderName(target),
        underTarget: under,
        underSource,
        count: fids.length,
        lastCommand: this.last,
        modal: this.modal,
        modalKnown: true,
        moveDialog: this.moveDialog,
      };
    };
    f.on("patch.moveState", (args) => state(args));
    f.on("patch.moveStep", (args) => {
      if (!this.copy) throw new BridgeReplyError("[copy-closed] closed", "copy-closed");
      if (this.modal) throw new BridgeReplyError("[modal-open] a dialog is open", "modal-open");
      const fids = args.fids as number[];
      const target = args.parent === "root" ? null : (args.parent as number);
      const source = this.copy.find((x) => x.fid === fids[0])!.parent;
      const commands: string[] = [];
      const queue = (cmd: string, fn: () => void) => {
        commands.push(cmd);
        this.pending.push(() => {
          fn();
          if (cmd.startsWith("Paste")) return;
          this.last = `OK: ${cmd}`;
        });
      };
      if (args.step === "source") {
        if (source !== null) queue(`ChangeDestination ${source}`, () => (this.dest = this.holderName(source)));
      } else if (args.step === "cut") {
        queue(`Cut ${fids.join(" + ")}`, () => (this.clip = fids));
      } else if (args.step === "target") {
        if (source !== null) queue("ChangeDestination ..", () => (this.dest = "Stage 1.Fixtures"));
        if (target !== null) queue(`ChangeDestination ${target}`, () => (this.dest = this.holderName(target)));
      } else if (args.step === "paste") {
        if (this.dest !== this.holderName(target)) throw new BridgeReplyError("[wrong-destination] not at the target", "wrong-destination");
        this.pasteCmd = "Paste 9";
        queue(this.pasteCmd, () => {
          if (this.otherDialog) this.modal = { title: "Error", text: "Something else", buttons: [{ text: "OK", enabled: true }] };
          else {
            this.modal = { title: "Move Fixtures", text: MOVE_TEXT, buttons: ["Absolute", "Relative", "Cancel"].map((text) => ({ text, enabled: true })) };
            this.moveDialog = true;
          }
        });
        if (this.pasteSilent) return SILENT;
      }
      return { step: args.step, commands };
    });
    f.on("patch.moveAnswer", (args) => {
      if (this.answerError && args.button !== "Cancel") throw new BridgeReplyError("[no-button] refused", "no-button");
      if (!this.moveDialog) throw new BridgeReplyError("[wrong-modal] not Move Fixtures", "wrong-modal");
      this.answered.push(args.button as string);
      this.modal = false;
      this.moveDialog = false;
      if (args.button === "Cancel") {
        this.last = `User Canceled Command: ${this.pasteCmd}`;
        return { clicked: "Cancel" };
      }
      const target = this.copy!.find((x) => x.fid === (this.dest === "Stage 1.Fixtures" ? -1 : this.copy!.find((y) => y.name === this.dest)?.fid)) ?? null;
      const origin = (fx: Fx) => (fx.parent === null ? { x: 0, y: 0, z: 0 } : this.copy!.find((x) => x.fid === fx.parent)!.pos);
      for (const fid of this.clip ?? []) {
        const fx = this.copy!.find((x) => x.fid === fid)!;
        const o0 = origin(fx);
        const world = { x: o0.x + fx.pos.x, y: o0.y + fx.pos.y, z: o0.z + fx.pos.z };
        fx.parent = target ? target.fid : null;
        const o1 = origin(fx);
        if (args.button === "Absolute" && !this.ignoreAbsolute) fx.pos = { x: world.x - o1.x, y: world.y - o1.y, z: world.z - o1.z };
        if (this.dropGroup) this.groups[fid] = (this.groups[fid] ?? []).slice(1);
      }
      this.clip = null;
      this.last = `OK: ${this.pasteCmd}`;
      return { clicked: args.button };
    });
    f.on("patch.groupsOf", (args) => ({ groups: Object.fromEntries((args.fids as number[]).map((fid) => [String(fid), this.groups[fid] ?? []])), scanned: 10, total: 10, unreadable: [], truncated: false }));
    f.on("objects", (args) => {
      const fids = String(args.ref).replace(/^Fixture /, "").split(" + ").map(Number);
      const items = this.live
        .filter((x) => fids.includes(x.fid))
        .map((x) => ({
          name: x.name,
          class: "Fixture",
          fields: args.asText === false ? { FID: x.fid, Name: x.name, POSX: x.pos.x, POSY: x.pos.y, POSZ: x.pos.z, ROTX: 0, ROTY: 0, ROTZ: 0, MESHMIRRORX: "No" } : { FID: String(x.fid), ROTDIRECT: "0,0,0,1" },
        }));
      return { items };
    });
    f.on("patch.collections", () => ({ copyOpen: this.copy !== null, live: ["Stages"], copy: this.copy ? ["Stages"] : false }));
    f.on("patch.fingerprint", (args) => {
      assert.equal(args.fixturePositions, args.excludeFids && (args.excludeFids as number[]).length ? false : args.fixturePositions);
      const exclude = (args.excludeFids as number[]) ?? [];
      const list = (args.side === "copy" ? this.copy : this.live) ?? [];
      const kept = list.filter((x) => !exclude.includes(x.fid)).map((x) => ({ ...x }));
      return { objects: kept.length, hash: JSON.stringify(kept), complete: true };
    });
    f.on("patch.commit", () => {
      if (this.modal) throw new BridgeReplyError("[modal-open] open", "modal-open");
      this.pending.push(() => {
        if (this.copy) this.live = this.copy;
        this.copy = null;
        this.dest = "Root";
      });
      return { queued: true };
    });
    f.on("patch.list", (args) => {
      const rows = this.live.filter((x) => x.fid >= (args.fromFid as number) && x.fid <= (args.toFid as number)).map((x) => this.row(x));
      return { total: rows.length, offset: 0, count: rows.length, fixtures: rows };
    });
  }

  row(x: Fx) {
    return { fid: x.fid, name: x.name, patch: x.patch, ...(x.parent !== null ? { parentFid: x.parent } : {}), stage: "Stage 1", depth: x.parent === null ? 0 : 1, subfixtures: 0 };
  }
}

async function setup() {
  const h = await startHarness(registerPatchMoveTools);
  const w = new MoveWorld();
  w.install(h);
  return { h, w, ops: () => h.fake.requests.map((r) => r.op) };
}
const stepNames = (r: any) => r.steps.map((s: any) => `${s.name}:${s.status}`);

test("pose helpers: world pose under a parent, and pose equality within 1 mm and up to the quaternion's sign", () => {
  const parent = { position: { x: 1, y: 0, z: 0 }, quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number] };
  const w = worldPose({ position: { x: 1, y: 0, z: 0 }, quaternion: [0, 0, 0, 1] }, parent);
  assert.ok(Math.abs(w.position.x - 1) < 1e-9 && Math.abs(w.position.y - 1) < 1e-9, JSON.stringify(w));
  assert.ok(samePose({ position: { x: 0, y: 0, z: 0 }, quaternion: [0, 0, 0, 1] }, { position: { x: 0.0005, y: 0, z: 0 }, quaternion: [0, 0, 0, -1] }));
  assert.ok(!samePose({ position: { x: 0, y: 0, z: 0 }, quaternion: [0, 0, 0, 1] }, { position: { x: 0.002, y: 0, z: 0 }, quaternion: [0, 0, 0, 1] }));
});

test("gma3_patch_move: top level into a grouping fixture, every step in order, Absolute answered, committed and read back", async () => {
  const { h, w, ops } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_move", { fids: [101, 102], parent: 1, exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.verification.status, "matched", JSON.stringify(result.verification));
    assert.equal(result.dialog, "answered");
    assert.equal(result.committed, true);
    assert.deepEqual(stepNames(result), [
      "check_state:succeeded",
      "check_move:succeeded",
      "enter:succeeded",
      "wait_copy:succeeded",
      "move_source:succeeded",
      "move_cut:succeeded",
      "wait_cut:succeeded",
      "move_target:succeeded",
      "wait_target:succeeded",
      "move_paste:succeeded",
      "wait_dialog:succeeded",
      "move_answer:succeeded",
      "wait_paste:succeeded",
      "isolation_check:succeeded",
      "commit:succeeded",
      "wait_commit:succeeded",
      "read_back:succeeded",
      "read_groups:succeeded",
      "read_positions:succeeded",
    ]);
    assert.deepEqual(w.answered, ["Absolute"]);
    assert.deepEqual(w.live.filter((x) => x.fid > 100 && x.fid < 200).map((x) => `${x.fid}<${x.parent}`), ["101<1", "102<1"]);
    const fp = h.fake.requests.filter((r) => r.op === "patch.fingerprint");
    assert.ok(fp.length && fp.every((r) => r.args.fixturePositions === false && JSON.stringify(r.args.excludeFids) === "[101,102]"), "the isolation check leaves out the moved FIDs and the list positions");
    assert.deepEqual(result.fixtures.map((f: any) => `${f.fid}:${f.parentFid}:${f.patch}:${f.groups.join("/")}`), ["101:1:1.001:1.5/1.211", "102:1:1.020:1.5/1.211"]);
    assert.ok(ops().indexOf("patch.commit") > ops().lastIndexOf("patch.moveAnswer"));
  } finally {
    await h.close();
  }
});

test("gma3_patch_move: under a parent away from the origin, absolute keeps the world position and relative the offset; a console that ignores Absolute is a mismatch", async () => {
  for (const [position, ignore, expect] of [
    ["absolute", false, "matched"],
    ["relative", false, "matched"],
    ["absolute", true, "mismatched"],
  ] as const) {
    const { h, w } = await setup();
    try {
      w.ignoreAbsolute = ignore;
      const { result } = await h.callJson("gma3_patch_move", { fids: [101], parent: 2, position, exclusive: true });
      assert.equal(result.verification.status, expect, `${position}/${ignore}: ${JSON.stringify(result.verification)}`);
      assert.deepEqual(w.answered, [position === "absolute" ? "Absolute" : "Relative"]);
      const fx = w.live.find((x) => x.fid === 101)!;
      assert.equal(fx.parent, 2);
      if (expect === "mismatched") assert.match(result.verification.detail, /world 3D pose changed/);
    } finally {
      await h.close();
    }
  }
});

test("gma3_patch_move: out of a grouping fixture to the top level goes through ChangeDestination ..", async () => {
  const { h, w } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_patch_move", { fids: [201], parent: "root", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(w.live.find((x) => x.fid === 201)!.parent, null);
    const sent = h.fake.requests.filter((r) => r.op === "patch.moveStep").map((r) => r.args.step);
    assert.deepEqual(sent, ["source", "cut", "target", "paste"]);
    assert.ok(stepNames(result).includes("wait_source:succeeded"));
  } finally {
    await h.close();
  }
});

test("gma3_patch_move: refused before anything is sent (validation, the bridge's pre-check)", async () => {
  const { h, ops } = await setup();
  try {
    for (const args of [
      { fids: [101], parent: 1 },
      { fids: [101], exclusive: true },
      { fids: [101], parent: 101, exclusive: true },
      { fids: [101, 101], parent: 1, exclusive: true },
      { fids: [101], parent: 1, position: "sideways", exclusive: true },
    ]) {
      const { result, isError } = await h.callJson("gma3_patch_move", args);
      assert.equal(isError, true, JSON.stringify(args));
      assert.ok(result.validationErrors?.length || /input validation failed/.test(String(result)), JSON.stringify(result));
    }
    const { result } = await h.callJson("gma3_patch_move", { fids: [101, 201], parent: 2, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /different parents/);
    assert.ok(!ops().includes("patch.enter"), "nothing was sent");
  } finally {
    await h.close();
  }
});

test("gma3_patch_move: another dialog after the paste stops the move and is left alone; with it open the copy cannot be closed", async () => {
  const { h, w, ops } = await setup();
  try {
    w.otherDialog = true;
    const { result } = await h.callJson("gma3_patch_move", { fids: [101], parent: 1, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.equal(result.committed, false);
    const wd = result.steps.find((s: any) => s.name === "wait_dialog");
    assert.equal(wd.status, "failed");
    assert.match(wd.error, /another dialog opened.*left alone/);
    assert.ok(!ops().includes("patch.moveAnswer"), "the other dialog was not answered");
    assert.equal(result.copyLeftOpen, true);
    assert.match(result.summary, /LEFT OPEN/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_move: a refused answer cancels the Move Fixtures dialog; nothing moved and the copy is closed", async () => {
  const { h, w } = await setup();
  try {
    w.answerError = true;
    const { result } = await h.callJson("gma3_patch_move", { fids: [101], parent: 1, exclusive: true });
    assert.equal(result.outcome, "failed");
    assert.deepEqual(w.answered, ["Cancel"]);
    assert.ok(stepNames(result).includes("cancel_dialog:succeeded"), JSON.stringify(stepNames(result)));
    assert.equal(result.copyLeftOpen, false);
    assert.equal(w.live.find((x) => x.fid === 101)!.parent, null);
    assert.equal(w.copy, null);
  } finally {
    await h.close();
  }
});

test("gma3_patch_move: a paste without a reply still has its Move Fixtures dialog cancelled (PR #89 review)", async () => {
  const { h, w } = await setup();
  try {
    w.pasteSilent = true;
    const { result } = await h.callJson("gma3_patch_move", { fids: [101], parent: 1, exclusive: true });
    assert.equal(result.outcome, "unknown");
    assert.deepEqual(w.answered, ["Cancel"]);
    assert.ok(stepNames(result).includes("cancel_dialog:succeeded"), JSON.stringify(stepNames(result)));
    assert.equal(result.copyLeftOpen, false);
    assert.equal(w.live.find((x) => x.fid === 101)!.parent, null);
  } finally {
    await h.close();
  }
});

test("gma3_patch_move: a group lost in the move is a read-back mismatch", async () => {
  const { h, w } = await setup();
  try {
    w.dropGroup = true;
    const { result } = await h.callJson("gma3_patch_move", { fids: [101], parent: 1, exclusive: true });
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.verification.status, "mismatched");
    assert.match(result.verification.detail, /FID 101: groups \[1\.211\], were \[1\.5,1\.211\]/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_retype: runs the retype session under its own operation name", async () => {
  const h = await startHarness(registerPatchMoveTools);
  try {
    const { result, isError } = await h.callJson("gma3_patch_retype", { fixtures: [101], type: 19 });
    assert.equal(isError, true);
    assert.equal(result.operation, "patch_retype");
    assert.match(result.summary, /exclusive/);
    assert.ok(h.tools.get("gma3_patch_retype")!.description!.includes("fixed revision of a GDTF"));
  } finally {
    await h.close();
  }
});

test("gma3_patch_retype: the read-back checks the type by number, so the old import of the same name is a mismatch (PR #89 review)", async () => {
  for (const [applies, expect] of [[true, "matched"], [false, "mismatched"]] as const) {
    const h = await startHarness(registerPatchMoveTools);
    try {
      let copy: string | null = null;
      let live = "16 180W Beam";
      let pending: Array<() => void> = [];
      const frame = () => {
        const p = pending;
        pending = [];
        for (const f of p) f();
      };
      const f = h.fake;
      f.on("patch.state", () => {
        frame();
        return { destination: copy === null ? "Root" : "Stage 1.Fixtures", copyOpen: copy !== null, atRoot: copy === null, modal: false, stages: ["Stage 1"] };
      });
      f.on("patch.types", () => ({ count: 2, types: [{ no: 16, name: "180W Beam", modes: [] }, { no: 19, name: "180W Beam", modes: [] }] }));
      f.on("patch.list", () => ({ total: 1, offset: 0, count: 1, fixtures: [{ fid: 101, name: "Beam 1", type: live, mode: "1 Mode", patch: "1.001" }] }));
      f.on("patch.enter", () => {
        pending.push(() => (copy = live));
        return { queued: true, stage: "Stage 1", expectDestination: "Stage 1.Fixtures" };
      });
      f.on("patch.retype", () => {
        if (applies) copy = "19 180W Beam";
        return { retyped: [{ fid: 101 }] };
      });
      f.on("patch.collections", () => ({ copyOpen: copy !== null, live: ["Stages"], copy: copy !== null ? ["Stages"] : false }));
      f.on("patch.fingerprint", () => ({ objects: 1, hash: 1, complete: true }));
      f.on("patch.commit", () => {
        pending.push(() => {
          live = copy!;
          copy = null;
        });
        return { queued: true };
      });
      const { result } = await h.callJson("gma3_patch_retype", { fixtures: [101], type: 19, exclusive: true });
      assert.equal(result.operation, "patch_retype");
      assert.equal(result.verification.status, expect, JSON.stringify(result.verification));
      if (!applies) assert.match(result.verification.detail, /not of type 19 180W Beam/);
    } finally {
      await h.close();
    }
  }
});
