/**
 * #143: Bitmap pixel mapping. An image (or video frame source) mapped onto a fixture selection's canvas in the
 * selection grid, played as a generator. Probe on onPC 2.5.1.1 (2026-11-17, comment on #143):
 *
 *   - `Import Image 3.<n> /File "<file>"` imports a file from gma3_library/media/images into the Images pool (class
 *     UserImage at ShowData.MediaPools.Images; named "[<file>_png]"; FILENAME, FILESIZE as "157B").
 *   - `Store Bitmap <n> /NoConfirmation` creates class Bitmap at DataPool.GeneratorTypes.Bitmaps with BitmapConfig 1
 *     (Content, Width, Height default 64, ContentMode, Interpolate, Alpha, Control*) and five BitmapChannels
 *     (Dimmer<-Intensity, Dimmer<-Const, ColorRGB_R/G/B<-Red/Green/Blue).
 *   - `Group <g> At Bitmap <n>` answered OK, but with other programmer values on the cells the programmer read showed
 *     no bitmap values: whether and how a bitmap lands in the programmer is NOT confirmed, so apply and store report
 *     what they read and never claim a match.
 *
 *   gma3_image_add     upload an image over the bridge (patch.libraryAdd kind "image") and import it into Image 3.<n>
 *   gma3_build_bitmap  store a bitmap, set its config and channels, read it back; optionally apply and store it
 *   gma3_bitmaps       read-only list of bitmaps (config, channels) and images
 *
 * Bridge 0.57.0: bitmap.list, bitmap.set, bitmap.imageName, and kind "image" on patch.libraryStat / patch.libraryAdd.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { crc32 } from "node:zlib";
import { z } from "zod";
import { asRead, buildResult, commandStep, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { readObjects } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { decodeBase64, uploadChunks } from "./patchlibrary.js";

/** The Images pool's limit per object (POOLOBJECTCONTENTSIZELIMITATION, 10485760 bytes). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const NEEDS_BRIDGE = "the console runs an older bridge plugin without bitmap.list (bridge 0.57.0); update the plugin";
const unknownOp = (err: unknown) => err instanceof Error && /unknown op/i.test(err.message);
const hex = (n: number) => n.toString(16).padStart(8, "0");

export interface ImageEntry {
  no?: number;
  ref?: string;
  name?: string;
  class?: string;
  fileName?: string;
  fileSize?: string;
  width?: number;
  height?: number;
}
export interface BitmapConfigEntry {
  index: number;
  content?: { class?: string; name?: string; no?: number; ref?: string } | null;
  width?: number;
  height?: number;
  contentMode?: string;
  interpolate?: string;
  alpha?: string;
  controlX?: number;
  controlY?: number;
  controlZoom?: number;
  controlAspect?: number;
  controlRotate?: number;
}
export interface BitmapChannelEntry {
  index: number;
  attribute?: string;
  source?: string;
  low?: number;
  high?: number;
}
export interface BitmapEntry {
  no?: number;
  name?: string;
  class?: string;
  speedMaster?: string;
  configs: BitmapConfigEntry[];
  channels: BitmapChannelEntry[];
}
interface ListReply {
  bitmapFound?: boolean;
  bitmap?: BitmapEntry;
  bitmaps?: BitmapEntry[];
  imageFound?: boolean;
  image?: ImageEntry;
  images?: ImageEntry[];
}

/** <name>.png, .jpg or .jpeg (lower case), as the bridge accepts it. Throws a readable reason. */
export function imageFileName(raw: unknown): { file: string; format: "png" | "jpeg" } {
  if (typeof raw !== "string" || raw === "") throw new Error("file_name is required: <name>.png, .jpg or .jpeg");
  if (raw.length > 128) throw new Error("the file name is longer than 128 characters");
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(raw) || raw.startsWith(".") || raw.includes("..")) throw new Error('the file name must not contain < > : " / \\ | ? * .. or a control character, nor start with a dot');
  const ext = /\.(\w+)$/.exec(raw)?.[1];
  if (ext !== "png" && ext !== "jpg" && ext !== "jpeg") throw new Error("the file name must end in .png, .jpg or .jpeg (lower case)");
  return { file: raw, format: ext === "png" ? "png" : "jpeg" };
}

/** The image's format by its first bytes; throws when it is not the one the name says. */
export function checkImage(format: "png" | "jpeg", bytes: Buffer): void {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (format === "png" && !png) throw new Error(jpeg ? "the bytes are a JPEG, but the name ends in .png" : "the bytes are not a PNG (no PNG signature)");
  if (format === "jpeg" && !jpeg) throw new Error(png ? "the bytes are a PNG, but the name ends in .jpg/.jpeg" : "the bytes are not a JPEG (no SOI marker)");
}

/**
 * Whether the console's FILESIZE text ("157B", "12.3kB", "1.2 MB") can be the given byte count: exact in bytes, or
 * within the rounding of its last digit in units of 1000 or 1024. null when the text cannot be read.
 */
