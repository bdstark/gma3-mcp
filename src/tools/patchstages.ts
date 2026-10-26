/**
 * gma3_patch_stages (#97): list, create, rename and remove the patch's stages.
 *
 * In the Halloween 2026 build (live, onPC 2.5.1, 2026-10-25) the plan had one stage per area, "Main Floor", "Basement"
 * and "Outdoors", and no tool made them: a subagent used gma3_lua inside the patch copy, 10 calls in about 35 s.
 * What worked there is what the bridge's patch.stageEdit does: Stages:Ptr(1):Set('Name', ...) renames,
 * Stages:Acquire('Stage') appends "Stage <n>" with its Spaces and Fixtures children (Stages:Create(2) silently did
 * nothing), and ChangeDestination Root commits; LivePatch.Stages then read the three stages.
 *
 * list reads patch.stages from the live patch. Every change runs one patch session (src/tools/patch.ts runSession): the
 * pre-check reads the live stages and refuses before anything is sent, the session enters the copy at the first stage's
 * Fixtures (the entry every patch tool uses), patch.stageEdit changes the copy's Stages, the isolation check leaves out
 * only what the change touches (by stage position: appended or removed stages, and the Name and number of a renamed
 * stage and of the stages that move up after a removal), the commit, and a read-back of LivePatch.Stages.
 *
 * Removing a stage uses Delete on Stages, the call that deletes fixtures and fixture types; it is not verified on a
 * console for stages, so it is kept to empty stages after the first.
 */
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { asRead, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, describe, finiteNumber, objectName } from "../validate.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { EXCLUSIVE_DESC, SESSION_DESC, VERIFY_DESC, requireExclusive, runSession } from "./patch.js";

/** A stage as patch.stages reports it (bridge 0.48.0). */
export interface StageRow {
  index: number;
  no?: number;
  name: string;
  /** "default": an empty Name, or one set to "Stage <no>" (Lua reads both alike, #98); "explicit": any other. */
  nameKind?: "default" | "explicit";
  children?: string[];
  fixturesList?: boolean;
  /** Every fixture under the stage's Fixtures, sub-fixtures included; absent when the list cannot be read. */
  fixtures?: number;
  topLevel?: number;
  otherObjects?: number;
  spacesList?: boolean;
  spaces?: number;
  /** Bridge 0.49.0: a read that raised, kept apart from an absent child (the list flag is then left out). */
  childrenError?: string;
  fixturesError?: string;
  spacesError?: string;
}

export const STAGE_ACTIONS = ["list", "create", "rename", "remove"] as const;
type StageAction = (typeof STAGE_ACTIONS)[number];
const MAX_CREATE = 32;
/** The bridge's limit for names (nameArg). */
const NAME_MAX = 128;
const NEEDS = "bridge 0.48.0";

/**
 * Why a stage cannot be removed (undefined when it can): it must be proven empty, and any read that failed is a
 * refusal, never an absent child (review of #112). A child named Spaces or Fixtures that the bridge could not read as
 * that list is one too: a bridge before 0.49.0 reports a Spaces read that raised as no Spaces list.
 */
export function notEmpty(stage: StageRow): string | undefined {
  const what = `stage ${stage.index} (${JSON.stringify(stage.name)})`;
  if (stage.childrenError) return `${what}: its children cannot be read (${stage.childrenError}), so it is not proven empty`;
  if (stage.fixturesError) return `${what}: its fixtures cannot be read (${stage.fixturesError}), so it is not proven empty`;
  if (stage.spacesError) return `${what}: its Spaces cannot be read (${stage.spacesError}), so it is not proven empty`;
  if (stage.fixtures === undefined) return `${what}: its fixtures cannot be read, so it is not proven empty`;
  if (stage.fixtures > 0) return `${what} holds ${stage.fixtures} fixture(s); only an empty stage is removed (no tool moves fixtures between stages: gma3_patch_remove deletes them)`;
  if ((stage.otherObjects ?? 0) > 0) return `${what} holds ${stage.otherObjects} object(s) that are not fixtures`;
  if (stage.spacesList && stage.spaces === undefined) return `${what}: its Spaces cannot be read, so it is not proven empty`;
  if ((stage.spaces ?? 0) > 0) return `${what} has ${stage.spaces} space(s); only an empty stage is removed`;
  const children = stage.children ?? [];
  const extra = children.filter((c) => c !== "Fixtures" && c !== "Spaces");
  if (extra.length) return `${what} has children besides Fixtures and Spaces (${extra.join(", ")}); it is not removed`;
  if (children.includes("Spaces") && stage.spacesList !== true) return `${what} has a child Spaces that cannot be read as its Spaces list, so it is not proven empty`;
  if (children.includes("Fixtures") && stage.fixturesList !== true) return `${what} has a child Fixtures that cannot be read as its Fixtures list, so it is not proven empty`;
  return undefined;
}

