/**
 * #149: read an MVR file (My Virtual Rig, the GDTF project's scene format: a zip with GeneralSceneDescription.xml and
 * the GDTF files it names) into the fixtures gma3_patch_import_mvr patches and places. Pure: no console access.
 *
 * What is read, per Fixture anywhere under Scene/Layers (inside GroupObjects, Trusses or other objects' ChildLists):
 *   uuid, name, FixtureIDNumeric (else FixtureID as an integer), GDTFSpec (a file in the zip), GDTFMode, Addresses
 *   (Address elements with a break attribute; an integer is the absolute 1-based DMX address, so 513 is 2.001; a
 *   "U.A" text is taken as it is) and the world transform: every Matrix from the Layer down, composed. A Matrix is
 *   {u}{v}{w}{o}: the three basis vectors of the object's axes and its offset in millimetres, in the parent's frame.
 *
 * The rotation is given as the console's angles: grandMA3 builds a fixture's rotation as q = qZ·qY·qX (probe
 * 2026-10-15, src/tools/positions.ts), so R = Rz·Ry·Rx and the angles come from R's first column (u) and last row.
 * RoyX4's fork (scripts/mvr-inspect.py) reads the matrix the same way: u, v, w are the columns of R.
 */
import { checkContent, parseXml, readZip, type FixtureHeader, type XmlElement } from "./tools/patchlibrary.js";

export const MVR_MAX_BYTES = 64 * 1024 * 1024;
export const MVR_MAX_FIXTURES = 1024;
/** The highest fixture number the console patches (PATCH_MAX_FID in the bridge plugin). */
export const MAX_FID = 99_999_999;
/** One GDTF in the zip: the same limit gma3_patch_library_add sends. */
export const GDTF_MAX_BYTES = 8 * 1024 * 1024;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MvrFixture {
  uuid: string;
  name: string;
  /** The MVR layer (Layer name) the fixture is in. */
  layer: string;
  /** Names of the objects between the layer and the fixture (GroupObject, Truss ...), outermost first. */
  path: string[];
  fid?: number;
  /** FixtureID as written, when FixtureIDNumeric is absent or 0. */
  fixtureId?: string;
  gdtfSpec: string;
  gdtfMode: string;
  /** Patched breaks, sorted by break: U.AAA. */
  addresses: Array<{ break: number; address: string }>;
  /** Metres, world frame. */
  position: Vec3;
  /** Degrees, the console's rotation (q = qZ·qY·qX). */
  rotation: Vec3;
  /** Problems with this fixture's own data (unreadable matrix, bad address ...); a fixture with any is not imported. */
  problems: string[];
}

export interface MvrGdtf {
  /** The GDTFSpec as the fixtures name it. */
  spec: string;
  /** The zip entry that holds it, when found. */
  entry?: string;
  bytes?: Buffer;
  header?: FixtureHeader;
  /** DMX footprint per mode name from the GDTF's DMXChannels; null when it cannot be told from the file alone. */
  footprints: Record<string, number | null>;
  /** Number of DMX breaks per mode. */
  breaks: Record<string, number>;
  problem?: string;
}

export interface MvrScene {
  version: string;
  provider?: string;
  layers: string[];
  fixtures: MvrFixture[];
  gdtfs: Map<string, MvrGdtf>;
  /** Scene objects that are not fixtures, by element name (Truss, SceneObject ...): not imported. */
  otherObjects: Record<string, number>;
}

type Mat = number[]; // 3x4 row-major: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** A Matrix text {u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{o1,o2,o3} as a 3x4 matrix with u, v, w as columns. Throws. */
export function parseMatrix(text: string): Mat {
  const value = text.replace(/\s+/g, "");
  const groups = [...value.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  if (groups.length !== 4 || groups.map((g) => `{${g}}`).join("") !== value) throw new Error("a Matrix must be four {x,y,z} groups");
  const rows = groups.map((g) => g.split(",").map((n) => (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(n) ? Number(n) : NaN)));
  if (rows.some((r) => r.length !== 3 || r.some((n) => !Number.isFinite(n)))) throw new Error("a Matrix group must hold three finite numbers");
  const [u, v, w, o] = rows;
  return [u[0], v[0], w[0], o[0], u[1], v[1], w[1], o[1], u[2], v[2], w[2], o[2]];
}

/** a ∘ b: b in a's frame. */
export function compose(a: Mat, b: Mat): Mat {
  const out: Mat = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += a[r * 4 + k] * b[k * 4 + c];
      out.push(c === 3 ? v + a[r * 4 + 3] : v);
    }
  }
  return out;
}