export function fileSizeMatches(text: unknown, bytes: number): boolean | null {
  if (typeof text !== "string") return null;
  const m = /^\s*(\d+(?:\.(\d+))?)\s*([kKmMgG]?i?)[bB]?\s*$/.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[3].toLowerCase().replace("i", "");
  const power = unit === "" ? 0 : unit === "k" ? 1 : unit === "m" ? 2 : 3;
  if (power === 0) return value === bytes;
  const step = 0.5 * 10 ** -(m[2]?.length ?? 0);
  return [1000, 1024].some((base) => Math.abs(value - bytes / base ** power) <= step + 1e-9);
}

function imageRef(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= 9999 ? raw : null;
  if (typeof raw === "string") {
    const m = /^(?:3\.)?(\d{1,4})$/.exec(raw.trim());
    if (m && Number(m[1]) >= 1) return Number(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// gma3_image_add
// ---------------------------------------------------------------------------

interface ImageAddArgs {
  image: number;
  file_name?: string;
  content_base64?: string;
  path?: string;
  name?: string;
  replace_file?: boolean;
  overwrite?: boolean;
}

interface Stat {
  exists: boolean;
  size?: number;
  crc32?: string;
  path?: string;
  folder?: string;
  matches?: Array<{ source: string; file: string }>;
}

export async function imageAdd(ctx: ToolContext, raw: ImageAddArgs): Promise<OperationResult> {
  const op = "image_add";
  const errors: string[] = [];
  const hasContent = raw.content_base64 !== undefined;
  const hasPath = raw.path !== undefined;
  if (hasContent === hasPath) errors.push("give exactly one of content_base64 (the file's bytes) or path (a file on the MCP server's host)");
  if (!Number.isInteger(raw.image) || raw.image < 1 || raw.image > 9999) errors.push("image must be an integer from 1 to 9999 (Image 3.<image>)");
  if (raw.name !== undefined && (raw.name === "" || raw.name.length > 128 || /["\u0000-\u001f]/.test(raw.name))) errors.push("name must be 1 to 128 characters without quotes or control characters");
  let name: ReturnType<typeof imageFileName> | undefined;
  try {
    name = imageFileName(raw.file_name ?? (hasPath && typeof raw.path === "string" ? basename(raw.path) : undefined));
  } catch (err) {
    errors.push((err as Error).message);
  }
  let bytes: Buffer | undefined;
  if (hasContent && errors.length === 0) {
    if (raw.content_base64!.replace(/\s+/g, "").length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) errors.push(`the file is larger than ${IMAGE_MAX_BYTES} bytes`);
    else {
      try {
        bytes = decodeBase64(raw.content_base64!);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  const target: Record<string, unknown> = { image: `3.${raw.image}`, file: name?.file ?? raw.file_name ?? null, ...(hasPath ? { path: raw.path } : {}) };
  if (errors.length || !name) return validationFailure(op, target, errors);
  const file = name.file;
  const format = name.format;

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    const warnings: string[] = [];
    const stop = (step: StepResult, why = "nothing was imported") => {
      steps.push(step);
      return buildResult({ operation: op, target, steps, verification: unavailable(why), warnings });
    };

    if (!bytes) {
      try {
        const st = await stat(raw.path!);
        if (!st.isFile()) return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} is not a file` }));
        if (st.size > IMAGE_MAX_BYTES) return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} has ${st.size} bytes; the Images pool takes at most ${IMAGE_MAX_BYTES} per image` }));
        bytes = await readFile(raw.path!);
        steps.push(asRead({ name: "read_file", status: "succeeded", detail: { path: raw.path, size: bytes.length } }));
      } catch (err) {
        return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} cannot be read: ${(err as Error).message}` }));
      }
    }
    if (bytes.length === 0) return stop(asRead({ name: "check_content", status: "failed", error: "the file is empty" }));
    if (bytes.length > IMAGE_MAX_BYTES) return stop(asRead({ name: "check_content", status: "failed", error: `the file has ${bytes.length} bytes; the Images pool takes at most ${IMAGE_MAX_BYTES} per image` }));
    try {
      checkImage(format, bytes);
    } catch (err) {
      return stop(asRead({ name: "check_content", status: "failed", error: (err as Error).message }));
    }
    const sum = hex(crc32(bytes));
    steps.push(asRead({ name: "check_content", status: "succeeded", detail: { format, size: bytes.length, crc32: sum } }));

    // The slot.
    let slot: ListReply;
    try {
      slot = (await ctx.bridge.request("bitmap.list", { image: raw.image }, t)) as ListReply;
    } catch (err) {
      if (unknownOp(err)) return stop(asRead({ name: "check_slot", status: "failed", op: "bitmap.list", error: NEEDS_BRIDGE }));
      return stop(asRead(stepFromError("check_slot", err, { op: "bitmap.list" })));
    }
    const taken = slot.imageFound === true;
    if (taken && raw.overwrite !== true) {
      return stop(asRead({ name: "check_slot", status: "failed", op: "bitmap.list", error: `Image 3.${raw.image} is taken (${slot.image?.name ?? "?"}, file ${slot.image?.fileName ?? "?"}); pass overwrite: true to replace it, or choose a free number`, detail: slot.image }));
    }
    steps.push(asRead({ name: "check_slot", status: "succeeded", op: "bitmap.list", detail: { taken, ...(slot.image ? { image: slot.image } : {}) } }));

    // The images folder.
    let before: Stat;
    try {
      before = (await ctx.bridge.request("patch.libraryStat", { file, kind: "image" }, t)) as Stat;
    } catch (err) {
      return stop(asRead(stepFromError("check_folder", err, { op: "patch.libraryStat" })));
    }
    const caseOnly = (before.matches ?? []).filter((m) => m.file !== file);
    if (caseOnly.length) {
      return stop(asRead({ name: "check_folder", status: "failed", op: "patch.libraryStat", error: `${file} differs only in case from ${caseOnly.map((m) => m.file).join(", ")} in the images folder (one file on macOS and Windows); use that exact name or another one`, detail: before }));
    }
    const sameBytes = before.exists && before.size === bytes.length && before.crc32 === sum;
    if (before.exists && !sameBytes && raw.replace_file !== true) {
      return stop(asRead({ name: "check_folder", status: "failed", op: "patch.libraryStat", error: `${file} is already in the images folder with other bytes (${before.size} bytes, CRC-32 ${before.crc32}); pass replace_file: true to overwrite it, or another file_name`, detail: before }));
    }
    steps.push(asRead({ name: "check_folder", status: "succeeded", op: "patch.libraryStat", detail: before }));

    if (sameBytes) steps.push({ name: "write", status: "skipped", op: "patch.libraryAdd", detail: { reason: "the images folder already has this file with the same bytes" } });
    else {
      const sent = await uploadChunks(ctx, { file, bytes, crc32: sum, replace: raw.replace_file === true, kind: "image" }, steps);
      if (!sent.ok) return buildResult({ operation: op, target, steps, verification: unavailable(sent.lost ? "the last chunk's reply was lost; nothing was imported" : "the file was not written; nothing was imported"), warnings });
    }

    if (taken) {
      warnings.push(`Image 3.${raw.image} was replaced: appearances and bitmaps that used the old image lose it`);
      const del = await commandStep(ctx.bridge, "delete_old", `Delete Image 3.${raw.image} /NoConfirmation`, t);
      steps.push(del);
      if (del.status !== "succeeded") return buildResult({ operation: op, target, steps, verification: unavailable("the old image could not be deleted; nothing was imported"), warnings });
    }
    const imp = await commandStep(ctx.bridge, "import", `Import Image 3.${raw.image} /File "${file}"`, t);
    steps.push(imp);
    if (imp.status === "failed") return buildResult({ operation: op, target, steps, verification: unavailable("the console refused the import"), warnings });

    if (raw.name !== undefined && imp.status === "succeeded") {
      try {
        const res = (await ctx.bridge.request("bitmap.imageName", { image: raw.image, name: raw.name }, t)) as { setError?: string };
        steps.push(res.setError ? { name: "name", status: "failed", op: "bitmap.imageName", error: res.setError } : { name: "name", status: "succeeded", op: "bitmap.imageName" });
      } catch (err) {
        steps.push(stepFromError("name", err, { op: "bitmap.imageName" }));
      }
    }

    let after: ListReply | undefined;
    try {
      after = (await ctx.bridge.request("bitmap.list", { image: raw.image }, t)) as ListReply;
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "bitmap.list", detail: after.image ?? { imageFound: false } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "bitmap.list" })));
    }
    const checked = `Image 3.${raw.image} is a UserImage of file ${file} whose FILESIZE reads ${bytes.length} bytes${raw.name !== undefined ? ` and is named ${raw.name}` : ""}`;
    const expected = { class: "UserImage", fileName: file, size: bytes.length, ...(raw.name !== undefined ? { name: raw.name } : {}) };
    let verification: Verification;
    if (!after) verification = unavailable("the image could not be read back", checked);
    else if (!after.imageFound || !after.image) verification = { status: "mismatched", checked, expected, actual: { imageFound: false }, detail: `Image 3.${raw.image} is empty after the import` };
    else {
      const img = after.image;
      const size = fileSizeMatches(img.fileSize, bytes.length);
      const actual = { class: img.class ?? null, fileName: img.fileName ?? null, fileSize: img.fileSize ?? null, ...(raw.name !== undefined ? { name: img.name ?? null } : {}) };
      const bad: string[] = [];
      if (img.class !== "UserImage") bad.push(`class is ${img.class}`);
      if (img.fileName !== file) bad.push(`file is ${img.fileName}`);
      if (size === false) bad.push(`FILESIZE reads ${img.fileSize}, not ${bytes.length} bytes`);
      if (raw.name !== undefined && img.name !== raw.name) bad.push(`name is ${img.name}`);
      if (size === null) warnings.push(`FILESIZE "${img.fileSize ?? ""}" could not be read as a size; the size was not compared`);
      verification = bad.length ? { status: "mismatched", checked, expected, actual, detail: bad.join("; ") } : { status: "matched", checked, expected, actual };
    }
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings,
      summary: verification.status === "matched" ? `Imported ${file} (${bytes.length} bytes) into Image 3.${raw.image}${raw.name !== undefined ? ` "${raw.name}"` : ""}. Use it with gma3_build_bitmap { bitmap: <n>, image: ${raw.image} }.` : undefined,
      extra: { image: `3.${raw.image}`, file, size: bytes.length, crc32: sum, ...(after?.image ? { imageEntry: after.image } : {}) },
    });
  });
}

// ---------------------------------------------------------------------------
// gma3_build_bitmap
// ---------------------------------------------------------------------------

interface ChannelArg {
  attribute: string;
  source: string;
  low?: number;
  high?: number;
}
interface BuildArgs {
  bitmap: number;
  image: number | string;
  name?: string;
  width?: number;
  height?: number;
  content_mode?: string;
  interpolate?: boolean;
  alpha?: boolean;
  control?: { x?: number; y?: number; zoom?: number; aspect?: number; rotate?: number };
  channels?: ChannelArg[];
  speed_master?: string;
  overwrite?: boolean;
  apply?: { group: number };
  store?: { preset?: string; sequence?: number; cue?: number | string; overwrite?: boolean };
}

const CONTROL_KEYS = { x: "controlX", y: "controlY", zoom: "controlZoom", aspect: "controlAspect", rotate: "controlRotate" } as const;
const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) <= 0.01;
const sameText = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
const yesNo = (b: boolean) => (b ? "Yes" : "No");

/** Compare the bitmap as read with what was asked; every asked field, nothing else. */
export function compareBitmap(b: BitmapEntry | undefined, a: BuildArgs, image: number): { mismatches: string[]; expected: Record<string, unknown>; actual: Record<string, unknown> } {
  const mismatches: string[] = [];
  const expected: Record<string, unknown> = { image: `3.${image}` };
  const actual: Record<string, unknown> = {};
  if (!b) return { mismatches: ["the bitmap is missing"], expected, actual: { bitmapFound: false } };
  const cfg = b.configs[0];
  actual.image = cfg?.content?.ref ?? cfg?.content?.name ?? null;
  if (!cfg) mismatches.push("BitmapConfig 1 is missing");
  else if (cfg.content?.class !== "UserImage" || cfg.content?.no !== image) mismatches.push(`content is ${cfg.content ? `${cfg.content.class} ${cfg.content.ref ?? cfg.content.name}` : "empty"}, not Image 3.${image}`);
  const num = (key: keyof BitmapConfigEntry, want: number | undefined, label: string) => {
    if (want === undefined) return;
    expected[label] = want;
    actual[label] = cfg?.[key] ?? null;
    if (!near(cfg?.[key], want)) mismatches.push(`${label} reads ${String(cfg?.[key])}, not ${want}`);
  };
  const text = (key: keyof BitmapConfigEntry, want: string | undefined, label: string) => {
    if (want === undefined) return;
    expected[label] = want;
    actual[label] = cfg?.[key] ?? null;
    if (!sameText(cfg?.[key], want)) mismatches.push(`${label} reads ${String(cfg?.[key])}, not ${want}`);
  };
  num("width", a.width, "width");
  num("height", a.height, "height");
  text("contentMode", a.content_mode, "content_mode");
  text("interpolate", a.interpolate === undefined ? undefined : yesNo(a.interpolate), "interpolate");
  text("alpha", a.alpha === undefined ? undefined : yesNo(a.alpha), "alpha");
  for (const [k, key] of Object.entries(CONTROL_KEYS)) num(key, a.control?.[k as keyof typeof CONTROL_KEYS], `control.${k}`);
  if (a.name !== undefined) {
    expected.name = a.name;
    actual.name = b.name ?? null;
    if (b.name !== a.name) mismatches.push(`name reads ${b.name}, not ${a.name}`);
  }
  if (a.speed_master !== undefined) {
    expected.speed_master = a.speed_master;
    actual.speed_master = b.speedMaster ?? null;
    if (!sameText(b.speedMaster, a.speed_master)) mismatches.push(`speed master reads ${b.speedMaster}, not ${a.speed_master}`);
  }
  if (a.channels) {
    expected.channels = a.channels;
    actual.channels = b.channels.map((c) => ({ attribute: c.attribute, source: c.source, low: c.low, high: c.high }));
    if (b.channels.length !== a.channels.length) mismatches.push(`${b.channels.length} channels, not ${a.channels.length}`);
    a.channels.forEach((want, i) => {
      const got = b.channels[i];
      if (!got) return;
      if (!sameText(got.attribute, want.attribute)) mismatches.push(`channel ${i + 1} attribute reads ${got.attribute}, not ${want.attribute}`);
      if (!sameText(got.source, want.source)) mismatches.push(`channel ${i + 1} source reads ${got.source}, not ${want.source}`);
      if (want.low !== undefined && !near(got.low, want.low)) mismatches.push(`channel ${i + 1} low reads ${got.low}, not ${want.low}`);
      if (want.high !== undefined && !near(got.high, want.high)) mismatches.push(`channel ${i + 1} high reads ${got.high}, not ${want.high}`);
    });
  }
  return { mismatches, expected, actual };
}

const PRESET_RE = /^([1-9]\d?)\.([1-9]\d{0,3})$/;
const SOURCES = ["Intensity", "Const", "Red", "Green", "Blue", "Alpha", "Hue", "Saturation", "Brightness"];

/** The summary's apply clause, from the apply step as it ran: sent (programmer content unverified), failed, unknown or skipped. */
export function applyClause(steps: StepResult[], group: number): string {
  const s = steps.find((x) => x.name === "apply");
  if (!s) return `not applied to Group ${group}`;
  if (s.status === "succeeded") return `applied to Group ${group} (command accepted; programmer content unverified)`;
  if (s.status === "failed") return `applying to Group ${group} FAILED (${s.error ?? s.feedback ?? "refused"})`;
  if (s.status === "unknown") return `applying to Group ${group} got no clear answer (${s.error ?? "unknown"}); check the programmer`;
  return `not applied to Group ${group} (${s.error ?? "skipped"})`;
}

/** The summary's store clause, from store_look and read_store as they ran. */
export function storeClause(steps: StepResult[], ref: string): string {
  const s = steps.find((x) => x.name === "store_look");
  if (!s) return `not stored into ${ref}`;
  if (s.status === "failed") return `storing into ${ref} FAILED (${s.error ?? s.feedback ?? "refused"})`;
  if (s.status === "unknown") return `storing into ${ref} got no clear answer (${s.error ?? "unknown"}); check ${ref}`;
  if (s.status === "skipped") return `not stored into ${ref} (${s.error ?? "skipped"})`;
  const read = steps.find((x) => x.name === "read_store");
  if (read?.status === "succeeded") return `stored into ${ref} (command accepted, ${ref} exists; content unverified)`;
  if (read?.status === "failed") return `store into ${ref} was accepted but ${read.error ?? `${ref} is missing`}`;
  return `store into ${ref} was accepted, but ${ref} could not be read back`;
}

export async function buildBitmap(ctx: ToolContext, a: BuildArgs): Promise<OperationResult> {
  const op = "build_bitmap";
  const errors: string[] = [];
  if (!Number.isInteger(a.bitmap) || a.bitmap < 1 || a.bitmap > 9999) errors.push("bitmap must be an integer from 1 to 9999");
  const image = imageRef(a.image);
  if (image === null) errors.push('image must be an image number (1 to 9999) or "3.<n>"');
  for (const k of ["width", "height"] as const) {
    const v = a[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 4096)) errors.push(`${k} must be an integer from 1 to 4096`);
  }
  if (a.name !== undefined && (a.name === "" || a.name.length > 128 || /["\u0000-\u001f]/.test(a.name))) errors.push("name must be 1 to 128 characters without quotes or control characters");
  if (a.content_mode !== undefined && !/^[A-Za-z]+$/.test(a.content_mode)) errors.push("content_mode must be one word (None, Clip, ...)");
  if (a.speed_master !== undefined && (a.speed_master === "" || /["\u0000-\u001f]/.test(a.speed_master))) errors.push("speed_master must be text without quotes");
  a.channels?.forEach((c, i) => {
    if (!SOURCES.some((s) => s.toLowerCase() === c.source.toLowerCase())) errors.push(`channels[${i}].source must be one of ${SOURCES.join(", ")}`);
  });
  if (a.apply && (!Number.isInteger(a.apply.group) || a.apply.group < 1)) errors.push("apply.group must be a group number");
  if (a.store) {
    if (!a.apply) errors.push("store needs apply: the bitmap is stored from the programmer values apply puts there");
    const hasPreset = a.store.preset !== undefined;
    const hasCue = a.store.sequence !== undefined || a.store.cue !== undefined;
    if (hasPreset === hasCue) errors.push('store takes either preset ("<pool>.<number>") or sequence and cue');
    if (hasPreset && !PRESET_RE.test(a.store.preset!)) errors.push('store.preset must be "<pool>.<number>", e.g. "4.12"');
    if (hasCue && (!Number.isInteger(a.store.sequence) || a.store.sequence! < 1 || a.store.cue === undefined || !/^\d+(\.\d+)?$/.test(String(a.store.cue)))) errors.push("store.sequence must be a sequence number and store.cue a cue number");
  }
  const target: Record<string, unknown> = { bitmap: a.bitmap, image: image === null ? a.image : `3.${image}`, ...(a.apply ? { group: a.apply.group } : {}) };
  if (errors.length || image === null) return validationFailure(op, target, errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    const warnings: string[] = [];
    const stop = (step: StepResult, why = "nothing was stored") => {
      steps.push(step);
      return buildResult({ operation: op, target, steps, verification: unavailable(why), warnings });
    };

    let slot: ListReply;
    try {
      slot = (await ctx.bridge.request("bitmap.list", { bitmap: a.bitmap, image }, t)) as ListReply;
    } catch (err) {
      if (unknownOp(err)) return stop(asRead({ name: "check", status: "failed", op: "bitmap.list", error: NEEDS_BRIDGE }));
      return stop(asRead(stepFromError("check", err, { op: "bitmap.list" })));
    }
    if (!slot.imageFound) return stop(asRead({ name: "check", status: "failed", op: "bitmap.list", error: `Image 3.${image} is empty; import the image first with gma3_image_add` }));
    if (slot.image?.class && slot.image.class !== "UserImage") return stop(asRead({ name: "check", status: "failed", op: "bitmap.list", error: `Image 3.${image} is a ${slot.image.class}, not an imported image (UserImage)` }));
    const taken = slot.bitmapFound === true;
    if (taken && a.overwrite !== true) return stop(asRead({ name: "check", status: "failed", op: "bitmap.list", error: `Bitmap ${a.bitmap} is taken (${slot.bitmap?.name ?? "?"}); pass overwrite: true to replace it, or choose a free number`, detail: slot.bitmap }));
    steps.push(asRead({ name: "check", status: "succeeded", op: "bitmap.list", detail: { bitmapTaken: taken, image: slot.image } }));

    if (a.apply) {
      try {
        const g = await readObjects(ctx.bridge, `Group ${a.apply.group}`, ["Name"], 1);
        if (!g?.items?.length) return stop(asRead({ name: "check_group", status: "failed", op: "objects", error: `Group ${a.apply.group} does not exist` }));
        steps.push(asRead({ name: "check_group", status: "succeeded", op: "objects", detail: { group: a.apply.group, name: g.items[0].name } }));
      } catch (err) {
        return stop(asRead(stepFromError("check_group", err, { op: "objects" })));
      }
    }
    let storeRef: string | undefined;
    let storeExists = false;
    if (a.store) {
      storeRef = a.store.preset !== undefined ? `Preset ${a.store.preset}` : `Sequence ${a.store.sequence} Cue ${a.store.cue}`;
      try {
        const s = await readObjects(ctx.bridge, storeRef, ["Name"], 1);
        storeExists = Boolean(s?.items?.length);
      } catch (err) {
        return stop(asRead(stepFromError("check_store", err, { op: "objects" })));
      }
      if (storeExists && a.store.overwrite !== true) return stop(asRead({ name: "check_store", status: "failed", op: "objects", error: `${storeRef} exists; pass store.overwrite: true to overwrite it` }));
      steps.push(asRead({ name: "check_store", status: "succeeded", op: "objects", detail: { ref: storeRef, exists: storeExists } }));
    }

    if (taken) {
      const del = await commandStep(ctx.bridge, "delete_old", `Delete Bitmap ${a.bitmap} /NoConfirmation`, t);
      steps.push(del);
      if (del.status !== "succeeded") return buildResult({ operation: op, target, steps, verification: unavailable("the old bitmap could not be deleted; nothing was stored"), warnings });
    }
    const store = await commandStep(ctx.bridge, "store", `Store Bitmap ${a.bitmap} /NoConfirmation`, t);
    steps.push(store);
    if (store.status === "failed") return buildResult({ operation: op, target, steps, verification: unavailable("the console refused to store the bitmap"), warnings });
    if (store.status !== "succeeded") {
      // No answer to Store Bitmap: nothing is configured until a read shows the bitmap is there (the slot was free,
      // or its old bitmap was deleted, before the store).
      let found: boolean | undefined;
      try {
        found = ((await ctx.bridge.request("bitmap.list", { bitmap: a.bitmap }, t)) as ListReply).bitmapFound === true;
      } catch (err) {
        return stop(asRead(stepFromError("resolve_store", err, { op: "bitmap.list" })), "the store's outcome is unknown and could not be read; nothing was configured");
      }
      if (!found) return stop(asRead({ name: "resolve_store", status: "failed", op: "bitmap.list", error: `Store Bitmap ${a.bitmap} got no clear answer and Bitmap ${a.bitmap} is not there; nothing was configured` }));
      steps.push(asRead({ name: "resolve_store", status: "succeeded", op: "bitmap.list", detail: { bitmapFound: true } }));
      // Resolved: the store happened (the console's feedback is kept on the step).
      store.status = "succeeded";
      store.detail = { resolvedBy: "resolve_store", unclearFeedback: store.error };
      delete store.error;
    }

    const config: Record<string, unknown> = { image };
    if (a.width !== undefined) config.width = a.width;
    if (a.height !== undefined) config.height = a.height;
    if (a.content_mode !== undefined) config.contentMode = a.content_mode;
    if (a.interpolate !== undefined) config.interpolate = a.interpolate;
    if (a.alpha !== undefined) config.alpha = a.alpha;
    for (const [k, key] of Object.entries(CONTROL_KEYS)) {
      const v = a.control?.[k as keyof typeof CONTROL_KEYS];
      if (v !== undefined) config[key] = v;
    }
    try {
      const res = (await ctx.bridge.request("bitmap.set", { bitmap: a.bitmap, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.speed_master !== undefined ? { speedMaster: a.speed_master } : {}), config, ...(a.channels ? { channels: a.channels } : {}) }, t)) as { setErrors?: Array<{ field: string; error: string }> };
      const errs = res.setErrors ?? [];
      steps.push(errs.length ? { name: "configure", status: "failed", op: "bitmap.set", error: errs.map((e) => `${e.field}: ${e.error}`).join("; "), detail: { setErrors: errs } } : { name: "configure", status: "succeeded", op: "bitmap.set" });
    } catch (err) {
      steps.push(stepFromError("configure", err, { op: "bitmap.set" }));
    }

    let after: ListReply | undefined;
    try {
      after = (await ctx.bridge.request("bitmap.list", { bitmap: a.bitmap }, t)) as ListReply;
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "bitmap.list", detail: after.bitmap ?? { bitmapFound: false } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "bitmap.list" })));
    }

    const checked = `Bitmap ${a.bitmap}'s BitmapConfig 1 shows Image 3.${image} and every asked setting; channels and name as asked (apply and store are not part of this check)`;
    let verification: Verification;
    if (!after) verification = unavailable("the bitmap could not be read back", checked);
    else {
      const cmp = compareBitmap(after.bitmapFound ? after.bitmap : undefined, a, image);
      verification = cmp.mismatches.length ? { status: "mismatched", checked, expected: cmp.expected, actual: cmp.actual, detail: cmp.mismatches.join("; ") } : { status: "matched", checked, expected: cmp.expected, actual: cmp.actual };
    }
    const configured = steps.find((x) => x.name === "configure")?.status === "succeeded" && verification.status === "matched";
    if (a.apply && !configured) {
      const why = `skipped: the bitmap's configuration ${verification.status === "matched" ? "step did not succeed" : `was not confirmed (${verification.status})`}, so it is not applied${a.store ? " or stored" : ""}`;
      steps.push({ name: "apply", status: "skipped", error: why });
      if (a.store) steps.push({ name: "store_look", status: "skipped", error: why });
    }
    if (a.apply && configured) {
      const apply = await commandStep(ctx.bridge, "apply", `Group ${a.apply.group} At Bitmap ${a.bitmap}`, t);
      steps.push(apply);
      if (apply.status === "succeeded") {
        try {
          const prog = (await ctx.bridge.request("programmer", { scope: "selection", limit: 50, maxChannels: 5000 }, t)) as { total?: number; selectionCount?: number; rows?: Array<{ attribute?: string; absPreset?: { name?: string } | null }> };
          const presets = [...new Set((prog.rows ?? []).map((r) => r.absPreset?.name).filter((x): x is string => typeof x === "string"))];
          steps.push(asRead({ name: "read_programmer", status: "succeeded", op: "programmer", detail: { verification: "unverified", selectionCount: prog.selectionCount ?? null, rows: prog.total ?? null, absPresets: presets, note: "how a bitmap value reads in the programmer is not confirmed on a console; these rows are reported, not compared" } }));
        } catch (err) {
          steps.push(asRead(stepFromError("read_programmer", err, { op: "programmer" })));
        }
        warnings.push(`apply is unverified: Group ${a.apply.group} is selected and At Bitmap ${a.bitmap} answered ${apply.feedback ?? "?"}, but whether the bitmap's values are in the programmer was not confirmed. Check the festoon output (gma3_observe_values source output); clear with gma3_clear_programmer`);
        if (a.store && storeRef) {
          const cmd = `Store ${storeRef}${storeExists ? " /Overwrite" : ""} /NoConfirmation`;
          const st = await commandStep(ctx.bridge, "store_look", cmd, t);
          steps.push(st);
          if (st.status === "succeeded") {
            try {
              const s = await readObjects(ctx.bridge, storeRef, ["Name"], 1);
              steps.push(asRead({ name: "read_store", status: s?.items?.length ? "succeeded" : "failed", op: "objects", detail: { verification: "unverified", ref: storeRef, exists: Boolean(s?.items?.length), note: "the stored content (the bitmap values) is not compared" }, ...(s?.items?.length ? {} : { error: `${storeRef} is missing after the store` }) }));
            } catch (err) {
              steps.push(asRead(stepFromError("read_store", err, { op: "objects" })));
            }
            if (steps.at(-1)?.status === "succeeded") warnings.push(`store is unverified: ${storeRef} exists, but its content was not compared with the bitmap`);
          }
        }
      } else if (a.store) {
        steps.push({ name: "store_look", status: "skipped", error: `skipped: the apply step was ${apply.status}, so there is nothing to store` });
      }
    }

    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings,
      summary:
        verification.status === "matched"
          ? `Stored Bitmap ${a.bitmap} on Image 3.${image}${a.apply ? `; ${applyClause(steps, a.apply.group)}` : ""}${a.store && storeRef ? `; ${storeClause(steps, storeRef)}` : ""}.`
          : undefined,
      extra: { bitmap: a.bitmap, image: `3.${image}`, ...(after?.bitmap ? { bitmapEntry: after.bitmap } : {}) },
    });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerBitmapTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_bitmaps",
    {
      title: "List bitmaps and images",
      description:
        "Read-only. The Bitmap pool (DataPool.GeneratorTypes.Bitmaps): each bitmap's name, speed master, configs (content image, width, height, content mode, interpolate, alpha, control x/y/zoom/aspect/rotate) and channels (attribute, source, low, high). bitmap: one bitmap only. images: true also lists the Images pool (Image 3.<n>: name, file, size). Needs bridge 0.57.0.",
      inputSchema: {
        bitmap: z.number().int().min(1).max(9999).optional().describe("Only this bitmap."),
        images: z.boolean().optional().describe("Also list the Images pool."),
      },
    },
    async (args) => {
      try {
        const res = await ctx.bridge.request("bitmap.list", { ...(args.bitmap !== undefined ? { bitmap: args.bitmap } : {}), ...(args.images ? { images: true } : {}) });
        return json(res);
      } catch (err) {
        const message = unknownOp(err) ? NEEDS_BRIDGE : err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_image_add",
    {
      title: "Add an image to the Images pool",
      description:
        "Put a .png or .jpg into the Images pool (Image 3.<image>) for bitmaps and appearances. The bytes go over the bridge into gma3_library/media/images (the client need not be on the console's machine), then the console imports them with Import Image 3.<image> /File. " +
        `Give content_base64 with file_name, or path (a file on the MCP server's host). Pre-checks (nothing changed on failure): the name (<name>.png/.jpg/.jpeg, lower case), at most ${IMAGE_MAX_BYTES / 1024 / 1024} MiB, the bytes are the format the name says, Image 3.<image> is free unless overwrite: true (the old image is deleted; appearances using it lose it), a file of that name in the folder holds the same bytes unless replace_file: true. ` +
        "Read-back: Image 3.<image> is a UserImage of that file whose FILESIZE matches, and its name when given. Needs bridge 0.57.0.",
      inputSchema: {
        image: z.number().int().min(1).max(9999).describe("Image pool slot: Image 3.<image>."),
        file_name: z.string().optional().describe('File name in the images folder, e.g. "newtonhaus.png". Required with content_base64; defaults to path\'s file name.'),
        content_base64: z.string().optional().describe("The file's bytes, base64. Give this or path."),
        path: z.string().optional().describe("A file on the MCP server's host to send instead of content_base64."),
        name: z.string().optional().describe('Name for the image (the console names it "[<file>_png]" otherwise).'),
        replace_file: z.boolean().optional().describe("Overwrite a different file of the same name in the images folder (default false: refuse)."),
        overwrite: z.boolean().optional().describe("Replace an image already in the slot (default false: refuse)."),
      },
    },
    async (args) => operation(() => imageAdd(ctx, args as ImageAddArgs)),
  );

  server.registerTool(
    "gma3_build_bitmap",
    {
      title: "Build a bitmap (pixel mapping)",
      description:
        "Store Bitmap <bitmap> and set its BitmapConfig 1: content = Image 3.<image> (import it first with gma3_image_add), width/height of the canvas in selection-grid squares (default 64; match the group's grid, e.g. 40 x 2 for two 40-cell strands), content_mode (None, Clip, ...), interpolate, alpha, control x/y/zoom/aspect/rotate; optionally the channels (replacing the five defaults Dimmer<-Intensity, Dimmer<-Const, ColorRGB_R/G/B<-Red/Green/Blue), a name and a speed master. " +
        "Pre-checks: the image exists, Bitmap <bitmap> is free unless overwrite: true, apply's group and store's target exist / are free. Read-back: every asked setting of the bitmap (matched or mismatched). " +
        "apply: { group } selects the group and sends At Bitmap; store: { preset } or { sequence, cue } then stores the programmer. Apply and store are UNVERIFIED: the tool reports what the programmer and the stored object read but never claims a match, and leaves the selection and programmer values (gma3_clear_programmer). List bitmaps and images with gma3_bitmaps. Needs bridge 0.57.0.",
      inputSchema: {
        bitmap: z.number().int().min(1).max(9999).describe("Bitmap pool number."),
        image: z.union([z.number().int(), z.string()]).describe('The image: its number in the Images pool, or "3.<n>".'),
        name: z.string().optional(),
        width: z.number().int().optional().describe("Canvas width in selection-grid squares (console default 64)."),
        height: z.number().int().optional().describe("Canvas height in selection-grid squares (console default 64)."),
        content_mode: z.string().optional().describe('ContentMode: "None" (console default) or "Clip" (scale the media to the whole canvas), ...'),
        interpolate: z.boolean().optional(),
        alpha: z.boolean().optional(),
        control: z.object({ x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional(), aspect: z.number().optional(), rotate: z.number().optional() }).optional().describe("ControlX/Y/Zoom/Aspect/Rotate of the config."),
        channels: z
          .array(z.object({ attribute: z.string(), source: z.string().describe(SOURCES.join(", ")), low: z.number().optional(), high: z.number().optional() }))
          .min(1)
          .max(32)
          .optional()
          .describe("Replace the bitmap's channels: which attribute follows which part of the media (unverified on a console)."),
        speed_master: z.string().optional().describe("The bitmap's speed master, as the console names it."),
        overwrite: z.boolean().optional().describe("Replace a bitmap already in the slot (default false: refuse)."),
        apply: z.object({ group: z.number().int() }).optional().describe("Select the group and apply the bitmap (unverified)."),
        store: z
          .object({ preset: z.string().optional(), sequence: z.number().int().optional(), cue: z.union([z.number(), z.string()]).optional(), overwrite: z.boolean().optional() })
          .optional()
          .describe('After apply: store the programmer into a preset ("4.12") or a cue (unverified).'),
      },
    },
    async (args) => operation(() => buildBitmap(ctx, args as BuildArgs)),
  );
};
