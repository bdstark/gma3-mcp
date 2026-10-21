/**
 * SU-22: put a fixture-type file into the console's user library (SETUP.md SU-22,
 * docs/probes/su-22-library-add-macos-2.5.1.md), so gma3_patch_import can import it with no file access outside MCP.
 *
 *   gma3_patch_library_add   checks the file here (name, size, a GDTF is a zip with description.xml, an .xml has a
 *                            FixtureType element), checks the console's libraries (not there yet unless replace, not
 *                            in another library), sends the bytes in chunks over the bridge and reads the file back
 *                            (size, CRC-32, listed under source "user")
 *
 * Bridge ops patch.libraryStat / patch.libraryAdd (0.38.0). The bytes travel over the bridge, so the client need not
 * be on the console's machine. A file is written next to its target as "<file>.<upload id>.gma3mcp-part" and renamed into place
 * only after its size and CRC-32 match, so the library never holds a half-written file.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { asRead, buildResult, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import type { LibraryEntry } from "./patch.js";

export const LIBRARY_ADD_MAX_BYTES = 8 * 1024 * 1024;
/** Raw bytes per bridge request (64 KiB of base64, one JSON line). */
export const LIBRARY_ADD_CHUNK = 48 * 1024;
const NEEDS_BRIDGE = "the console runs an older bridge plugin without patch.libraryAdd (bridge 0.38.0); update the plugin";