const deg = (r: number) => (r * 180) / Math.PI;
const round = (n: number, d: number) => {
  const f = 10 ** d;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? 0 : v;
};

/**
 * Position (metres) and the console's rotation angles (degrees) of a world matrix. Throws when the rotation part is
 * not a rotation (scaled, sheared or mirrored), which the console's fixture position cannot hold.
 */
export function poseOf(m: Mat): { position: Vec3; rotation: Vec3 } {
  const col = (c: number) => [m[c], m[4 + c], m[8 + c]];
  const [u, v, w] = [col(0), col(1), col(2)];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const [name, a] of [["u", u], ["v", v], ["w", w]] as const) {
    if (Math.abs(Math.sqrt(dot(a, a)) - 1) > 1e-3) throw new Error(`its matrix is scaled (|${name}| = ${round(Math.sqrt(dot(a, a)), 4)}); only rotation and translation are imported`);
  }
  if (Math.abs(dot(u, v)) > 1e-3 || Math.abs(dot(u, w)) > 1e-3 || Math.abs(dot(v, w)) > 1e-3) throw new Error("its matrix is sheared (the axes are not perpendicular)");
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  if (dot(cross, w) < 0) throw new Error("its matrix is mirrored (left-handed); the console's rotation cannot hold a mirror");
  // R = Rz(c)·Ry(b)·Rx(a): R[2][0] = -sin b, R[2][1] = cos b sin a, R[2][2] = cos b cos a, R[1][0] = sin c cos b, R[0][0] = cos c cos b.
  const sb = Math.max(-1, Math.min(1, -u[2]));
  const b = Math.asin(sb);
  let a: number;
  let c: number;
  if (Math.abs(Math.cos(b)) > 1e-6) {
    a = Math.atan2(v[2], w[2]);
    c = Math.atan2(u[1], u[0]);
  } else {
    // Gimbal lock: only a - c (or a + c) is defined; a = 0 puts it all in c. Then v = Rz·Ry·(0,1,0) = (-sin c, cos c, 0).
    a = 0;
    c = Math.atan2(-v[0], v[1]);
  }
  return {
    position: { x: round(m[3] / 1000, 6), y: round(m[7] / 1000, 6), z: round(m[11] / 1000, 6) },
    rotation: { x: round(deg(a), 4), y: round(deg(b), 4), z: round(deg(c), 4) },
  };
}

/** An MVR Address text as U.AAA: an integer is the absolute 1-based address (513 = 2.001), "U.A" is taken as given. */
export function mvrAddress(text: string): string | null {
  const t = text.trim();
  const ua = /^(\d+)\.(\d+)$/.exec(t);
  let u: number;
  let a: number;
  if (ua) {
    u = Number(ua[1]);
    a = Number(ua[2]);
  } else if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n < 1) return null;
    u = Math.floor((n - 1) / 512) + 1;
    a = ((n - 1) % 512) + 1;
  } else return null;
  if (u < 1 || u > 1024 || a < 1 || a > 512) return null;
  return `${u}.${String(a).padStart(3, "0")}`;
}

function children(els: XmlElement[], index: number): number[] {
  const out: number[] = [];
  for (let i = index + 1; i < els.length && els[i].depth > els[index].depth; i++) if (els[i].parent === index) out.push(i);
  return out;
}
const child = (els: XmlElement[], index: number, name: string): number | undefined => children(els, index).find((i) => els[i].name === name);
const childText = (els: XmlElement[], index: number, name: string): string | undefined => {
  const c = child(els, index, name);
  return c === undefined ? undefined : (els[c].text ?? "").trim();
};