/**
 * A name two stages would share after removing the stage at position k (undefined when none). The stages after it move
 * up a place, and one with a default name then reads "Stage <its new number>", which another stage may have explicitly
 * (review of #112: "Stage 2" explicit, Basement, "Stage 3" unnamed; removing Basement leaves two "Stage 2", and
 * gma3_patch_add on "Stage 2" then finds the first). That the number follows is how the harness models it; not
 * verified live.
 */
export function removalClash(rows: StageRow[], k: number): string | undefined {
  const left = rows
    .filter((r) => r.index !== k)
    .map((r) => {
      const moved = r.index > k && r.nameKind === "default";
      return { row: r, moved, name: moved ? `Stage ${(r.no ?? r.index) - 1}` : r.name };
    });
  for (let a = 0; a < left.length; a++)
    for (let b = a + 1; b < left.length; b++) {
      const x = left[a];
      const y = left[b];
      if ((x.moved || y.moved) && lower(x.name) === lower(y.name)) {
        const [m, o] = x.moved ? [x, y] : [y, x];
        return `removing stage ${k} moves stage ${m.row.index} (${JSON.stringify(m.row.name)}, a default name) up to read ${JSON.stringify(m.name)}, which stage ${o.row.index} ${o.moved ? "would read too" : "is named"}; rename one of them first`;
      }
    }
  return undefined;
}

const lower = (s: string) => s.toLowerCase();

/** A stage given by its position in the list (gma3_patch_stages list's index) or by its name. */
function stageRef(field: string, value: unknown): number | string | undefined {
  if (typeof value === "number") return finiteNumber(field, value, { integer: true, min: 1 });
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new ValidationError(`${field} must be a stage's position (from 1) or its name (got ${describe(value)})`, field);
}

/** The stage a reference names: by position, by exact name, or by the one name that matches ignoring case. */
export function findStage(rows: StageRow[], ref: number | string): StageRow | string {
  const list = rows.map((r) => `${r.index} ${JSON.stringify(r.name)}`).join(", ");
  if (typeof ref === "number") return rows.find((r) => r.index === ref) ?? `no stage at position ${ref} (stages: ${list})`;
  const exact = rows.filter((r) => r.name === ref);
  if (exact.length === 1) return exact[0];
  const loose = rows.filter((r) => lower(r.name) === lower(ref));
  if (exact.length === 0 && loose.length === 1) return loose[0];
  if (exact.length + loose.length > 1) return `more than one stage is named ${JSON.stringify(ref)}; give its position (stages: ${list})`;
  return `no stage named ${JSON.stringify(ref)} (stages: ${list})`;
}

/** A name already used by another stage, ignoring case (the stage `except` may have it, in another case). */
function takenBy(rows: StageRow[], name: string, except?: number): StageRow | undefined {
  return rows.find((r) => r.index !== except && lower(r.name) === lower(name));
}

interface StagesArgs {
  action?: unknown;
  name?: unknown;
  names?: unknown;
  stage?: unknown;
  exclusive?: unknown;
  verify?: unknown;
}

async function readStages(ctx: ToolContext): Promise<StageRow[]> {
  const res = (await ctx.bridge.request("patch.stages", {}, ctx.requestTimeoutMs)) as { stages: StageRow[] };
  return res.stages;
}