/** manufacturer@model[@revision].gdtf|.xml, as the console's libraries name files. Throws a readable reason. */
export function libraryFileName(raw: unknown): { file: string; format: "gdtf" | "xml"; manufacturer: string; model: string; revision?: string } {
  if (typeof raw !== "string" || raw === "") throw new Error("file_name is required: manufacturer@model[@revision].gdtf or .xml");
  if (raw.length > 200) throw new Error("file_name is longer than 200 characters");
  if (/[/\\"\u0000-\u001f\u007f]/.test(raw) || raw.startsWith(".") || raw.includes("..")) throw new Error('file_name must not contain / \\ " .. or a control character, nor start with a dot');
  const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(raw);
  const format = m?.[2].toLowerCase();
  if (!m || (format !== "gdtf" && format !== "xml")) throw new Error("file_name must end in .gdtf or .xml");
  const parts = m[1].split("@");
  if (parts.length < 2 || parts.length > 3) throw new Error(`file_name must be manufacturer@model[@revision].${format}`);
  if (parts.some((p) => p === "" || p !== p.trim())) throw new Error("manufacturer, model and revision in file_name must be non-empty, without leading or trailing spaces");
  return { file: raw, format, manufacturer: parts[0], model: parts[1], ...(parts[2] ? { revision: parts[2] } : {}) };
}

/** Strict base64 (whitespace allowed between groups): Buffer.from alone silently skips bad characters. */
export function decodeBase64(raw: string): Buffer {
  const s = raw.replace(/\s+/g, "");
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("content_base64 is not valid base64");
  return Buffer.from(s, "base64");
}

export interface FixtureHeader {
  manufacturer?: string;
  name?: string;
  shortName?: string;
  modes: string[];
  dataVersion?: string;
  files?: number;
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  /** 0 for the root element. */
  depth: number;
}

const XML_NAME = "[A-Za-z_:][\\w:.-]*";
const START_TAG = new RegExp(`<(${XML_NAME})`, "y");
const END_TAG = new RegExp(`</(${XML_NAME})\\s*>`, "y");
const ATTRIBUTE = new RegExp(`\\s+(${XML_NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, "y");
const TAG_CLOSE = /\s*(\/?)>/y;
// A processing instruction's target, then whitespace or its end. The XML declaration's own grammar (XML 1.0, 2.8).
const PI_TARGET = new RegExp(`^<\\?(${XML_NAME})(?:\\s|\\?>)`);
const XML_DECLARATION = /^<\?xml\s+version\s*=\s*(?:"1\.\d+"|'1\.\d+')(?:\s+encoding\s*=\s*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/;
const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
/** XML 1.0 Char: tab, newline, carriage return, U+0020-D7FF, U+E000-FFFD, U+10000-10FFFF. */
const xmlChar = (n: number) => n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
// A literal character outside XML 1.0 Char: C0 controls but tab/LF/CR, U+FFFE/FFFF, an unpaired surrogate.
const FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The elements of an XML document in document order, after a strict well-formedness check: one root element, tags
 * nested and closed, attributes quoted (either quote) and not repeated, comments, CDATA and processing instructions
 * skipped, only the predefined and numeric character entities. A DOCTYPE is refused, so no entity is ever resolved.
 * Throws a readable reason. (Review of PR #84: a regex took a commented-out FixtureType for a real one.)
 */
export function parseXml(text: string): XmlElement[] {
  const s = text.startsWith("﻿") ? text.slice(1) : text;
  const out: XmlElement[] = [];
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`it is not well-formed XML: ${why} at character ${i}`);
  };
  const forbidden = FORBIDDEN_CHAR.exec(s);
  if (forbidden) {
    i = forbidden.index;
    fail(`a character XML does not allow (U+${forbidden[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")})`);
  }
  // Every & must start one of the allowed entities.
  const decode = (v: string): string => {
    let bad = false;
    const r = v.replace(/&([^;&<]{0,10});?/g, (m, body: string) => {
      if (!m.endsWith(";")) return ((bad = true), m);
      // Own properties only: "toString" or "__proto__" is not an XML entity (review of PR #84).
      if (Object.hasOwn(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
      const n = /^#\d+$/.test(body) ? Number(body.slice(1)) : /^#x[0-9A-Fa-f]+$/.test(body) ? parseInt(body.slice(2), 16) : NaN;
      if (!Number.isInteger(n) || !xmlChar(n)) return ((bad = true), m);
      return String.fromCodePoint(n);
    });
    if (bad) fail("an undefined entity, a reference to a character XML does not allow, or a bare &");
    return r;
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const chunk = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (stack.length === 0 && chunk.trim() !== "") fail("text outside the root element");
    decode(chunk);
    if (chunk.includes("]]>")) fail("]]> outside a CDATA section");
    if (lt < 0) break;
    i = lt;
    if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      if (e < 0) fail("an unclosed comment");
      const body = s.slice(i + 4, e);
      if (body.includes("--") || body.endsWith("-")) fail("-- inside a comment, or a comment ending in -");
      i = e + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      if (stack.length === 0) fail("CDATA outside the root element");
      const e = s.indexOf("]]>", i + 9);
      if (e < 0) fail("an unclosed CDATA section");
      i = e + 3;
    } else if (s.startsWith("<!", i)) {
      fail("a DOCTYPE or other declaration (refused: no entities are resolved)");
    } else if (s.startsWith("<?", i)) {
      const e = s.indexOf("?>", i + 2);
      if (e < 0) fail("an unclosed processing instruction");
      const pi = s.slice(i, e + 2);
      const target = PI_TARGET.exec(pi)?.[1] ?? fail("a processing instruction without a target name");
      if (target.toLowerCase() === "xml") {
        if (i !== 0) fail("an XML declaration that is not at the start");
        if (target !== "xml" || !XML_DECLARATION.test(pi)) fail("a malformed XML declaration (version, then optional encoding and standalone)");
        const enc = /encoding\s*=\s*["']([^"']*)["']/.exec(pi)?.[1];
        if (enc !== undefined && !/^utf-?8$/i.test(enc)) fail(`the encoding ${enc} (the file is read as UTF-8)`);
      }
      i = e + 2;
    } else if (s.startsWith("</", i)) {
      END_TAG.lastIndex = i;
      const m = END_TAG.exec(s) ?? fail("a malformed end tag");
      const open = stack.pop();
      if (open !== m[1]) fail(open ? `</${m[1]}> closing <${open}>` : `</${m[1]}> with no open element`);
      i = END_TAG.lastIndex;
    } else {
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(s) ?? fail("a malformed tag");
      const name = m[1];
      i = START_TAG.lastIndex;
      const attrs: Record<string, string> = Object.create(null);
      for (;;) {
        TAG_CLOSE.lastIndex = i;
        const c = TAG_CLOSE.exec(s);
        if (c) {
          i = TAG_CLOSE.lastIndex;
          if (stack.length === 0 && ++roots > 1) fail("a second root element");
          out.push({ name, attrs, depth: stack.length });
          if (!c[1]) stack.push(name);
          break;
        }
        ATTRIBUTE.lastIndex = i;
        const a = ATTRIBUTE.exec(s) ?? fail(`a malformed attribute in <${name}>`);
        if (Object.hasOwn(attrs, a[1])) fail(`the attribute ${a[1]} twice in <${name}>`);
        attrs[a[1]] = decode(a[2] ?? a[3]);
        i = ATTRIBUTE.lastIndex;
      }
    }
  }
  if (stack.length) fail(`<${stack[stack.length - 1]}> is not closed`);
  if (roots === 0) fail("no root element");
  return out;
}

function fixtureHeader(xml: string, root: "GDTF" | "GMA3"): FixtureHeader {
  const els = parseXml(xml);
  if (els[0].name !== root) throw new Error(`its root element is <${els[0].name}>, not <${root}>`);
  const ft = els.find((e) => e.name === "FixtureType" && e.depth === 1);
  if (!ft) throw new Error(`it has no FixtureType element under <${root}>`);
  if (!ft.attrs.Name) throw new Error("its FixtureType element has no Name");
  const modes = els.filter((e) => e.name === "DMXMode" && e.depth > 1 && e.attrs.Name !== undefined).map((e) => e.attrs.Name);
  const dataVersion = els[0].attrs.DataVersion;
  return { manufacturer: ft.attrs.Manufacturer, name: ft.attrs.Name, shortName: ft.attrs.ShortName, modes, ...(dataVersion !== undefined ? { dataVersion } : {}) };
}

/** The entries of a zip file (central directory), and one entry's bytes. Zip64 and encrypted entries are refused. */
export function readZip(buf: Buffer): { names: string[]; read: (name: string) => Buffer } {
  const min = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  // The record whose comment length ends it at the end of the file: a comment may itself contain the signature.
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("it is not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("it is a zip64 file, which is not supported");
  const entries = new Map<string, { method: number; flags: number; crc: number; comp: number; size: number; local: number }>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("its zip central directory is damaged");
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.set(name, { flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16), comp: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`it has no ${name}`);
      if (e.flags & 1) throw new Error(`its ${name} is encrypted`);
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`its ${name} entry is damaged`);
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const comp = buf.subarray(start, start + e.comp);
      let data: Buffer;
      if (e.method === 0) data = comp;
      else if (e.method === 8) {
        try {
          data = inflateRawSync(comp, { maxOutputLength: LIBRARY_ADD_MAX_BYTES * 4 });
        } catch (err) {
          throw new Error(`its ${name} cannot be inflated (${(err as Error).message})`);
        }
      } else throw new Error(`its ${name} uses zip compression method ${e.method} (only stored and deflate are read)`);
      if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`its ${name} fails the zip CRC check`);
      return data;
    },
  };
}

/** The text of a UTF-8 file; invalid UTF-8 is refused instead of being replaced with U+FFFD. */
function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("it is not valid UTF-8");
  }
}