/** Per mode: the DMX footprint of break 1 and the number of breaks, from description.xml; null footprint when GeometryReferences repeat channels. */
export function gdtfModes(els: XmlElement[]): { footprints: Record<string, number | null>; breaks: Record<string, number> } {
  const footprints: Record<string, number | null> = {};
  const breaks: Record<string, number> = {};
  const refNames = new Set(els.filter((e) => e.name === "GeometryReference" && e.attrs.Name).map((e) => e.attrs.Name));
  els.forEach((e, i) => {
    if (e.name !== "DMXMode" || e.attrs.Name === undefined) return;
    let max = 0;
    let unknown = false;
    const seenBreaks = new Set<number>();
    for (let j = i + 1; j < els.length && els[j].depth > e.depth; j++) {
      const ch = els[j];
      if (ch.name !== "DMXChannel") continue;
      const brk = ch.attrs.DMXBreak === undefined || ch.attrs.DMXBreak === "Overwrite" ? 1 : Number(ch.attrs.DMXBreak);
      if (Number.isInteger(brk)) seenBreaks.add(brk);
      if (ch.attrs.Geometry !== undefined && refNames.has(ch.attrs.Geometry)) unknown = true;
      const off = ch.attrs.Offset;
      if (off === undefined || off === "" || off === "None") continue;
      for (const n of off.split(",").map(Number)) {
        if (!Number.isInteger(n) || n < 1) unknown = true;
        else if (brk === 1) max = Math.max(max, n);
      }
    }
    footprints[e.attrs.Name] = unknown || max === 0 ? null : max;
    breaks[e.attrs.Name] = Math.max(1, seenBreaks.size);
  });
  return { footprints, breaks };
}

const KINDS_WITH_CHILDREN = new Set(["Layer", "GroupObject", "Fixture", "SceneObject", "Truss", "Support", "VideoScreen", "Projector"]);

