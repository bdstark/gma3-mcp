/**
 * #149 gma3_patch_import_mvr: patch and place the fixtures of an MVR file (a venue plan from a CAD program or a
 * visualiser) with the structured patch tools, after checking all of it up front.
 *
 * grandMA3 2.5.1 imports MVR only through Partial Show Read (the Show Creator menu: preparation, a grid of choices,
 * Finish), which is dialog driven and, in RoyX4's lab qualification (docs/probes/g25-mvr-positions-native-2.5.1.1.md
 * in that fork), changed the DmxCurves collection of the show it read into. This tool therefore reads the file here and
 * uses the tools that already check and read back:
 *
 *   read    read_file, parse_mvr      the zip, GeneralSceneDescription.xml and the GDTFs it holds (src/mvr.ts)
 *   read    check_mvr                 per fixture: a fixture number, one DMX break, its GDTF and mode, a usable matrix
 *   read    check_console             stages (patch.state), fixture types (patch.types): the show's type for each GDTF
 *                                     (by manufacturer and name, or the types override), else it is imported
 *   read    check_patch               patch.check { ranges } (bridge 0.58.0): every FID free, every DMX range free of the
 *                                     live patch and of the other fixtures (a range whose footprint is only known after
 *                                     the import is checked again then)
 *   read    check_library             patch.libraryStat for each GDTF to import
 *   ---     preview stops here; otherwise, stopping at the first failure:
 *   mut.    library_add, import_type  gma3_patch_library_add + gma3_patch_import per GDTF the show does not have
 *   read    recheck_patch             every planned range again, with the imported types' footprints from the console
 *   mut.    add                       gma3_patch_add per block (same type, mode and stage, consecutive FIDs and addresses)
 *   mut.    name                      gma3_patch_set: the MVR names (characters the console strips are removed)
 *   mut.    place                     gma3_place_fixtures: positions and rotations (metres, degrees)
 *
 * Every sub-call checks, commits and reads back on its own (and takes this server's mutation lock); the result lists
 * each with its outcome and read-back. Layers are not stages: fixtures go to `stage` (or `layer_stages` per layer), or
 * the stage gma3_patch_add uses by default. Scene objects other than fixtures (trusses, scenery) are not imported.
 */
import { readFile, stat } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { z } from "zod";
import { MVR_MAX_BYTES, MVR_MAX_FIXTURES, parseMvr, type MvrFixture, type MvrGdtf, type MvrScene, type Vec3 } from "../mvr.js";
import { progressSteps } from "../progress.js";
import { asRead, buildResult, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { NAME_FORBIDDEN_CHARS } from "../validate.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { checkStateStep, matchingTypes, patchAdd, patchImport, patchSet, sameName, type TypeRow } from "./patch.js";
import { decodeBase64, libraryFileName, patchLibraryAdd } from "./patchlibrary.js";
import { placeFixtures } from "./positions.js";

export type SubTool = (ctx: ToolContext, raw: Record<string, unknown>) => Promise<OperationResult>;
/** The structured tools the import runs; tests replace them. */
export interface MvrDeps {
  libraryAdd: SubTool;
  importType: SubTool;
  add: SubTool;
  set: SubTool;
  place: SubTool;
}
export const DEFAULT_DEPS: MvrDeps = {
  libraryAdd: patchLibraryAdd as unknown as SubTool,
  importType: patchImport as unknown as SubTool,
  add: patchAdd as unknown as SubTool,
  set: patchSet as unknown as SubTool,
  place: placeFixtures as unknown as SubTool,
};

export interface MvrImportArgs {
  path?: string;
  content_base64?: string;
  layers?: string[];
  stage?: string;
  layer_stages?: Record<string, string>;
  types?: Record<string, number | string>;
  names?: boolean;
  place?: boolean;
  skip_unusable?: boolean;
  preview?: boolean;
  exclusive?: boolean;
  verify?: boolean;
  detail?: boolean;
}

const NEEDS_BRIDGE = "the console runs an older bridge plugin without patch.check ranges (bridge 0.58.0); update the plugin";
/** Per sub-call: gma3_patch_add takes 256 fixtures, gma3_patch_set 256 edits, gma3_place_fixtures 256 fixtures. */
const CHUNK = 256;
const MAX_LISTED = 25;
/** The longest name the bridge's patch.set accepts, in UTF-8 bytes (nameArg in the bridge plugin). */
export const NAME_MAX_BYTES = 128;
const NAME_STRIP = new RegExp(`[${NAME_FORBIDDEN_CHARS.replace(/[\\\]^-]/g, "\\$&")}]`, "g");

/** A fixture name the console keeps: the characters it strips removed, spaces collapsed; "" when nothing is left. */
export function consoleName(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f]/g, " ").replace(NAME_STRIP, "").replace(/\s+/g, " ").trim();
  // The bridge takes at most NAME_MAX_BYTES bytes of UTF-8 (nameArg): cut at a whole character (review of #162).
  let out = "";
  let bytes = 0;
  for (const ch of clean) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > NAME_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out.trim();
}