/** What the console will be given: a GDTF zip with description.xml, or a grandMA3 fixture-type XML. Throws a reason. */
export function checkContent(format: "gdtf" | "xml", bytes: Buffer): FixtureHeader {
  if (format === "gdtf") {
    const zip = readZip(bytes);
    if (!zip.names.includes("description.xml")) throw new Error("the GDTF has no description.xml at the top of the zip");
    const xml = utf8(zip.read("description.xml"));
    try {
      return { ...fixtureHeader(xml, "GDTF"), files: zip.names.length };
    } catch (err) {
      throw new Error(`its description.xml: ${(err as Error).message}`);
    }
  }
  return fixtureHeader(utf8(bytes), "GMA3");
}

interface Stat {
  file: string;
  path: string;
  exists: boolean;
  size?: number;
  crc32?: string;
  listedIn: string[];
  /** Every library entry equal to the name ignoring case (bridge 0.38.0). */
  matches?: Array<{ source: string; file: string }>;
  maxBytes?: number;
}

interface AddArgs {
  file_name?: string;
  content_base64?: string;
  path?: string;
  replace?: boolean;
}

const hex = (n: number) => n.toString(16).padStart(8, "0");

export async function patchLibraryAdd(ctx: ToolContext, raw: AddArgs): Promise<OperationResult> {
  const op = "patch_library_add";
  const errors: string[] = [];
  const hasContent = raw.content_base64 !== undefined;
  const hasPath = raw.path !== undefined;
  if (hasContent === hasPath) errors.push("give exactly one of content_base64 (the file's bytes) or path (a file on the MCP server's host)");
  if (hasPath && (typeof raw.path !== "string" || raw.path === "")) errors.push("path must be a file path");
  if (raw.replace !== undefined && typeof raw.replace !== "boolean") errors.push("replace must be true or false");
  let name: ReturnType<typeof libraryFileName> | undefined;
  try {
    name = libraryFileName(raw.file_name ?? (hasPath && typeof raw.path === "string" ? basename(raw.path) : undefined));
  } catch (err) {
    errors.push((err as Error).message);
  }
  let bytes: Buffer | undefined;
  if (hasContent && errors.length === 0) {
    if (typeof raw.content_base64 !== "string") errors.push("content_base64 must be text");
    // Counted without whitespace: decodeBase64 allows line-wrapped base64 (review of PR #84).
    else if (raw.content_base64.replace(/\s+/g, "").length > Math.ceil(LIBRARY_ADD_MAX_BYTES / 3) * 4) errors.push(`the file is larger than ${LIBRARY_ADD_MAX_BYTES} bytes`);
    else {
      try {
        bytes = decodeBase64(raw.content_base64);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  const target: Record<string, unknown> = { file: name?.file ?? raw.file_name ?? null, source: "user", ...(hasPath ? { path: raw.path } : {}), replace: raw.replace === true };
  if (errors.length || !name) return validationFailure(op, target, errors);
  const file = name.file;

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    const stop = (step: StepResult, why = "nothing was written") => {
      steps.push(step);
      return buildResult({ operation: op, target, steps, verification: unavailable(why) });
    };

    if (!bytes) {
      try {
        const st = await stat(raw.path as string);
        if (!st.isFile()) return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} is not a file` }));
        if (st.size > LIBRARY_ADD_MAX_BYTES) return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} has ${st.size} bytes; the limit is ${LIBRARY_ADD_MAX_BYTES}` }));
        bytes = await readFile(raw.path as string);
        steps.push(asRead({ name: "read_file", status: "succeeded", detail: { path: raw.path, size: bytes.length } }));
      } catch (err) {
        return stop(asRead({ name: "read_file", status: "failed", error: `${raw.path} cannot be read: ${(err as Error).message}` }));
      }
    }
    const sum = hex(crc32(bytes));
    if (bytes.length === 0) return stop(asRead({ name: "check_content", status: "failed", error: "the file is empty" }));
    if (bytes.length > LIBRARY_ADD_MAX_BYTES) return stop(asRead({ name: "check_content", status: "failed", error: `the file has ${bytes.length} bytes; the limit is ${LIBRARY_ADD_MAX_BYTES}` }));
    let header: FixtureHeader;
    try {
      header = checkContent(name.format, bytes);
      steps.push(asRead({ name: "check_content", status: "succeeded", detail: { format: name.format, size: bytes.length, crc32: sum, ...header } }));
    } catch (err) {
      return stop(asRead({ name: "check_content", status: "failed", error: `${file} is not a usable ${name.format === "gdtf" ? "GDTF" : "grandMA3 fixture-type XML"} file: ${(err as Error).message}`, detail: { size: bytes.length } }));
    }

    let before: Stat;
    try {
      before = (await ctx.bridge.request("patch.libraryStat", { file }, t)) as Stat;
    } catch (err) {
      if (err instanceof Error && /unknown op/i.test(err.message)) return stop(asRead({ name: "check_library", status: "failed", op: "patch.libraryStat", error: NEEDS_BRIDGE }));
      return stop(asRead(stepFromError("check_library", err, { op: "patch.libraryStat" })));
    }
    const elsewhere = before.listedIn.filter((s) => s !== "user");
    if (elsewhere.length) {
      return stop(asRead({ name: "check_library", status: "failed", op: "patch.libraryStat", error: `${file} is already in the ${elsewhere.join(", ")} library; Import Library names the file only and could not tell the two apart. Choose another file name (e.g. another revision)`, detail: before }));
    }
    // A name differing only in case is the same file on macOS and Windows: refused everywhere (review of PR #84).
    const caseOnly = (before.matches ?? []).filter((m) => m.file !== file);
    if (caseOnly.length) {
      return stop(asRead({ name: "check_library", status: "failed", op: "patch.libraryStat", error: `${file} differs only in case from ${caseOnly.map((m) => `${m.file} (${m.source})`).join(", ")}: one file on macOS and Windows, and Import Library could not tell them apart. Use that exact name (with replace: true for a user-library file) or another name`, detail: before }));
    }
    if (before.exists && raw.replace !== true) {
      const same = before.size === bytes.length && before.crc32 === sum;
      return stop(asRead({ name: "check_library", status: "failed", op: "patch.libraryStat", error: `${file} is already in the user library (${before.size} bytes, CRC-32 ${before.crc32}${same ? ", the same bytes" : ""}); pass replace: true to overwrite it`, detail: before }));
    }
    steps.push(asRead({ name: "check_library", status: "succeeded", op: "patch.libraryStat", detail: before }));

    const chunks = Math.ceil(bytes.length / LIBRARY_ADD_CHUNK);
    // The bridge keeps each upload's bytes apart by this id, so another client sending the same name cannot mix in.
    const upload = randomBytes(8).toString("hex");
    let added: { path?: string; size?: number; crc32?: string; replaced?: boolean } | undefined;
    for (let i = 0; i < chunks; i++) {
      const piece = bytes.subarray(i * LIBRARY_ADD_CHUNK, (i + 1) * LIBRARY_ADD_CHUNK);
      try {
        const res = (await ctx.bridge.request("patch.libraryAdd", { file, upload, offset: i * LIBRARY_ADD_CHUNK, data: piece.toString("base64"), total: bytes.length, crc32: sum, replace: raw.replace === true, final: i === chunks - 1 }, t)) as typeof added;
        if (i === chunks - 1) added = res;
      } catch (err) {
        const step = stepFromError("write", err, { op: "patch.libraryAdd", detail: { chunk: i + 1, chunks } });
        steps.push(step);
        // The bridge removes its part file on a refusal; after a lost reply it is removed here, best effort.
        let partLeft: boolean | undefined;
        try {
          partLeft = ((await ctx.bridge.request("patch.libraryAdd", { file, upload, abort: true }, t)) as { partLeft?: boolean }).partLeft;
        } catch {
          partLeft = undefined;
        }
        steps.push(asRead({ name: "clean_up", status: partLeft === false ? "succeeded" : "unknown", op: "patch.libraryAdd", detail: { partLeft: partLeft ?? "unknown" } }));
        return buildResult({ operation: op, target, steps, verification: unavailable(step.status === "unknown" ? "the last chunk's reply was lost; read the library with gma3_patch_library" : "the file was not written") });
      }
    }
    steps.push({ name: "write", status: "succeeded", op: "patch.libraryAdd", detail: { chunks, ...added } });

    let after: Stat | undefined;
    let entry: LibraryEntry | undefined;
    try {
      after = (await ctx.bridge.request("patch.libraryStat", { file }, t)) as Stat;
      const lib = (await ctx.bridge.request("patch.library", { file, sources: ["user"] }, t)) as { entries: LibraryEntry[] };
      entry = lib.entries[0];
      steps.push(asRead({ name: "read_back", status: "succeeded", op: "patch.libraryStat", detail: { ...after, libraryEntry: entry ?? null } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_back", err, { op: "patch.libraryStat" })));
    }
    const checked = "the console's file has the size and CRC-32 sent, and patch.library lists it under source user";
    const expected = { size: bytes.length, crc32: sum, source: "user" };
    let verification: Verification;
    if (!after) verification = unavailable("the file could not be read back", checked);
    else {
      const actual = { size: after.size ?? null, crc32: after.crc32 ?? null, source: entry?.source ?? null };
      verification = after.size === bytes.length && after.crc32 === sum && entry?.source === "user" ? { status: "matched", checked, expected, actual } : { status: "mismatched", checked, expected, actual, detail: !after.exists ? `${file} is not in the user library` : !entry ? `${file} is on disk but patch.library does not list it` : "the file on the console differs from the bytes sent" };
    }
    const fileMan = name.manufacturer.toLowerCase();
    const fileModel = name.model.toLowerCase();
    const claimable = header.manufacturer?.toLowerCase() === fileMan || header.name?.toLowerCase() === fileModel;
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      summary: verification.status === "matched" ? `Wrote ${file} to the user library (${bytes.length} bytes, CRC-32 ${sum})${added?.replaced ? ", replacing the earlier file" : ""}. Import it with gma3_patch_import { file: "${file}", source: "user", exclusive: true }.` : undefined,
      warnings: [
        ...(claimable ? [] : [`the file name says ${name.manufacturer} / ${name.model} but the fixture type is "${header.name}" by ${header.manufacturer ?? "?"}: gma3_patch_import claims a new type only when its name or manufacturer matches the file name, so it would refuse this one`]),
        ...(entry?.inShow?.length ? [`the show already has ${entry.inShow.map((x) => `type ${x.no} "${x.name}"`).join(", ")} matching this file`] : []),
      ],
      extra: {
        file,
        path: added?.path ?? after?.path ?? null,
        size: bytes.length,
        crc32: sum,
        replaced: added?.replaced ?? false,
        fixtureType: header,
        ...(entry ? { libraryEntry: entry } : {}),
        next: { tool: "gma3_patch_import", args: { file, source: "user", exclusive: true } },
      },
    });
  });
}

