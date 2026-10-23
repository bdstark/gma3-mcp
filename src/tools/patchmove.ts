/**
 * Moving fixtures under a grouping fixture (or back to the stage's top level), and retyping fixtures.
 *
 *   gma3_patch_move     fixtures to a grouping fixture's children, e.g. under the MA Show Start's grouping fixtures
 *                       FID 1-8, keeping their FIDs, addresses, groups, presets and 3D placement
 *   gma3_patch_retype   fixtures to another fixture type with the same DMX mode (Halloween finding #5)
 *
 * The move runs one patch session (src/tools/patch.ts runSession) with a multi-step edit, the way the Halloween 2026
 * build did it by hand (live, onPC 2.5.1, 2026-10-23, about 33 gma3_lua calls), each step queued by the bridge
 * (patch.moveStep, CmdIndirect) and polled with patch.moveState before the next one:
 *
 *   move_source   ChangeDestination <position of the fixtures' grouping fixture> (only when they have a parent)
 *   move_cut      Cut <their positions>          (marks them; nothing moves yet)
 *   move_target   ChangeDestination .. and/or ChangeDestination <position of the target grouping fixture>
 *   move_paste    Paste <end of the target's list>; the console asks "Move Fixtures": keep the absolute 3D position
 *                 and rotation, or the offset relative to the parent (Absolute / Relative / Cancel)
 *   move_answer   patch.moveAnswer clicks the chosen button on that dialog, and only on that dialog
 *
 * then the session's isolation check (fixtures compared without their list positions: the move renumbers the fixtures
 * after the moved ones) and the commit. The read-back compares each fixture with its state before the session: the
 * parent, the address, the name, its groups (patch.groupsOf) and its 3D pose (absolute: the world pose is kept;
 * relative: the pose relative to the parent is kept).
 */
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { asRead, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator } from "../validate.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { EXCLUSIVE_DESC, SESSION_DESC, VERIFY_DESC, fidNumber, listFids, requireExclusive, runSession, type FixtureRow } from "./patch.js";
import { readPoses, type FixturePose, type Quat } from "./positions.js";
import { assignCellLayout } from "./celllayout.js";
import { describeDialog, type DialogRow } from "./dialog.js";

const MAX_MOVE = 256;
const POLL_TRIES = 30;
const POLL_MS = 100;
const TOLERANCE_M = 0.001;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type MovePosition = "absolute" | "relative";
const BUTTON: Record<MovePosition, string> = { absolute: "Absolute", relative: "Relative" };

interface MoveCheck {
  stage: string;
  source: { fid: number | "root"; name?: string; type?: string };
  target: { fid: number | "root"; name?: string; type?: string };
  fixtures: FixtureRow[];
}

interface MoveState {
  destination: string | null;
  atStage: boolean;
  atSource: boolean;
  atTarget: boolean;
  underTarget: number;
  underSource: number;
  count: number;
  lastCommand?: string | null;
  modal: DialogRow | false;
  modalKnown: boolean;
  moveDialog: boolean;
}

// ---------------------------------------------------------------------------
// Poses (pure)
// ---------------------------------------------------------------------------

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

function rotate(q: Quat, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const [x, y, z] = quatMul(quatMul(q, [v.x, v.y, v.z, 0]), [-q[0], -q[1], -q[2], q[3]]);
  return { x, y, z };
}

interface Pose {
  position: { x: number; y: number; z: number };
  quaternion: Quat;
}
const IDENTITY: Pose = { position: { x: 0, y: 0, z: 0 }, quaternion: [0, 0, 0, 1] };

function poseOf(p: FixturePose | undefined): Pose | null {
  if (!p || !p.quaternion || ![p.position.x, p.position.y, p.position.z].every(Number.isFinite)) return null;
  return { position: p.position, quaternion: p.quaternion };
}

/** A fixture's pose in the world from its pose relative to its parent (a parent at the top level of the stage). */
export function worldPose(local: Pose, parent: Pose): Pose {
  const r = rotate(parent.quaternion, local.position);
  return { position: { x: parent.position.x + r.x, y: parent.position.y + r.y, z: parent.position.z + r.z }, quaternion: quatMul(parent.quaternion, local.quaternion) };
}