/** The user-library file name a GDTF goes in as: manufacturer@name[@revision].gdtf from its own FixtureType. */
export function gdtfLibraryName(g: MvrGdtf): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*@\x00-\x1f\x7f]/g, "").replace(/\s+/g, "_").replace(/^\.+/, "").replace(/\.\.+/g, ".").slice(0, 80);
  let revision: string | undefined;
  try {
    revision = libraryFileName((g.entry ?? g.spec).split("/").pop()).revision;
  } catch {
    revision = undefined;
  }
  const man = clean(g.header?.manufacturer ?? "") || "Unknown";
  const model = clean(g.header?.name ?? "") || clean(g.spec.replace(/\.gdtf$/i, "")) || "Fixture";
  const rev = revision ? clean(revision) : "";
  return `${man}@${model}${rev ? `@${rev}` : ""}.gdtf`;
}

/** One fixture to patch. */
export interface PlannedFixture {
  fixture: MvrFixture;
  fid: number;
  stage?: string;
  spec: string;
  mode: string;
  address?: string;
  name: string;
  /** The show's type (number) once known. */
  typeNo?: number;
  footprint?: number | null;
}

interface TypePlan {
  spec: string;
  gdtf: MvrGdtf;
  /** The show already has it: its number. */
  existing?: TypeRow;
  /** To import: the user-library file. */
  file?: string;
  /** The user library already holds exactly these bytes: only the import is needed. */
  inLibrary?: boolean;
  /** Another GDTF of the file with the same bytes: that one's import is used (no file of its own). */
  sameAs?: string;
}

const addressAbs = (a: string) => {
  const [u, d] = a.split(".").map(Number);
  return (u - 1) * 512 + (d - 1);
};

/** Blocks for gma3_patch_add: same type, mode and stage, consecutive FIDs, and consecutive addresses (or all unpatched). */
export function blocksOf(fixtures: PlannedFixture[]): PlannedFixture[][] {
  const sorted = [...fixtures].sort((a, b) => a.fid - b.fid);
  const out: PlannedFixture[][] = [];
  for (const f of sorted) {
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    const joins =
      prev !== undefined &&
      cur.length < CHUNK &&
      prev.typeNo === f.typeNo &&
      prev.mode === f.mode &&
      prev.stage === f.stage &&
      f.fid === prev.fid + 1 &&
      ((prev.address === undefined && f.address === undefined) ||
        (prev.address !== undefined &&
          f.address !== undefined &&
          typeof prev.footprint === "number" &&
          addressAbs(f.address) === addressAbs(prev.address) + prev.footprint &&
          Math.floor(addressAbs(f.address) / 512) === Math.floor(addressAbs(cur[0].address as string) / 512)));
    if (joins) cur.push(f);
    else out.push([f]);
  }
  return out;
}