export const registerPatchLibraryAddTool: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_patch_library_add",
    {
      title: "Add a fixture-type file to the user library",
      description:
        "Put a fixture-type file (GDTF .gdtf, or a grandMA3 fixture-type .xml) into the console's user fixture library, so gma3_patch_import can import it. The bytes go over the bridge: the client need not be on the console's machine. " +
        "Give the file as content_base64 (its bytes, base64) with file_name, or as path (a file on the MCP server's host; file_name defaults to its name). file_name must be manufacturer@model[@revision].gdtf or .xml. " +
        `Pre-checks (nothing written on failure): the name; at most ${LIBRARY_ADD_MAX_BYTES / 1024 / 1024} MiB; a .gdtf is a zip whose description.xml has a FixtureType (its name, manufacturer and DMX modes are reported); an .xml has a FixtureType element; the name is not in the user library yet unless replace: true, and in no other library (Import Library could not tell them apart). ` +
        "The file is written next to its target and moved into place only when its size and CRC-32 match. Read-back: the file's size and CRC-32 on the console, and gma3_patch_library lists it under source user. The show is not changed. Needs bridge 0.38.0.",
      inputSchema: {
        file_name: z.string().optional().describe("Library file name, e.g. \"SHEHDS@180W_Beam@2026-10-20.gdtf\". Required with content_base64; defaults to path's file name."),
        content_base64: z.string().optional().describe("The file's bytes, base64. Give this or path."),
        path: z.string().optional().describe("A file on the MCP server's host to send instead of content_base64."),
        replace: z.boolean().optional().describe("Overwrite a file of the same name in the user library (default false: refuse)."),
      },
    },
    async (args) => operation(() => patchLibraryAdd(ctx, args as AddArgs)),
  );
};
