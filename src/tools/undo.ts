/**
 * gma3_undo (#142): undo the last tool calls' console undo groups (GMA3_UNDO_GROUPS=1, bridge 0.56.0).
 *
 * The server keeps the ids of the groups it closed (src/undo.ts), newest last, with a marker for every tool call that
 * made no group. The tool takes the newest `count` groups, refuses when an ungrouped call came after any of them, and
 * asks the bridge (`undo.undo`) to Oops exactly those groups. The bridge first checks that they are the console's
 * latest undo steps, in that order (anything done at the console since, by an operator or another connection, is on
 * top and refuses the call), then sends one Oops per group and reads back that each group left the undo list.
 * Nothing falls back to a blind Oops.
 *
 * Not verified on a console yet: that a group handle's parent is the console's undo list with the latest step last
 * (the handle is an object, Root 20.1.1.1.1 on onPC 2.5.1), and that the handle stays readable after CloseUndo. If
 * either is wrong the bridge refuses ("unreadable" / "not-latest") and nothing is undone.
 */
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { buildResult, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import type { UndoEntry, UndoGroups } from "../undo.js";

export const UNDO_NEEDS_BRIDGE = "the console runs an older bridge plugin without undo.undo (gma3_undo needs bridge 0.56.0); update the plugin";
const MAX_COUNT = 20;
/** Bridge codes sent after at least one Oops went out; every other code is a refusal before any Oops. */
const OOPS_SENT = new Set(["oops-failed", "readback-unreadable"]);

type GroupEntry = Extract<UndoEntry, { kind: "group" }>;

export interface UndoArgs {
  count?: unknown;
  preview?: unknown;
}

/** The newest `count` groups, newest first, or why they cannot be undone. */
export function pickGroups(history: ReadonlyArray<UndoEntry>, count: number): { groups: GroupEntry[] } | { error: string } {
  const groups: GroupEntry[] = [];
  for (let i = history.length - 1; i >= 0 && groups.length < count; i--) {
    const e = history[i];
    if (e.kind === "ungrouped") {
      const after = groups.length ? ` after ${groups.length} grouped call(s)` : "";
      return {
        error:
          `the tool call ${e.tool}${after} has no undo group (${e.reason}): Oops would not undo it as one step, so nothing older can be undone safely. ` +
          `Check the console's Oops menu and undo by hand if needed`,
      };
    }
    groups.push(e);
  }
  if (groups.length < count) {
    return {
      error: groups.length
        ? `only ${groups.length} grouped tool call(s) of this server can be undone (asked for ${count})`
        : "no tool call of this server has an undo group to undo (none since it started, or they were undone already)",
    };
  }
  return { groups };
}

interface BridgeUndone {
  id?: string;
  name?: string;
  feedback?: unknown;
  error?: string;
  gone?: boolean;
  /** The read-back after this Oops could not identify every step left in the undo list. */
  unreadable?: boolean;
}

export async function undoTool(ctx: ToolContext, args: UndoArgs): Promise<OperationResult> {
  const op = "undo";
  const countRaw = args.count ?? 1;
  const preview = args.preview === true;
  const target: Record<string, unknown> = { count: countRaw };
  if (typeof countRaw !== "number" || !Number.isInteger(countRaw) || countRaw < 1 || countRaw > MAX_COUNT) {
    return validationFailure(op, target, [`count must be a whole number from 1 to ${MAX_COUNT}`]);
  }
  if (args.preview !== undefined && typeof args.preview !== "boolean") return validationFailure(op, target, ["preview must be true or false"]);
  const undo: UndoGroups | undefined = ctx.undo;
  if (!undo || !undo.enabled) {
    return validationFailure(op, target, [
      "undo groups are off: start the server with GMA3_UNDO_GROUPS=1 so each tool call becomes one console undo group (nothing was sent)",
    ]);
  }
  if (undo.unsupported) return validationFailure(op, target, ["the bridge plugin has no undo groups (needs bridge 0.55.0, gma3_undo 0.56.0); nothing was sent"]);
  // The groups are picked inside the lock, so no tool call of this server can end between the pick and the Oops.
  return ctx.mutations.run(async () => {
    const picked = pickGroups(undo.history, countRaw);
    if ("error" in picked) return validationFailure(op, target, [`${picked.error}; nothing was sent`]);
    const ids = picked.groups.map((g) => g.id);
    const groups = picked.groups.map((g) => ({ id: g.id, tool: g.tool, commands: g.commands, closedAt: g.closedAt }));
    target.groups = groups;
    const name = preview ? "check_latest" : "oops";
    let reply: { undone?: BridgeUndone[]; latestAfter?: unknown } | undefined;
    let step: StepResult;
    try {
      const r = await ctx.bridge.request("undo.undo", { ids, ...(preview ? { preview: true } : {}) }, ctx.requestTimeoutMs);
      reply = (r ?? {}) as typeof reply;
      step = { name, status: "succeeded", op: "undo.undo", detail: r };
    } catch (err) {
      step = stepFromError(name, err, { op: "undo.undo" });
      if (err instanceof BridgeError) {
        if (/unknown op/i.test(err.message)) {
          step = { ...step, status: "failed", kind: "read", error: UNDO_NEEDS_BRIDGE };
        } else if (err.code && !OOPS_SENT.has(err.code)) {
          // A refusal before any Oops was sent: nothing changed.
          step = { ...step, kind: "read", detail: err.detail };
          if ((err.code === "group-gone" || err.code === "unknown-group") && typeof err.detail?.id === "string") undo.forget([err.detail.id]);
        } else if (OOPS_SENT.has(err.code ?? "")) {
          reply = { undone: Array.isArray(err.detail?.undone) ? (err.detail!.undone as BridgeUndone[]) : [] };
          step = { ...step, detail: err.detail };
        }
      }
    }
    // Each Oops is its own step, so a run that stopped half way is partial, not failed.
    const perGroup: StepResult[] | undefined =
      !preview && reply?.undone?.length
        ? reply.undone.map((u) => ({
            name: `oops ${u.name ?? u.id}`,
            // An Oops whose read-back could not be done may have undone the group: unknown, never succeeded.
            status: u.gone === true ? ("succeeded" as const) : u.unreadable === true ? ("unknown" as const) : ("failed" as const),
            op: "undo.undo",
            command: "Oops",
            feedback: typeof u.feedback === "string" ? u.feedback : null,
            ...(u.gone === true ? {} : { error: u.error ?? "the group was still in the console's undo list after its Oops" }),
            detail: { id: u.id },
          }))
        : undefined;
    const steps: StepResult[] = perGroup ?? [step];
    if (preview) {
      return buildResult({
        operation: op,
        target,
        steps,
        verification: { status: "not_requested" },
        summary:
          step.status === "succeeded"
            ? `preview: ${groups.length} group(s) are the console's latest undo steps and would be undone (${groups.map((g) => g.tool).join(", ")}); nothing was sent`
            : undefined,
        extra: { preview: true },
      });
    }
    const undone = Array.isArray(reply?.undone) ? reply!.undone : [];
    const goneIds = undone.filter((u) => u.gone === true && typeof u.id === "string").map((u) => u.id!);
    undo.forget(goneIds);
    let verification: Verification;
    if (undone.some((u) => u.unreadable === true)) {
      verification = {
        status: "unavailable",
        checked: "each group left the console's undo list after its Oops",
        detail: `the undo list could not be read in full after an Oops: ${goneIds.length} of ${ids.length} group(s) read back undone; the unread one stays remembered and no further Oops was sent`,
      };
    } else if (step.status === "succeeded" || undone.length) {
      const allGone = goneIds.length === ids.length;
      verification = {
        status: allGone ? "matched" : "mismatched",
        checked: "each group left the console's undo list after its Oops",
        expected: ids,
        actual: goneIds,
      };
    } else {
      verification = { status: "unavailable", detail: "nothing was read back: the bridge refused before any Oops, or its reply was lost" };
    }
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      summary:
        step.status === "succeeded" && verification.status === "matched"
          ? `undid ${goneIds.length} tool call(s): ${groups.map((g) => g.tool).join(", ")}`
          : undefined,
      extra: { undone, ...(reply?.latestAfter !== undefined ? { latestAfter: reply.latestAfter } : {}) },
    });
  });
}

export const registerUndoTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_undo",
    {
      title: "Undo the last tool calls (console undo groups)",
      description:
        "Undo the last tool call(s) of this server: each was one console undo group (needs GMA3_UNDO_GROUPS=1 and bridge 0.56.0). " +
        "Checks first that the groups are the console's latest undo steps, in order, and refuses when anything was done at the console since, when a later tool call had no group (gma3_load_show, gma3_save_show and gma3_patch_* are never grouped; patch changes and show loads clear the console's undo list) or when groups are off; nothing falls back to a blind Oops. " +
        "Then one Oops per group, each read back. Only commands sent through the command line join a group: property writes, Lua and queued commands are not undone. preview: true checks and sends nothing.",
      inputSchema: {
        count: z.number().int().optional().describe(`How many of the latest grouped tool calls to undo, newest first (1-${MAX_COUNT}, default 1).`),
        preview: z.boolean().optional().describe("Check that the groups can be undone and send nothing."),
      },
    },
    async (args) => operation(() => undoTool(ctx, args as UndoArgs)),
  );
};