const list = (items: string[]) => (items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join("; ")}; and ${items.length - MAX_LISTED} more` : items.join("; "));

interface RangesReply {
  fids: Array<{ fid: number; free: boolean }>;
  conflicts: Array<{ fid: number; range?: string; with?: number | string; withName?: string; withRange?: string; reason?: string }>;
  occupancyUnknown: Array<{ fid: number | string; reason: string }>;
}

function conflictText(c: RangesReply["conflicts"][number]): string {
  if (c.reason && c.with === undefined) return `FID ${c.fid} ${c.range ?? ""}: ${c.reason}`;
  return `FID ${c.fid} ${c.range ?? ""} overlaps ${c.reason === "two requested ranges overlap" ? "MVR fixture" : "patched fixture"} ${c.with}${c.withName ? ` "${c.withName}"` : ""} ${c.withRange ?? ""}`.replace(/\s+/g, " ").trim();
}

/** Ranges of fixtures with a known footprint, for patch.check { ranges }. */
const rangesOf = (fx: PlannedFixture[]) => fx.map((p) => ({ fid: p.fid, ...(p.address !== undefined && typeof p.footprint === "number" ? { address: p.address, footprint: p.footprint } : {}) }));

function subStep(name: string, tool: string, res: OperationResult, extra: Record<string, unknown>, detail: boolean): StepResult {
  const status: StepResult["status"] = res.outcome === "succeeded" ? "succeeded" : res.outcome === "failed" ? "failed" : "unknown";
  return {
    name,
    status,
    op: tool,
    ...(status !== "succeeded" ? { error: res.outcome === "partial" ? `${tool} partially completed: ${res.summary}` : res.summary } : {}),
    detail: { ...extra, outcome: res.outcome, verification: res.verification.status, summary: res.summary, ...(res.warnings?.length ? { warnings: res.warnings } : {}), ...(detail ? { result: res } : {}) },
  };
}

export async function mvrImport(ctx: ToolContext, raw: MvrImportArgs, deps: MvrDeps = DEFAULT_DEPS): Promise<OperationResult> {
  const op = "patch_import_mvr";
  const errors: string[] = [];
  const hasPath = raw.path !== undefined;
  const hasContent = raw.content_base64 !== undefined;
  if (hasPath === hasContent) errors.push("give exactly one of path (an .mvr file on the MCP server's host) or content_base64 (its bytes)");
  if (hasPath && (typeof raw.path !== "string" || raw.path === "")) errors.push("path must be a file path");
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) errors.push("exclusive: true is required (it confirms nobody else uses the console while the import runs); preview: true needs none");
  if (raw.layers !== undefined && (!Array.isArray(raw.layers) || raw.layers.length === 0)) errors.push("layers must be a non-empty list of MVR layer names");
  const verify = raw.verify !== false;
  const detail = raw.detail === true;
  const target: Record<string, unknown> = { ...(hasPath ? { path: raw.path } : { content: "base64" }), ...(raw.layers ? { layers: raw.layers } : {}), ...(raw.stage ? { stage: raw.stage } : {}), preview };
  if (errors.length) return validationFailure(op, target, errors);

  const steps: StepResult[] = [];
  const warnings: string[] = [];
  const stop = (step: StepResult, extra: Record<string, unknown> = {}) => {
    steps.push(step);
    return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed"), warnings, extra });
  };

  // 1. The file.
  let bytes: Buffer;
  try {
    if (hasPath) {
      const st = await stat(raw.path as string);
      if (!st.isFile()) return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} is not a file` }));
      if (st.size > MVR_MAX_BYTES) return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} has ${st.size} bytes; the limit is ${MVR_MAX_BYTES}` }));
      bytes = await readFile(raw.path as string);
    } else {
      if (typeof raw.content_base64 !== "string" || raw.content_base64.replace(/\s+/g, "").length > Math.ceil(MVR_MAX_BYTES / 3) * 4) return stop(asRead({ name: "read_file", status: "failed", error: `content_base64 must be the file's bytes, at most ${MVR_MAX_BYTES} bytes` }));
      bytes = decodeBase64(raw.content_base64);
    }
    steps.push(asRead({ name: "read_file", status: "succeeded", detail: { size: bytes.length } }));
  } catch (err) {
    return stop(asRead({ name: "read_file", status: "failed", error: `the file cannot be read: ${(err as Error).message}` }));
  }
  let scene: MvrScene;
  try {
    scene = parseMvr(bytes);
  } catch (err) {
    return stop(asRead({ name: "parse_mvr", status: "failed", error: `the file is not a usable MVR: ${(err as Error).message}` }));
  }
  steps.push(asRead({ name: "parse_mvr", status: "succeeded", detail: { version: scene.version, provider: scene.provider ?? null, layers: scene.layers, fixtures: scene.fixtures.length, gdtfs: [...scene.gdtfs.keys()], otherObjects: scene.otherObjects } }));
  if (Object.keys(scene.otherObjects).length) warnings.push(`scene objects other than fixtures are not imported: ${Object.entries(scene.otherObjects).map(([k, n]) => `${n} ${k}`).join(", ")}`);

  // 2. Which fixtures, and what is wrong with each.
  const unknownLayers = (raw.layers ?? []).filter((l) => !scene.layers.includes(l));
  const unknownStageLayers = Object.keys(raw.layer_stages ?? {}).filter((l) => !scene.layers.includes(l));
  if (unknownLayers.length || unknownStageLayers.length) return stop(asRead({ name: "check_mvr", status: "failed", error: `the MVR has no layer ${[...unknownLayers, ...unknownStageLayers].map((l) => JSON.stringify(l)).join(", ")}; its layers: ${scene.layers.map((l) => JSON.stringify(l)).join(", ")}` }));
  const chosen = scene.fixtures.filter((f) => raw.layers === undefined || raw.layers.includes(f.layer));
  if (chosen.length === 0) return stop(asRead({ name: "check_mvr", status: "failed", error: "the MVR has no fixtures in the chosen layers" }));
  if (chosen.length > MVR_MAX_FIXTURES) return stop(asRead({ name: "check_mvr", status: "failed", error: `${chosen.length} fixtures; at most ${MVR_MAX_FIXTURES} per call (choose layers)` }));
  const problems = new Map<MvrFixture, string[]>();
  const flag = (f: MvrFixture, why: string) => problems.set(f, [...(problems.get(f) ?? []), why]);
  const label = (f: MvrFixture) => `${f.fid !== undefined ? `FID ${f.fid}` : `"${f.name}"`}${f.fid !== undefined && f.name ? ` "${f.name}"` : ""}`;
  const byFid = new Map<number, MvrFixture>();
  for (const f of chosen) {
    for (const p of f.problems) flag(f, p);
    if (f.fid === undefined) flag(f, `no fixture number (FixtureIDNumeric or a numeric FixtureID${f.fixtureId ? `; FixtureID is "${f.fixtureId}"` : ""})`);
    else if (byFid.has(f.fid)) {
      flag(f, `fixture number ${f.fid} is also used by "${byFid.get(f.fid)?.name}"`);
      flag(byFid.get(f.fid) as MvrFixture, `fixture number ${f.fid} is also used by "${f.name}"`);
    } else byFid.set(f.fid, f);
    if (f.addresses.length > 1) flag(f, `${f.addresses.length} DMX breaks; multi-break fixtures are not supported`);
    if (!f.gdtfSpec) flag(f, "no GDTFSpec");
    else {
      const g = scene.gdtfs.get(f.gdtfSpec);
      if (g?.problem && raw.types?.[f.gdtfSpec] === undefined) flag(f, g.problem);
    }
    if (!f.gdtfMode) flag(f, "no GDTFMode");
  }

  // 3. The console: a patch session can start (the copy closed, the command line at Root, no modal: the patch tools'
  // own check_state, before anything is uploaded; review of #162), its stages and fixture types.
  const t = ctx.requestTimeoutMs;
  const ready = await checkStateStep(ctx.bridge, t);
  if (ready.status !== "succeeded") return stop({ ...ready, error: `a patch session cannot start: ${ready.error ?? "patch.state cannot be read"}` });
  steps.push(ready);
  let stages: string[];
  let types: TypeRow[];
  try {
    stages = ((ready.detail as { stages?: string[] } | undefined)?.stages ?? []) as string[];
    types = ((await ctx.bridge.request("patch.types", {}, t)) as { types: TypeRow[] }).types;
  } catch (err) {
    return stop(asRead(stepFromError("check_console", err, { op: "patch.types" })));
  }
  // A stage named in the call, as the show spells it: gma3_patch_add enters it by its exact name (review of #162).
  const stageNames = new Map<string, string>();
  const missingStages: string[] = [];
  const ambiguousStages: string[] = [];
  for (const want of new Set([raw.stage, ...Object.values(raw.layer_stages ?? {})].filter((x): x is string => typeof x === "string"))) {
    const exact = stages.filter((x) => x === want);
    const loose = exact.length ? exact : stages.filter((x) => sameName(x, want));
    if (loose.length === 1) stageNames.set(want, loose[0]);
    else if (loose.length === 0) missingStages.push(want);
    else ambiguousStages.push(`${JSON.stringify(want)} (${loose.map((x) => JSON.stringify(x)).join(", ")})`);
  }
  if (missingStages.length || ambiguousStages.length)
    return stop(asRead({ name: "check_console", status: "failed", op: "patch.state", error: [missingStages.length ? `the show has no stage ${missingStages.map((x) => JSON.stringify(x)).join(", ")} (its stages: ${stages.map((x) => JSON.stringify(x)).join(", ")}); create it with gma3_patch_stages` : "", ambiguousStages.length ? `more than one stage matches ${ambiguousStages.join(", ")}: give the exact name` : ""].filter(Boolean).join("; ") }));
  const stageFor = (f: MvrFixture) => {
    const want = raw.layer_stages?.[f.layer] ?? raw.stage;
    return want === undefined ? undefined : stageNames.get(want);
  };

  const typePlans = new Map<string, TypePlan>();
  const typeProblem = new Map<string, string>();
  for (const spec of new Set(chosen.map((f) => f.gdtfSpec).filter((s) => s !== ""))) {
    const g = scene.gdtfs.get(spec) as MvrGdtf;
    const override = raw.types?.[spec];
    if (override !== undefined) {
      const hit = types.filter((x) => (typeof override === "number" ? x.no === override : sameName(x.name, override)));
      if (hit.length !== 1) typeProblem.set(spec, `types["${spec}"] = ${JSON.stringify(override)} names ${hit.length ? `${hit.length} fixture types` : "no fixture type"} in the show`);
      else typePlans.set(spec, { spec, gdtf: g, existing: hit[0] });
      continue;
    }
    if (g.problem || !g.header) continue;
    const hit = matchingTypes(types, { manufacturer: g.header.manufacturer, model: g.header.name ?? "", name: g.header.name });
    if (hit.length > 1) typeProblem.set(spec, `the show has ${hit.length} types matching ${g.header.manufacturer ?? "?"} / ${g.header.name} (${hit.map((x) => `${x.no} "${x.name}"`).join(", ")}): name one with types["${spec}"]`);
    else if (hit.length === 1) typePlans.set(spec, { spec, gdtf: g, existing: hit[0] });
    else typePlans.set(spec, { spec, gdtf: g, file: gdtfLibraryName(g) });
  }
  // Two GDTFs of the file for one fixture type (manufacturer and name): after the first import the second would be
  // refused as a duplicate (review of #162). The same bytes share one import; different revisions are refused here.
  const identity = (h: MvrGdtf["header"]) => [h?.manufacturer, h?.name].map((x) => (x ?? "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim()).join("\u0000");
  const byIdentity = new Map<string, TypePlan[]>();
  for (const p of typePlans.values()) if (p.file !== undefined) byIdentity.set(identity(p.gdtf.header), [...(byIdentity.get(identity(p.gdtf.header)) ?? []), p]);
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    const sums = new Set(group.map((p) => `${p.gdtf.bytes?.length}:${crc32(p.gdtf.bytes as Buffer)}`));
    if (sums.size === 1) {
      for (const p of group.slice(1)) {
        p.sameAs = group[0].spec;
        delete p.file;
      }
    } else {
      const h = group[0].gdtf.header;
      for (const p of group) typeProblem.set(p.spec, `the MVR holds ${group.length} different GDTFs of ${h?.manufacturer ?? "?"} / ${h?.name ?? "?"} (${group.map((x) => x.spec).join(", ")}) and only one can be imported: import the one wanted (gma3_patch_library_add, gma3_patch_import) and name it with types for each`);
    }
  }
  // Different types whose names clean to the same library file ("Spot/A" and "SpotA"): the second upload would find the
  // first's file (review of #162). Each of those files gets the GDTF's CRC-32 as its revision part.
  const byFile = new Map<string, TypePlan[]>();
  for (const p of typePlans.values()) if (p.file !== undefined) byFile.set(p.file.toLowerCase(), [...(byFile.get(p.file.toLowerCase()) ?? []), p]);
  for (const group of byFile.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      const sum = crc32(p.gdtf.bytes as Buffer).toString(16).padStart(8, "0");
      const m = /^(.*?)@(.*?)(?:@(.*))?\.gdtf$/.exec(p.file as string);
      p.file = m ? `${m[1]}@${m[2]}@${m[3] ? `${m[3]}_` : ""}${sum}.gdtf` : p.file;
    }
    warnings.push(`${group.map((p) => p.spec).join(", ")} would share one library file name; they go in as ${group.map((p) => p.file).join(", ")}`);
  }
  /** The GDTF specs an import serves: its own and those that share its bytes. */
  const serves = (p: TypePlan, spec: string) => spec === p.spec || typePlans.get(spec)?.sameAs === p.spec;

  const planned: PlannedFixture[] = [];
  for (const f of chosen) {
    const tp = typePlans.get(f.gdtfSpec);
    const tprob = typeProblem.get(f.gdtfSpec);
    if (tprob) flag(f, tprob);
    let mode = f.gdtfMode;
    let footprint: number | null | undefined;
    if (tp?.existing) {
      const m = tp.existing.modes.find((x) => x.name === f.gdtfMode) ?? tp.existing.modes.find((x) => sameName(x.name, f.gdtfMode));
      if (!m) flag(f, `the show's type ${tp.existing.no} "${tp.existing.name}" has no mode "${f.gdtfMode}" (its modes: ${tp.existing.modes.map((x) => x.name).join(", ")})`);
      else {
        mode = m.name;
        footprint = m.footprint ?? null;
        if ((m.breaks ?? 1) > 1) flag(f, `mode "${m.name}" has ${m.breaks} DMX breaks; multi-break modes are not supported`);
      }
    } else if (tp?.gdtf.header) {
      const modes = tp.gdtf.header.modes;
      const m = modes.find((x) => x === f.gdtfMode) ?? modes.find((x) => sameName(x, f.gdtfMode));
      if (!m) flag(f, `${tp.gdtf.entry ?? tp.spec} has no DMX mode "${f.gdtfMode}" (its modes: ${modes.join(", ")})`);
      else {
        mode = m;
        footprint = tp.gdtf.footprints[m] ?? null;
        if ((tp.gdtf.breaks[m] ?? 1) > 1) flag(f, `mode "${m}" has ${tp.gdtf.breaks[m]} DMX breaks; multi-break modes are not supported`);
      }
    }
    if (f.fid === undefined) continue;
    planned.push({ fixture: f, fid: f.fid, ...(stageFor(f) ? { stage: stageFor(f) } : {}), spec: f.gdtfSpec, mode, ...(f.addresses[0] ? { address: f.addresses[0].address } : {}), name: consoleName(f.name), ...(tp?.existing ? { typeNo: tp.existing.no } : {}), footprint });
  }

  // 4. FIDs and DMX ranges against the live patch (and each other).
  const checkRanges = async (name: string, fx: PlannedFixture[]): Promise<StepResult> => {
    try {
      const r = (await ctx.bridge.request("patch.check", { ranges: rangesOf(fx) }, t)) as RangesReply;
      if (!Array.isArray(r?.fids) || !Array.isArray(r?.conflicts)) return asRead({ name, status: "failed", op: "patch.check", error: NEEDS_BRIDGE });
      const byFidPlan = new Map(fx.map((p) => [p.fid, p]));
      for (const x of r.fids) if (!x.free && byFidPlan.has(x.fid)) flag(byFidPlan.get(x.fid)!.fixture, `FID ${x.fid} is taken in the show`);
      for (const c of r.conflicts) if (byFidPlan.has(c.fid)) flag(byFidPlan.get(c.fid)!.fixture, conflictText(c));
      const unknown = r.occupancyUnknown ?? [];
      const unchecked = fx.filter((p) => p.address !== undefined && typeof p.footprint !== "number").map((p) => p.fid);
      const detailOut = { fixtures: fx.length, conflicts: r.conflicts.length, taken: r.fids.filter((x) => !x.free).length, ...(unchecked.length ? { footprintUnknownUntilImport: unchecked } : {}), ...(unknown.length ? { occupancyUnknown: unknown } : {}) };
      // Only a fixture with an address needs free DMX; an unpatched rig is not stopped by an unreadable patched fixture
      // (patch_add checks occupancy only with an address too; review of #162).
      if (unknown.length && fx.some((p) => p.address !== undefined)) return asRead({ name, status: "failed", op: "patch.check", error: `the DMX occupancy of ${unknown.length} patched fixture(s) cannot be established (FID ${unknown[0].fid}: ${unknown[0].reason}), so free ranges cannot be proven`, detail: detailOut });
      return asRead({ name, status: "succeeded", op: "patch.check", detail: detailOut });
    } catch (err) {
      const s = asRead(stepFromError(name, err, { op: "patch.check" }));
      if (/unknown op|needs add, edits or fids/.test(String(s.error))) s.error = NEEDS_BRIDGE;
      return s;
    }
  };
  // Fixtures already found unusable are never patched: their ranges would only make usable ones look taken (review of #162).
  const rangeStep = await checkRanges("check_patch", planned.filter((p) => !problems.has(p.fixture)));
  if (rangeStep.status !== "succeeded") return stop(rangeStep);
  steps.push(rangeStep);

  // 5. The user library, for the GDTFs to import.
  const toImport = [...typePlans.values()].filter((p) => p.file !== undefined && chosen.some((f) => serves(p, f.gdtfSpec) && !problems.has(f)));
  for (const p of toImport) {
    try {
      const st = (await ctx.bridge.request("patch.libraryStat", { file: p.file }, t)) as { exists: boolean; size?: number; crc32?: string; listedIn?: string[]; matches?: Array<{ source: string; file: string }> };
      const elsewhere = (st.listedIn ?? []).filter((s) => s !== "user");
      // A library file differing only in case is the same file on macOS and Windows; gma3_patch_library_add refuses it,
      // so it is this GDTF's problem before anything is uploaded (review of #162).
      const caseOnly = (st.matches ?? []).filter((m) => m.file !== p.file);
      const sum = crc32(p.gdtf.bytes as Buffer).toString(16).padStart(8, "0");
      const why = elsewhere.length
        ? `${p.file} is already in the ${elsewhere.join(", ")} library; import it from there and name the type with types["${p.spec}"]`
        : caseOnly.length
          ? `${p.file} differs only in case from ${caseOnly.map((m) => `${m.file} (${m.source})`).join(", ")}, which the library cannot hold apart; import that one and name the type with types["${p.spec}"]`
          : st.exists && !(st.size === p.gdtf.bytes?.length && st.crc32 === sum)
          ? `the user library already has a different ${p.file}; import that one and name the type with types["${p.spec}"], or remove it`
          : undefined;
      if (why) for (const f of chosen) if (serves(p, f.gdtfSpec)) flag(f, why);
      p.inLibrary = st.exists && !why;
    } catch (err) {
      return stop(asRead(stepFromError("check_library", err, { op: "patch.libraryStat" })));
    }
  }
  if (toImport.length) steps.push(asRead({ name: "check_library", status: "succeeded", op: "patch.libraryStat", detail: toImport.map((p) => ({ spec: p.spec, file: p.file, inLibrary: p.inLibrary === true })) }));

  // 6. Refuse, or leave out what cannot be imported.
  const bad = chosen.filter((f) => problems.has(f));
  const problemList = bad.map((f) => `${label(f)}: ${(problems.get(f) as string[]).join(", ")}`);
  if (bad.length && raw.skip_unusable !== true) {
    steps.push(asRead({ name: "check_mvr", status: "failed", error: `${bad.length} of ${chosen.length} fixture(s) cannot be imported as they are: ${list(problemList)}. Fix the file, or pass skip_unusable: true to import the others`, detail: { problems: problemList } }));
    return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed"), warnings });
  }
  if (bad.length) warnings.push(`left out (skip_unusable): ${list(problemList)}`);
  const go = planned.filter((p) => !problems.has(p.fixture));
  if (go.length === 0) return stop(asRead({ name: "check_mvr", status: "failed", error: "no fixture is left to import" }));
  steps.push(asRead({ name: "check_mvr", status: "succeeded", detail: { fixtures: go.length, leftOut: bad.length } }));
  const renamed = go.filter((p) => p.name !== p.fixture.name).map((p) => `FID ${p.fid} "${p.fixture.name}" -> ${p.name ? `"${p.name}"` : "(the console's default name)"}`);
  if (renamed.length && raw.names !== false) warnings.push(`names changed for the console (it keeps none of ${NAME_FORBIDDEN_CHARS}): ${list(renamed)}`);

  const usedSpecs = new Set(go.map((p) => p.spec));
  const imports = toImport.filter((p) => [...usedSpecs].some((spec) => serves(p, spec)));
  const plan = {
    fixtures: go.map((p) => ({ fid: p.fid, name: p.name, layer: p.fixture.layer, ...(p.stage ? { stage: p.stage } : {}), gdtf: p.spec, mode: p.mode, address: p.address ?? null, position: p.fixture.position, rotation: p.fixture.rotation, ...(typePlans.get(p.spec)?.existing ? { type: typePlans.get(p.spec)?.existing?.no } : {}) })),
    types: [...typePlans.values()].filter((p) => usedSpecs.has(p.spec)).map((p) => (p.existing ? { gdtf: p.spec, use: { no: p.existing.no, name: p.existing.name } } : p.sameAs ? { gdtf: p.spec, sameAs: p.sameAs } : { gdtf: p.spec, import: p.file, inLibrary: p.inLibrary === true })),
    byLayer: Object.fromEntries(scene.layers.map((l) => [l, go.filter((p) => p.fixture.layer === l).length]).filter(([, n]) => (n as number) > 0)),
  };
  if (preview) {
    return buildResult({
      operation: op,
      target,
      steps,
      verification: { status: "not_requested" },
      summary: `Preview: ${go.length} fixture(s) would be patched${raw.place !== false ? " and placed" : ""}${imports.length ? `, after importing ${imports.length} fixture type(s)` : ""}${bad.length ? `; ${bad.length} left out` : ""}. Nothing was sent.`,
      warnings,
      extra: { plan: detail || go.length <= 50 ? plan : { ...plan, fixtures: plan.fixtures.slice(0, 50), fixturesTruncated: true } },
    });
  }

  // 7. Changes, stopping at the first that does not succeed with a clean read-back.
  const blocksPlanned = () => blocksOf(go);
  const nameEdits = raw.names !== false ? go.filter((p) => p.name !== "") : [];
  const total = imports.length * 2 + Math.max(1, Math.ceil(go.length / CHUNK)) + Math.ceil(nameEdits.length / CHUNK) + (raw.place !== false ? Math.ceil(go.length / CHUNK) : 0);
  const progress = progressSteps(total);
  const verifications: Verification[] = [];
  const pending: string[] = [];
  let failed = false;
  const run = async (name: string, tool: string, fn: SubTool, args: Record<string, unknown>, extra: Record<string, unknown>): Promise<OperationResult | undefined> => {
    if (failed) {
      pending.push(name);
      return undefined;
    }
    const res = await fn(ctx, args);
    progress.step(`${op}: ${name}`);
    const s = subStep(name, tool, res, extra, detail);
    steps.push(s);
    verifications.push(res.verification);
    if (s.status !== "succeeded" || res.verification.status === "mismatched") failed = true;
    return res;
  };
  try {
    for (const p of imports) {
      if (!p.inLibrary) await run("library_add", "gma3_patch_library_add", deps.libraryAdd, { file_name: p.file, content_base64: (p.gdtf.bytes as Buffer).toString("base64") }, { gdtf: p.spec, file: p.file });
      const res = await run("import_type", "gma3_patch_import", deps.importType, { file: p.file, source: "user", exclusive: true, verify }, { gdtf: p.spec, file: p.file });
      const no = (res?.type as { no?: number } | undefined)?.no;
      if (res && !failed && typeof no !== "number") {
        failed = true;
        steps[steps.length - 1] = { ...steps[steps.length - 1], status: "unknown", error: `${p.file} was imported but the result names no type number` };
      }
      if (typeof no === "number") for (const f of go) if (serves(p, f.spec)) f.typeNo = no;
    }

    // Imported types: their modes and footprints from the console; then every planned range checked again.
    if (imports.length && !failed) {
      try {
        const now = ((await ctx.bridge.request("patch.types", {}, t)) as { types: TypeRow[] }).types;
        const fresh = go.filter((p) => imports.some((i) => serves(i, p.spec)));
        for (const p of fresh) {
          const ty = now.find((x) => x.no === p.typeNo);
          const m = ty?.modes.find((x) => x.name === p.mode) ?? ty?.modes.find((x) => sameName(x.name, p.mode));
          if (!ty || !m) flag(p.fixture, `the imported type ${p.typeNo} has no mode "${p.mode}"`);
          else {
            p.mode = m.name;
            p.footprint = m.footprint ?? null;
            if ((m.breaks ?? 1) > 1) flag(p.fixture, `mode "${m.name}" has ${m.breaks} DMX breaks; multi-break modes are not supported`);
            if (p.address !== undefined && typeof p.footprint !== "number") flag(p.fixture, `the DMX footprint of mode "${m.name}" is unknown`);
          }
        }
        // Every planned fixture, not only the imported types': a new footprint can overlap a fixture of a type the show
        // already had (review of #162).
        const again = await checkRanges("recheck_patch", go.filter((p) => !problems.has(p.fixture)));
        const late = go.filter((p) => problems.has(p.fixture));
        if (again.status !== "succeeded" || late.length) {
          steps.push({ ...again, status: "failed", error: again.error ?? `after the import: ${list(late.map((p) => `${label(p.fixture)}: ${(problems.get(p.fixture) as string[]).join(", ")}`))}; the types are imported, no fixture was added` });
          failed = true;
        } else steps.push(again);
      } catch (err) {
        steps.push(asRead(stepFromError("recheck_patch", err, { op: "patch.types" })));
        failed = true;
      }
    }

    for (const b of failed ? [] : blocksPlanned()) {
      const first = b[0];
      await run("add", "gma3_patch_add", deps.add, { type: first.typeNo, mode: first.mode, fid: first.fid, count: b.length, ...(first.address ? { address: first.address } : {}), ...(first.stage ? { stage: first.stage } : {}), exclusive: true, verify }, { fids: b.length > 1 ? `${first.fid}..${b[b.length - 1].fid}` : first.fid, ...(first.address ? { address: first.address } : {}) });
      if (failed) break;
    }
    if (failed && !steps.some((s) => s.name === "add")) pending.push("add");
    for (let i = 0; i < nameEdits.length; i += CHUNK) {
      const part = nameEdits.slice(i, i + CHUNK);
      await run("name", "gma3_patch_set", deps.set, { edits: part.map((p) => ({ fid: p.fid, name: p.name })), exclusive: true, verify }, { fixtures: part.length });
    }
    if (raw.place !== false) {
      for (let i = 0; i < go.length; i += CHUNK) {
        const part = go.slice(i, i + CHUNK);
        await run("place", "gma3_place_fixtures", deps.place, { unit: "m", placements: part.map((p) => ({ fid: p.fid, position: p.fixture.position, rotation: p.fixture.rotation })), verify }, { fixtures: part.length });
      }
    }
  } finally {
    progress.end();
  }
  for (const name of [...new Set(pending)]) steps.push({ name, status: "skipped", error: "not attempted after an earlier step failed" });

  const checked = "every sub-call's own read-back: types imported, fixtures patched at their FIDs and addresses, names, positions and rotations";
  const verification: Verification = !verify
    ? { status: "not_requested" }
    : verifications.some((v) => v.status === "mismatched")
      ? { status: "mismatched", checked, detail: steps.filter((s) => (s.detail as { verification?: string } | undefined)?.verification === "mismatched").map((s) => `${s.name}: ${(s.detail as { summary?: string }).summary}`).join(" | ") }
      : failed || verifications.some((v) => v.status !== "matched")
        ? unavailable("not every step finished with a read-back; see steps", checked)
        : { status: "matched", checked };
  const done = !failed;
  return buildResult({
    operation: op,
    target,
    steps,
    verification,
    summary: done
      ? `Imported ${go.length} fixture(s) from the MVR${imports.length ? ` (${imports.length} fixture type(s) imported)` : ""}${raw.place !== false ? ", patched and placed" : ", patched"}${bad.length ? `; ${bad.length} left out` : ""}.${verification.status === "matched" ? " Read-back matched." : ""}`
      : undefined,
    warnings,
    extra: { imported: { fixtures: done ? go.length : null, byLayer: plan.byLayer, types: plan.types }, ...(detail ? { plan } : {}) },
  });
}