/** Within 1 mm and the same rotation (q and -q are the same rotation). */
export function samePose(a: Pose, b: Pose): boolean {
  const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  const dot = Math.abs(a.quaternion.reduce((s, v, i) => s + v * b.quaternion[i], 0));
  return d <= TOLERANCE_M && dot >= 1 - 1e-6;
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const poseOut = (p: Pose) => ({ position: { x: round(p.position.x), y: round(p.position.y), z: round(p.position.z) }, quaternion: p.quaternion.map(round) });

// ---------------------------------------------------------------------------
// gma3_patch_move
// ---------------------------------------------------------------------------

interface MoveArgs {
  fids?: unknown;
  parent?: unknown;
  position?: unknown;
  exclusive?: unknown;
  verify?: unknown;
}

interface Before {
  rows: Map<number, FixtureRow>;
  poses: Map<number, FixturePose>;
  groups?: Record<string, number[]>;
  groupsError?: string;
}

export async function patchMove(ctx: ToolContext, raw: MoveArgs): Promise<OperationResult> {
  const op = "patch_move";
  const v = new Validator();
  const fids: number[] = [];
  if (!Array.isArray(raw.fids) || raw.fids.length === 0) v.fail("fids must be a non-empty list");
  else if (raw.fids.length > MAX_MOVE) v.fail(`at most ${MAX_MOVE} fixtures per call`);
  else
    raw.fids.forEach((f, i) => {
      const fid = v.check(() => fidNumber(`fids[${i}]`, f));
      if (fid !== undefined && fids.includes(fid)) v.fail(`FID ${fid} appears twice`);
      else if (fid !== undefined) fids.push(fid);
    });
  const parent: number | "root" | undefined = raw.parent === "root" ? "root" : v.check(() => fidNumber("parent", raw.parent));
  if (parent === undefined && v.ok) v.fail('parent must be the FID of a grouping fixture or "root"');
  if (typeof parent === "number" && fids.includes(parent)) v.fail(`the parent FID ${parent} is one of the fixtures`);
  const position: MovePosition | undefined = raw.position === undefined ? "absolute" : raw.position === "absolute" || raw.position === "relative" ? raw.position : (v.fail('position must be "absolute" or "relative"'), undefined);
  requireExclusive(v, raw.exclusive);
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { fids: raw.fids, parent: raw.parent, position: position ?? raw.position };
  if (!v.ok || parent === undefined || position === undefined) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  const bridge = ctx.bridge;
  let check: MoveCheck | undefined;
  let before: Before | undefined;
  let dialog: "answered" | "not_shown" | undefined;
  const parentFids = () => [check?.source.fid, check?.target.fid].filter((f): f is number => typeof f === "number");

  const moveArgs = () => ({ fids, parent, stage: check!.stage });
  const stateArgs = () => ({ ...moveArgs(), source: check!.source.fid });
  async function poll(name: string, what: string, done: (s: MoveState) => boolean | string): Promise<{ step: StepResult; state?: MoveState }> {
    let last: MoveState | undefined;
    for (let i = 0; i < POLL_TRIES; i++) {
      try {
        last = (await bridge.request("patch.moveState", stateArgs(), t)) as MoveState;
      } catch (err) {
        return { step: asRead(stepFromError(name, err, { op: "patch.moveState" })) };
      }
      const r = done(last);
      if (typeof r === "string") return { step: asRead({ name, status: "failed", op: "patch.moveState", error: r, detail: last }), state: last };
      if (r) return { step: asRead({ name, status: "succeeded", op: "patch.moveState", detail: { destination: last.destination, lastCommand: last.lastCommand, polls: i + 1 } }), state: last };
      await sleep(POLL_MS);
    }
    return { step: asRead({ name, status: "unknown", op: "patch.moveState", error: `${what} did not happen within ${(POLL_TRIES * POLL_MS) / 1000} s`, detail: last }), state: last };
  }
  const failedCommand = (s: MoveState, before: string | null | undefined, cmd: string) => {
    const last = s.lastCommand ?? "";
    if (last !== before && last !== `OK: ${cmd}` && !last.startsWith("OK: ")) return `the console answered ${JSON.stringify(last)} to ${cmd}`;
    return false;
  };
  const otherModal = (s: MoveState) => (s.modal && !s.moveDialog ? `another dialog opened: ${describeDialog(s.modal)}; it was left alone` : false);

  async function step(name: string, which: "source" | "cut" | "target" | "paste"): Promise<StepResult> {
    try {
      const res = (await bridge.request("patch.moveStep", { ...moveArgs(), step: which, exclusive: true }, t)) as { commands: string[] };
      return { name, status: "succeeded", op: "patch.moveStep", detail: res };
    } catch (err) {
      const s = stepFromError(name, err, { op: "patch.moveStep" });
      if (err instanceof BridgeError && err.detail !== undefined) s.detail = err.detail;
      return s;
    }
  }

  /** The move inside the open copy; on any problem after the paste, a still open Move Fixtures dialog is cancelled. */
  async function runMove(): Promise<{ steps: StepResult[] }> {
    const steps: StepResult[] = [];
    const stop = () => ({ steps });
    // move_source
    const src = await step("move_source", "source");
    steps.push(src);
    if (src.status !== "succeeded") return stop();
    if (((src.detail as { commands?: string[] }).commands ?? []).length) {
      const w = await poll("wait_source", "reaching the fixtures' grouping fixture", (s) => otherModal(s) || s.atSource);
      steps.push(w.step);
      if (w.step.status !== "succeeded") return stop();
    }
    // move_cut
    let lastBefore: string | null | undefined;
    try {
      lastBefore = ((await bridge.request("patch.moveState", stateArgs(), t)) as MoveState).lastCommand;
    } catch {
      lastBefore = undefined;
    }
    const cut = await step("move_cut", "cut");
    steps.push(cut);
    if (cut.status !== "succeeded") return stop();
    const cutCmd = (cut.detail as { commands: string[] }).commands[0];
    const wc = await poll("wait_cut", cutCmd, (s) => otherModal(s) || failedCommand(s, lastBefore, cutCmd) || s.lastCommand === `OK: ${cutCmd}`);
    steps.push(wc.step);
    if (wc.step.status !== "succeeded") return stop();
    // move_target
    const tg = await step("move_target", "target");
    steps.push(tg);
    if (tg.status !== "succeeded") return stop();
    const wt = await poll("wait_target", "reaching the target", (s) => otherModal(s) || s.atTarget);
    steps.push(wt.step);
    if (wt.step.status !== "succeeded") return stop();
    // Cancels the Move Fixtures dialog if it is open (and only that dialog: patch.moveAnswer checks it).
    const cleanup = async (why: string) => {
      let open = false;
      try {
        open = ((await bridge.request("patch.moveState", stateArgs(), t)) as MoveState).moveDialog;
      } catch {
        open = false;
      }
      if (!open) return;
      try {
        await bridge.request("patch.moveAnswer", { button: "Cancel", exclusive: true }, t);
        const w = await poll("cancel_dialog", "closing the Move Fixtures dialog", (s) => !s.modal);
        steps.push({ ...w.step, kind: "mutation", detail: { why, ...(w.step.detail as object) } });
      } catch (err) {
        steps.push(stepFromError("cancel_dialog", err, { op: "patch.moveAnswer" }));
      }
    };
    // move_paste: the dialog, or (if the console asks nothing) the fixtures under the target
    const paste = await step("move_paste", "paste");
    steps.push(paste);
    if (paste.status === "unknown") {
      // The Paste may have been queued without a reply: wait for its dialog, then cancel it, so the copy can be closed.
      const w = await poll("wait_dialog", "the Move Fixtures dialog after an unacknowledged paste", (s) => otherModal(s) || s.moveDialog);
      steps.push(w.step);
      await cleanup("the paste got no reply");
      return stop();
    }
    if (paste.status !== "succeeded") return stop();
    const pasteCmd = (paste.detail as { commands: string[] }).commands[0];
    const wp = await poll("wait_dialog", "the Move Fixtures dialog (or the paste)", (s) => otherModal(s) || failedCommand(s, wt.state?.lastCommand, pasteCmd) || s.moveDialog || (!s.modal && s.underTarget === s.count && s.lastCommand === `OK: ${pasteCmd}`));
    steps.push(wp.step);
    if (wp.step.status !== "succeeded") {
      await cleanup("the paste did not finish");
      return stop();
    }
    if (!wp.state?.moveDialog) {
      // The console asked nothing: the fixtures were pasted without the question (the read-back checks the pose).
      dialog = "not_shown";
      return stop();
    }
    // move_answer
    let ans: StepResult;
    try {
      const res = await bridge.request("patch.moveAnswer", { button: BUTTON[position!], exclusive: true }, t);
      ans = { name: "move_answer", status: "succeeded", op: "patch.moveAnswer", detail: res };
    } catch (err) {
      ans = stepFromError("move_answer", err, { op: "patch.moveAnswer" });
    }
    steps.push(ans);
    if (ans.status !== "succeeded") {
      await cleanup("the answer was not confirmed");
      return stop();
    }
    dialog = "answered";
    const wm = await poll("wait_paste", "the paste", (s) => otherModal(s) || failedCommand(s, wt.state?.lastCommand, pasteCmd) || (!s.modal && s.underTarget === s.count && s.lastCommand === `OK: ${pasteCmd}`));
    steps.push(wm.step);
    if (wm.step.status !== "succeeded") await cleanup("the paste did not finish after the answer");
    return stop();
  }

  async function readBefore(): Promise<Before> {
    const rows = new Map(check!.fixtures.filter((r) => typeof r.fid === "number").map((r) => [r.fid as number, r]));
    const poses = await readPoses(bridge, [...fids, ...parentFids()], t);
    let groups: Record<string, number[]> | undefined;
    let groupsError: string | undefined;
    try {
      const g = (await bridge.request("patch.groupsOf", { fids }, Math.max(t, 30_000))) as { groups: Record<string, number[]>; truncated: boolean; unreadable: number[] };
      if (g.truncated) groupsError = "the group scan was cut at its bound";
      else if (g.unreadable.length) groupsError = `groups ${g.unreadable.join(", ")} could not be read`;
      else groups = g.groups;
    } catch (err) {
      groupsError = err instanceof Error ? err.message : String(err);
    }
    return { rows, poses, groups, groupsError };
  }

  return runSession(ctx, {
    operation: op,
    target,
    touchedFids: fids,
    verify,
    preflight: async () => {
      try {
        check = (await bridge.request("patch.moveCheck", { fids, parent }, t)) as MoveCheck;
      } catch (err) {
        const s = asRead(stepFromError("check_move", err, { op: "patch.moveCheck" }));
        if (err instanceof BridgeError && /unknown op/.test(err.message)) s.error = `${s.error}: the console runs an older bridge plugin without patch.moveCheck (bridge 0.40.0); update the plugin`;
        return s;
      }
      try {
        before = await readBefore();
      } catch (err) {
        return asRead({ ...stepFromError("check_move", err, { op: "objects" }), error: `the fixtures' state before the move could not be read: ${err instanceof Error ? err.message : String(err)}` });
      }
      return asRead({ name: "check_move", status: "succeeded", op: "patch.moveCheck", detail: { stage: check.stage, source: check.source, target: check.target, fixtures: check.fixtures.length } });
    },
    get stage() {
      return check?.stage;
    },
    editName: "move",
    runEdit: () => runMove(),
    isolation: () => ({ fixturePositions: false }),
    extra: () => ({ ...(check ? { stage: check.stage, from: check.source, to: check.target } : {}), position, ...(dialog ? { dialog } : {}) }),
    readBack: async () => readBack(),
  });

  async function readBack(): Promise<{ steps: StepResult[]; verification: Verification; extra?: Record<string, unknown> }> {
    const steps: StepResult[] = [];
    const mismatches: string[] = [];
    const notChecked: string[] = [];
    const b = before!;
    const want = parent === "root" ? undefined : parent;
    let rows: Map<number, FixtureRow>;
    try {
      rows = await listFids(bridge, fids, t);
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "patch.list", detail: [...rows.values()] }));
    } catch (err) {
      return { steps: [asRead(stepFromError("read_back", err, { op: "patch.list" }))], verification: unavailable("the patch could not be read back") };
    }
    for (const fid of fids) {
      const r = rows.get(fid);
      const o = b.rows.get(fid);
      if (!r) {
        mismatches.push(`FID ${fid} is not in the patch`);
        continue;
      }
      if ((r.parentFid ?? undefined) !== want) mismatches.push(`FID ${fid}: parent ${r.parentFid ?? "none (top level)"}, expected ${want ?? "none (top level)"}`);
      if (o && (r.patch ?? "") !== (o.patch ?? "")) mismatches.push(`FID ${fid}: address ${JSON.stringify(r.patch ?? "")}, was ${JSON.stringify(o.patch ?? "")}`);
      if (o && r.name !== o.name) mismatches.push(`FID ${fid}: name ${JSON.stringify(r.name)}, was ${JSON.stringify(o.name)}`);
    }
    // Groups
    let groupsAfter: Record<string, number[]> | undefined;
    if (b.groups) {
      try {
        const g = (await bridge.request("patch.groupsOf", { fids }, Math.max(t, 30_000))) as { groups: Record<string, number[]>; truncated: boolean; unreadable: number[] };
        steps.push(asRead({ name: "read_groups", status: "succeeded", op: "patch.groupsOf", detail: { scanned: (g as { scanned?: number }).scanned } }));
        if (g.truncated || g.unreadable.length) notChecked.push("groups (the scan after the move was incomplete)");
        else {
          groupsAfter = g.groups;
          for (const fid of fids) {
            const was = (b.groups[String(fid)] ?? []).join(",");
            const now = (g.groups[String(fid)] ?? []).join(",");
            if (was !== now) mismatches.push(`FID ${fid}: groups [${now}], were [${was}]`);
          }
        }
      } catch (err) {
        steps.push(asRead(stepFromError("read_groups", err, { op: "patch.groupsOf" })));
        notChecked.push("groups");
      }
    } else notChecked.push(`groups (${b.groupsError ?? "not read before"})`);
    // Poses
    const posesOut: Array<Record<string, unknown>> = [];
    try {
      const after = await readPoses(bridge, [...fids, ...parentFids()], t);
      steps.push(asRead({ name: "read_positions", status: "succeeded", op: "objects" }));
      const parentPose = (fid: number | "root" | undefined, poses: Map<number, FixturePose>) => (typeof fid === "number" ? poseOf(poses.get(fid)) : IDENTITY);
      const srcBefore = parentPose(check!.source.fid, b.poses);
      const tgtAfter = parentPose(check!.target.fid, after);
      for (const fid of fids) {
        const l0 = poseOf(b.poses.get(fid));
        const l1 = poseOf(after.get(fid));
        if (!l0 || !l1 || !srcBefore || !tgtAfter) {
          notChecked.push(`the 3D pose of FID ${fid} (unreadable)`);
          continue;
        }
        const w0 = worldPose(l0, srcBefore);
        const w1 = worldPose(l1, tgtAfter);
        const kept = position === "absolute" ? samePose(w0, w1) : samePose(l0, l1);
        if (!kept) mismatches.push(`FID ${fid}: the ${position === "absolute" ? "world" : "parent-relative"} 3D pose changed (${JSON.stringify(poseOut(position === "absolute" ? w0 : l0))} -> ${JSON.stringify(poseOut(position === "absolute" ? w1 : l1))})`);
        posesOut.push({ fid, before: poseOut(l0), after: poseOut(l1), world: poseOut(w1) });
      }
    } catch (err) {
      steps.push(asRead(stepFromError("read_positions", err, { op: "objects" })));
      notChecked.push("3D poses");
    }
    const checked = `each fixture's parent (${want ?? "top level"}), address, name, groups and ${position === "absolute" ? "world" : "parent-relative"} 3D pose against the state before the move`;
    const fixtures = fids.map((fid) => ({ fid, parentFid: rows.get(fid)?.parentFid ?? null, patch: rows.get(fid)?.patch ?? null, ...(groupsAfter ? { groups: groupsAfter[String(fid)] ?? [] } : {}), ...(posesOut.find((p) => p.fid === fid) ?? {}) }));
    const verification: Verification = mismatches.length
      ? { status: "mismatched", checked, detail: mismatches.join("; ") + (notChecked.length ? `; not checked: ${notChecked.join(", ")}` : "") }
      : notChecked.length
        ? unavailable(`not checked: ${notChecked.join(", ")} (the parents, addresses and names matched)`, checked)
        : { status: "matched", checked };
    return { steps, verification, extra: { fixtures } };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerPatchMoveTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_patch_move",
    {
      title: "Move fixtures under a grouping fixture (or back to the top level)",
      description:
        "Moves fixtures into a grouping fixture's children (parent: its FID), e.g. the rig under the MA Show Start's grouping fixtures FID 1-8, or back to the stage's top level (parent: \"root\"). FIDs, addresses, names, groups and presets are kept. " +
        "The console asks how to keep the 3D placement: position \"absolute\" (default) keeps each fixture's place and rotation in the world; \"relative\" keeps its offset from the parent (the fixture moves with the parent's position and rotation). With a parent at the origin and unrotated both are the same. " +
        "Pre-checks (nothing sent on failure): every FID exists, holds no fixtures itself, all share one parent (the top level or one top-level grouping fixture) in one stage, and the target is another top-level grouping fixture of that stage (type Grouping) or the top level. Move fixtures with different parents in one call each. " +
        "In the copy: Cut, ChangeDestination, Paste, and the console's \"Move Fixtures\" dialog answered by the bridge, each step checked before the next (a failure cancels the dialog). The isolation check compares fixtures without their list positions, because a move renumbers the fixtures after the moved ones. " +
        SESSION_DESC +
        " verify compares each fixture with its state before the session: parent, address, name, its groups, and its 3D pose (absolute: in the world; relative: to the parent). Needs bridge 0.40.0.",
      inputSchema: {
        fids: z.array(z.number()).describe(`Fixture IDs to move (1-${MAX_MOVE}), all with the same parent.`),
        parent: z.union([z.number(), z.literal("root")]).describe('FID of the target grouping fixture, or "root" for the top level of the stage.'),
        position: z.enum(["absolute", "relative"]).optional().describe('How the 3D placement is kept (default "absolute": the place and rotation in the world).'),
        exclusive: z.boolean().optional().describe(EXCLUSIVE_DESC),
        verify: z.boolean().optional().describe(VERIFY_DESC),
      },
    },
    async (args) => operation(() => patchMove(ctx, args as MoveArgs)),
  );

  server.registerTool(
    "gma3_patch_retype",
    {
      title: "Move fixtures to another fixture type with the same DMX mode",
      description:
        "Moves fixtures to another fixture type in the show whose DMX mode of the same name has the same channels and footprint (refused otherwise), keeping FIDs, addresses, cells, groups and preset values. " +
        "Use it after importing a fixed revision of a GDTF or library type: the fixtures move from the old import to the new one, then gma3_patch_remove_type removes the old type. Also moves fixtures between a type and its layout copy (the same as gma3_assign_cell_layout). " +
        "Runs one patch session (isolation-checked, committed with NO UNDO); requires exclusive: true. The read-back checks each fixture's type. Needs bridge 0.29.0.",
      inputSchema: {
        fixtures: z.array(z.number()).describe("FIDs to retype."),
        type: z.union([z.number(), z.string()]).describe("The target fixture type, by number or name (a number when two types share a name, e.g. two imports of one GDTF)."),
        exclusive: z.boolean().optional().describe(EXCLUSIVE_DESC),
        verify: z.boolean().optional().describe(VERIFY_DESC),
      },
    },
    async (args) => operation(() => assignCellLayout(ctx, args as Record<string, unknown>, "patch_retype")),
  );
};