const needsBridge = (err: unknown, s: StepResult): StepResult => {
  if (err instanceof BridgeError && /unknown op/.test(err.message)) s.error = `${s.error}: the console runs an older bridge plugin without patch.stages (${NEEDS}); update the plugin`;
  return s;
};

export async function patchStages(ctx: ToolContext, raw: StagesArgs): Promise<OperationResult> {
  const v = new Validator();
  const action = STAGE_ACTIONS.includes(raw.action as StageAction) ? (raw.action as Exclude<StageAction, "list">) : (v.fail(`action must be one of ${STAGE_ACTIONS.join(", ")}`), undefined);
  const op = `patch_stages_${action ?? "change"}`;
  const names: string[] = [];
  let ref: number | string | undefined;
  let newName: string | undefined;
  if (action === "create") {
    if (raw.name !== undefined && raw.names !== undefined) v.fail("give name or names, not both");
    const given = raw.names !== undefined ? raw.names : raw.name !== undefined ? [raw.name] : undefined;
    if (!Array.isArray(given) || given.length === 0) v.fail("create needs name (one stage) or names (a non-empty list)");
    else if (given.length > MAX_CREATE) v.fail(`at most ${MAX_CREATE} stages per call`);
    else
      given.forEach((n, i) => {
        const name = v.check(() => objectName(raw.names !== undefined ? `names[${i}]` : "name", n, { maxLength: NAME_MAX }));
        if (name === undefined) return;
        if (names.some((x) => lower(x) === lower(name))) v.fail(`${JSON.stringify(name)} is given twice (stage names compare ignoring case)`);
        else names.push(name);
      });
  } else if (action === "rename" || action === "remove") {
    ref = raw.stage === undefined ? (v.fail(`${action} needs stage: its position or its name`), undefined) : v.check(() => stageRef("stage", raw.stage));
    if (action === "rename") newName = v.check(() => objectName("name", raw.name, { maxLength: NAME_MAX }));
    else if (raw.name !== undefined || raw.names !== undefined) v.fail("remove takes stage only");
  }
  requireExclusive(v, raw.exclusive);
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { action: raw.action, ...(raw.stage !== undefined ? { stage: raw.stage } : {}), ...(raw.name !== undefined ? { name: raw.name } : {}), ...(raw.names !== undefined ? { names: raw.names } : {}) };
  if (!v.ok || action === undefined) return validationFailure(op, target, v.errors);
  const t = ctx.requestTimeoutMs;
  let before: StageRow[] = [];
  let stage: StageRow | undefined;
  let edited: Record<string, unknown> | undefined;

  const preflight = async (): Promise<StepResult> => {
    try {
      before = await readStages(ctx);
    } catch (err) {
      return needsBridge(err, asRead(stepFromError("check_stages", err, { op: "patch.stages" })));
    }
    const fail = (error: string) => asRead({ name: "check_stages", status: "failed", op: "patch.stages", error, detail: { stages: before } });
    if (action === "create") {
      for (const n of names) {
        const other = takenBy(before, n);
        if (other) return fail(`stage ${other.index} is already named ${JSON.stringify(other.name)}; stage names must be unique (ignoring case)`);
      }
    } else {
      const found = findStage(before, ref!);
      if (typeof found === "string") return fail(found);
      stage = found;
      if (action === "rename") {
        if (stage.name === newName) return fail(`stage ${stage.index} is already named ${JSON.stringify(newName)}; nothing to change`);
        const other = takenBy(before, newName!, stage.index);
        if (other) return fail(`stage ${other.index} is already named ${JSON.stringify(other.name)}; stage names must be unique (ignoring case)`);
      } else {
        const what = `stage ${stage.index} (${JSON.stringify(stage.name)})`;
        if (before.length <= 1) return fail(`the patch has one stage; it cannot be removed`);
        if (stage.index === 1) return fail(`${what} is the first stage, which is not removed (patch sessions and gma3_patch_add default to it)`);
        const why = notEmpty(stage) ?? removalClash(before, stage.index);
        if (why) return fail(why);
      }
    }
    return asRead({ name: "check_stages", status: "succeeded", op: "patch.stages", detail: { stages: before.map((r) => ({ index: r.index, name: r.name, fixtures: r.fixtures })) } });
  };

  const editArgs = (): Record<string, unknown> =>
    action === "create" ? { action, names } : action === "rename" ? { action, index: stage!.index, expect: stage!.name, name: newName } : { action, index: stage!.index, expect: stage!.name };

  /** Stage positions the isolation check leaves out or compares bare, per side (before: the live patch's count). */
  const isolation = () => {
    const n = before.length;
    const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
    if (action === "create") return { stages: { excludeCopy: range(n + 1, n + names.length) } };
    if (action === "rename") return { stages: { bareLive: [stage!.index], bareCopy: [stage!.index] } };
    const k = stage!.index;
    return { stages: { excludeLive: [k], bareLive: range(k + 1, n), bareCopy: range(k, n - 1) } };
  };

  const readBack = async (): Promise<{ steps: StepResult[]; verification: Verification; extra?: Record<string, unknown> }> => {
    let after: StageRow[];
    try {
      after = await readStages(ctx);
    } catch (err) {
      return { steps: [asRead(stepFromError("read_back", err, { op: "patch.stages" }))], verification: unavailable("the stages could not be read back") };
    }
    const step = asRead({ name: "read_back", status: "succeeded", op: "patch.stages", detail: after });
    const shown = (r: { name: string; nameKind?: string }) => (r.nameKind === "default" ? "<default name>" : r.name);
    // Names as expected, in order: a default name reads "Stage <no>", which follows the stage's number when stages move.
    let expected: Array<{ name: string; nameKind?: string }>;
    let checked: string;
    if (action === "create") {
      expected = [...before, ...names.map((name) => ({ name, nameKind: "explicit" }))];
      checked = `the live patch has the ${before.length} stage(s) from before, then ${names.map((x) => JSON.stringify(x)).join(", ")}`;
    } else if (action === "rename") {
      expected = before.map((r) => (r.index === stage!.index ? { name: newName!, nameKind: "explicit" } : r));
      checked = `stage ${stage!.index} is named ${JSON.stringify(newName)} and the other stages are unchanged`;
    } else {
      expected = before.filter((r) => r.index !== stage!.index);
      checked = `stage ${JSON.stringify(stage!.name)} is gone and the other stages are in order`;
    }
    const mismatches: string[] = [];
    // A count that could not be read is not checked, and says so: never taken for an equal one (review of #112).
    const notChecked: string[] = [];
    if (after.length !== expected.length) mismatches.push(`the live patch has ${after.length} stage(s), expected ${expected.length}`);
    expected.forEach((e, i) => {
      const a = after[i];
      if (!a) return;
      const ok = e.nameKind === "default" ? a.nameKind === "default" || a.name === e.name : a.name === e.name;
      if (!ok) mismatches.push(`stage ${i + 1}: ${JSON.stringify(a.name)}, expected ${e.nameKind === "default" ? "its default name" : JSON.stringify(e.name)}`);
    });
    // The fixtures of every stage that was there before stay where they were.
    const kept = action === "remove" ? before.filter((r) => r.index !== stage!.index) : before;
    kept.forEach((r, i) => {
      const a = after[i];
      if (!a) return;
      if (r.fixtures === undefined || a.fixtures === undefined) notChecked.push(`the fixture count of stage ${i + 1} (${JSON.stringify(a.name)}; unreadable ${r.fixtures === undefined ? "before the session" : "in the read-back"})`);
      else if (a.fixtures !== r.fixtures) mismatches.push(`stage ${i + 1} (${JSON.stringify(a.name)}): ${a.fixtures} fixture(s), ${r.fixtures} before`);
    });
    // New stages are empty.
    if (action === "create")
      after.slice(before.length).forEach((a) => {
        if (a.fixtures === undefined) notChecked.push(`the fixture count of new stage ${a.index} (${JSON.stringify(a.name)}; unreadable)`);
        else if (a.fixtures !== 0) mismatches.push(`new stage ${a.index} (${JSON.stringify(a.name)}): ${a.fixtures} fixture(s), expected none`);
      });
    // No two stages share a name (a default name that moved up can read another stage's name).
    after.forEach((a, i) => {
      const twin = after.findIndex((b, j) => j > i && lower(b.name) === lower(a.name));
      if (twin >= 0) mismatches.push(`stages ${a.index} and ${after[twin].index} are both named ${JSON.stringify(a.name)}`);
    });
    const exp = expected.map(shown);
    const act = after.map(shown);
    return {
      steps: [step],
      verification: mismatches.length
        ? { status: "mismatched", checked, expected: exp, actual: act, detail: mismatches.join("; ") + (notChecked.length ? `; not checked: ${notChecked.join(", ")}` : "") }
        : notChecked.length
          ? { ...unavailable(`not checked: ${notChecked.join(", ")} (the names matched)`, checked), expected: exp, actual: act }
          : { status: "matched", checked, expected: exp, actual: act },
      extra: { stages: after },
    };
  };

  return runSession(ctx, {
    operation: op,
    target,
    touchedFids: [],
    verify,
    preflight,
    editName: `${action}_stage${action === "create" && names.length > 1 ? "s" : ""}`,
    edit: () => ({ op: "patch.stageEdit", args: editArgs() }),
    onEdit: (detail) => {
      const d = detail as Record<string, unknown> | undefined;
      edited = d ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "stages")) : undefined;
    },
    isolation,
    extra: () => ({ ...(before.length ? { before: before.map((r) => ({ index: r.index, name: r.name, nameKind: r.nameKind, fixtures: r.fixtures })) } : {}), ...(edited ? { edit: edited } : {}) }),
    readBack,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerPatchStagesTool: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_patch_stages",
    {
      title: "List, create, rename and remove patch stages",
      description:
        'Stages (areas of the venue, e.g. "Main Floor", "Basement"; gma3_patch_add takes one by name). action "list" (read-only, the live patch): each stage\'s index (its position), number, name and nameKind ("default": an empty Name or one set to "Stage <no>", which read alike; "explicit": any other), fixtures (all, sub-fixtures included) and topLevel, whether it has a Spaces list and how many spaces. ' +
        '"create" {name} or {names: [...]}: appends stages (Acquire, then Name; the bridge deletes what it appended on any problem). "rename" {stage, name}. "remove" {stage}: only an empty stage (no fixtures, no spaces) and never the first or the only one; stages after it move up a place, and one with a default name then reads its new number (refused when that is another stage\'s name; an unreadable Fixtures, Spaces or children list is a refusal too). stage: the index or the name. ' +
        'Names: no characters the console strips (" . , and the like), trimmed, unique among the stages ignoring case (a stage may change the case of its own name). Pre-checks (nothing sent on failure) read the live stages. ' +
        SESSION_DESC +
        ` The isolation check leaves out only the stages the change touches (appended or removed ones, and the Name and number of a renamed stage and of those moving up). verify reads the stages back from the live patch: names in order, no two alike, and every stage's fixture count (an unreadable count makes it unavailable, not matched). Removing uses Delete on Stages, not verified on a console yet. Needs ${NEEDS}; the bridge's own re-check of a removal (unreadable lists, a name clash) needs bridge 0.49.0.`,
      inputSchema: {
        action: z.enum(STAGE_ACTIONS).describe('"list" (read-only), "create", "rename" or "remove".'),
        name: z.string().optional().describe("create: the new stage's name; rename: the new name."),
        names: z.array(z.string()).optional().describe(`create: several new stages at once (1-${MAX_CREATE}), in order.`),
        stage: z.union([z.number(), z.string()]).optional().describe("rename / remove: the stage's index (position, from list) or its name."),
        exclusive: z.boolean().optional().describe(EXCLUSIVE_DESC + " Not needed for list."),
        verify: z.boolean().optional().describe(VERIFY_DESC),
      },
    },
    async (args) => {
      if (args.action === "list") {
        try {
          const res = await ctx.bridge.request("patch.stages", {}, ctx.requestTimeoutMs);
          return json(res);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: /unknown op/.test(message) ? `${message}: the console runs an older bridge plugin without patch.stages (${NEEDS}); update the plugin` : message }], isError: true };
        }
      }
      return operation(() => patchStages(ctx, args as StagesArgs));
    },
  );
};