export const registerMvrTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_patch_import_mvr",
    {
      title: "Import an MVR file: patch and place its fixtures",
      description:
        "Patch and place the fixtures of an MVR file (My Virtual Rig: a venue plan from Vectorworks, Capture, a visualiser ...). The file is read here, not by the console's Partial Show Read. " +
        "Per fixture: its number (FixtureIDNumeric or FixtureID), name, GDTF type and mode (from the GDTFs inside the MVR), its DMX address (one break; an integer address is absolute, 513 = 2.001) and its position and rotation (Matrix, millimetres, with every parent group and layer). " +
        "Everything is checked before anything changes: every fixture usable (or skip_unusable: true leaves those out and says why), stages exist, each GDTF matched to one fixture type in the show by manufacturer and name (types overrides it), every FID free, every DMX range free of the patch and of the other fixtures (bridge 0.58.0). " +
        "Then, stopping at the first problem: gma3_patch_library_add + gma3_patch_import for each GDTF the show lacks, gma3_patch_add in blocks, gma3_patch_set for the names (characters the console strips are removed), gma3_place_fixtures for positions and rotations. Each reads back; the result lists every call. " +
        "preview: true reports the plan and sends nothing. Layers are not stages: stage (or layer_stages) chooses them. Trusses and other scene objects are not imported. A committed patch has no undo.",
      inputSchema: {
        path: z.string().optional().describe("An .mvr file on the MCP server's host. Give this or content_base64."),
        content_base64: z.string().optional().describe("The .mvr file's bytes, base64."),
        layers: z.array(z.string()).optional().describe("Only the fixtures of these MVR layers (default: all)."),
        stage: z.string().optional().describe("The stage every fixture goes to (default: gma3_patch_add's)."),
        layer_stages: z.record(z.string(), z.string()).optional().describe("Stage per MVR layer name, overriding stage."),
        types: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe("GDTFSpec -> the show's fixture type (number or name) to use instead of matching or importing."),
        names: z.boolean().optional().describe("Set the MVR names on the fixtures (default true)."),
        place: z.boolean().optional().describe("Set positions and rotations (default true)."),
        skip_unusable: z.boolean().optional().describe("Leave out fixtures that cannot be imported (no number, taken FID, DMX conflict ...) instead of refusing the whole file."),
        preview: z.boolean().optional().describe("Check and report the plan; send nothing."),
        exclusive: z.boolean().optional().describe("Required unless preview: confirms nobody else uses the console while the import runs."),
        verify: z.boolean().optional().describe("Each sub-call reads back (default true)."),
        detail: z.boolean().optional().describe("Every sub-call's full result and the whole plan."),
      },
    },
    async (args) => operation(() => mvrImport(ctx, args as MvrImportArgs)),
  );
};