/** Read an MVR file. Throws a readable reason for anything that makes the whole file unusable. */
export function parseMvr(bytes: Buffer): MvrScene {
  const zip = readZip(bytes);
  const descName = zip.names.find((n) => n === "GeneralSceneDescription.xml") ?? zip.names.find((n) => n.toLowerCase() === "generalscenedescription.xml");
  if (!descName) throw new Error("it has no GeneralSceneDescription.xml at the top of the zip (is it an MVR file?)");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(zip.read(descName));
  } catch (err) {
    throw new Error(`its GeneralSceneDescription.xml cannot be read: ${(err as Error).message}`);
  }
  let els: XmlElement[];
  try {
    els = parseXml(text);
  } catch (err) {
    throw new Error(`its GeneralSceneDescription.xml: ${(err as Error).message}`);
  }
  if (els[0].name !== "GeneralSceneDescription") throw new Error(`its root element is <${els[0].name}>, not <GeneralSceneDescription>`);
  const version = `${els[0].attrs.verMajor ?? "?"}.${els[0].attrs.verMinor ?? "?"}`;
  const scene = child(els, 0, "Scene");
  if (scene === undefined) throw new Error("it has no Scene element");
  const layersEl = child(els, scene, "Layers");
  const layers: string[] = [];
  const fixtures: MvrFixture[] = [];
  const otherObjects: Record<string, number> = {};
  const matrixOf = (i: number): Mat => {
    const t = childText(els, i, "Matrix");
    return t === undefined || t === "" ? IDENTITY : parseMatrix(t);
  };

  const walk = (i: number, parent: Mat, layer: string, path: string[], inherited?: string) => {
    const e = els[i];
    let world: Mat = parent;
    let matrixProblem: string | undefined;
    try {
      world = compose(parent, matrixOf(i));
    } catch (err) {
      matrixProblem = `${e.name} "${e.attrs.name ?? ""}": ${(err as Error).message}`;
    }
    matrixProblem = inherited ?? matrixProblem;
    if (e.name === "Fixture") {
      const problems: string[] = [];
      if (matrixProblem) problems.push(matrixProblem);
      const numeric = childText(els, i, "FixtureIDNumeric");
      const idText = childText(els, i, "FixtureID");
      let fid: number | undefined;
      if (numeric !== undefined && /^\d+$/.test(numeric) && Number(numeric) > 0) fid = Number(numeric);
      else if (idText !== undefined && /^\d+$/.test(idText) && Number(idText) > 0) fid = Number(idText);
      // The console's fixture numbers end at 99,999,999 (PATCH_MAX_FID in the bridge): a larger one is this fixture's
      // problem, so skip_unusable can leave it out instead of the range check refusing the whole call (review of #162).
      if (fid !== undefined && fid > MAX_FID) problems.push(`its fixture number ${fid} is above the console's ${MAX_FID}`);
      const addressesEl = child(els, i, "Addresses");
      const addresses: Array<{ break: number; address: string }> = [];
      if (addressesEl !== undefined) {
        for (const a of children(els, addressesEl)) {
          if (els[a].name !== "Address") continue;
          const raw = (els[a].text ?? "").trim();
          const brk = els[a].attrs.break === undefined ? 0 : Number(els[a].attrs.break);
          if (raw === "0") continue; // 0: not patched
          const addr = mvrAddress(raw);
          if (!Number.isInteger(brk) || brk < 0) problems.push(`its Address break "${els[a].attrs.break}" is not a break number`);
          else if (!addr) problems.push(`its Address "${raw}" is not a DMX address (1..524288 or U.A)`);
          else addresses.push({ break: brk, address: addr });
        }
      }
      addresses.sort((x, y) => x.break - y.break);
      let pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
      if (!matrixProblem) {
        try {
          pose = poseOf(world);
        } catch (err) {
          problems.push((err as Error).message);
        }
      }
      fixtures.push({
        uuid: e.attrs.uuid ?? "",
        name: (e.attrs.name ?? "").trim(),
        layer,
        path,
        ...(fid !== undefined ? { fid } : {}),
        ...(fid === undefined && idText ? { fixtureId: idText } : {}),
        gdtfSpec: childText(els, i, "GDTFSpec") ?? "",
        gdtfMode: childText(els, i, "GDTFMode") ?? "",
        addresses,
        ...pose,
        problems,
      });
    } else if (e.name !== "Layer") otherObjects[e.name] = (otherObjects[e.name] ?? 0) + 1;
    const list = child(els, i, "ChildList");
    if (list === undefined) return;
    const nextPath = e.name === "Layer" ? path : [...path, e.attrs.name ?? e.name];
    for (const c of children(els, list)) if (KINDS_WITH_CHILDREN.has(els[c].name) || els[c].name === "FocusPoint") walk(c, world, layer, nextPath, matrixProblem);
  };

  if (layersEl !== undefined) {
    for (const l of children(els, layersEl)) {
      if (els[l].name !== "Layer") continue;
      const name = els[l].attrs.name ?? `Layer ${layers.length + 1}`;
      layers.push(name);
      walk(l, IDENTITY, name, []);
    }
  }

  // The GDTFs the fixtures name, read from the zip (each once).
  const gdtfs = new Map<string, MvrGdtf>();
  for (const f of fixtures) {
    if (!f.gdtfSpec || gdtfs.has(f.gdtfSpec)) continue;
    const spec = f.gdtfSpec;
    const wanted = spec.toLowerCase().endsWith(".gdtf") ? spec : `${spec}.gdtf`;
    const entry = zip.names.find((n) => n === wanted) ?? zip.names.find((n) => n.toLowerCase() === wanted.toLowerCase());
    const g: MvrGdtf = { spec, footprints: {}, breaks: {} };
    if (!entry) g.problem = `the MVR has no ${wanted} for GDTFSpec "${spec}"`;
    else {
      g.entry = entry;
      try {
        const b = zip.read(entry);
        if (b.length > GDTF_MAX_BYTES) throw new Error(`it has ${b.length} bytes; the limit is ${GDTF_MAX_BYTES}`);
        g.bytes = b;
        g.header = checkContent("gdtf", b);
        const desc = parseXml(new TextDecoder("utf-8", { fatal: true }).decode(readZip(b).read("description.xml")));
        Object.assign(g, gdtfModes(desc));
      } catch (err) {
        g.problem = `${entry}: ${(err as Error).message}`;
      }
    }
    gdtfs.set(spec, g);
  }

  return { version, ...(els[0].attrs.provider ? { provider: els[0].attrs.provider } : {}), layers, fixtures, gdtfs, otherObjects };
}
