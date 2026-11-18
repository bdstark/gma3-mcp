import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { startHarness, type Harness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { compose, gdtfModes, mvrAddress, parseMatrix, parseMvr, poseOf } from "../src/mvr.js";
import { blocksOf, consoleName, gdtfLibraryName, mvrImport, registerMvrTools, type MvrDeps, type PlannedFixture, type SubTool } from "../src/tools/mvr.js";
import { parseXml } from "../src/tools/patchlibrary.js";
import { quatEquivalent, quatFromEuler } from "../src/tools/positions.js";
import type { OperationResult } from "../src/results.js";

/**
 * #149 gma3_patch_import_mvr. The MVR and its GDTFs are built here as zips (stored entries), so no binary fixture is
 * checked in. The console side is a fake bridge for the reads (patch.state, patch.types, patch.check ranges,
 * patch.libraryStat); the structured tools the import runs are replaced by recorders, since each has its own tests.
 */

// --- a minimal zip writer (stored entries) -------------------------------------------------------------------------
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

function gdtf(manufacturer: string, name: string, modes: Array<{ name: string; offsets: string[]; breaks?: number[] }>): Buffer {
  const modeXml = modes
    .map(
      (m) =>
        `<DMXMode Name="${m.name}" Geometry="Body"><DMXChannels>${m.offsets.map((o, i) => `<DMXChannel DMXBreak="${m.breaks?.[i] ?? 1}" Offset="${o}" Geometry="Body"/>`).join("")}</DMXChannels></DMXMode>`,
    )
    .join("");
  return zip({ "description.xml": `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2"><FixtureType Name="${name}" ShortName="${name}" Manufacturer="${manufacturer}" FixtureTypeID="00000000-0000-0000-0000-000000000001"><Geometries><Geometry Name="Body"/></Geometries><DMXModes>${modeXml}</DMXModes></FixtureType></GDTF>` });
}

const SPOT = gdtf("ACME", "Spot 300", [
  { name: "Standard", offsets: ["1", "2,3", "4", "5", "6", "7", "8"] },
  { name: "Basic", offsets: ["1", "2", "3", "4"] },
]);
const WASH = gdtf("Glow Co", "Wash 7", [{ name: "8ch", offsets: ["1", "2", "3", "4", "5", "6", "7", "8"] }]);
const TWOBREAK = gdtf("Glow Co", "Split", [{ name: "Two", offsets: ["1", "1"], breaks: [1, 2] }]);

interface Fx {
  name: string;
  fid?: number;
  fixtureId?: string;
  spec?: string;
  mode?: string;
  addresses?: Array<[number, string]>;
  matrix?: string;
}
const fixtureXml = (f: Fx, i: number) =>
  `<Fixture name="${f.name}" uuid="00000000-0000-0000-0000-${String(i).padStart(12, "0")}">` +
  (f.matrix ? `<Matrix>${f.matrix}</Matrix>` : "") +
  `<GDTFSpec>${f.spec ?? "ACME@Spot_300.gdtf"}</GDTFSpec><GDTFMode>${f.mode ?? "Standard"}</GDTFMode>` +
  (f.fid !== undefined ? `<FixtureIDNumeric>${f.fid}</FixtureIDNumeric>` : "") +
  `<FixtureID>${f.fixtureId ?? ""}</FixtureID>` +
  `<Addresses>${(f.addresses ?? []).map(([b, a]) => `<Address break="${b}">${a}</Address>`).join("")}</Addresses></Fixture>`;

function mvr(layers: Record<string, { matrix?: string; groups?: Array<{ name: string; matrix?: string; fixtures: Fx[] }>; fixtures?: Fx[]; truss?: boolean }>, gdtfs: Record<string, Buffer> = { "ACME@Spot_300.gdtf": SPOT, "Glow_Co@Wash_7.gdtf": WASH }): Buffer {
  let n = 0;
  const layerXml = Object.entries(layers)
    .map(([name, l]) => {
      const items = [
        ...(l.fixtures ?? []).map((f) => fixtureXml(f, ++n)),
        ...(l.groups ?? []).map((g) => `<GroupObject name="${g.name}" uuid="g-${++n}">${g.matrix ? `<Matrix>${g.matrix}</Matrix>` : ""}<ChildList>${g.fixtures.map((f) => fixtureXml(f, ++n)).join("")}</ChildList></GroupObject>`),
        ...(l.truss ? [`<Truss name="Truss 1" uuid="t-${++n}"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,5000}</Matrix></Truss>`] : []),
      ].join("");
      return `<Layer name="${name}" uuid="l-${++n}">${l.matrix ? `<Matrix>${l.matrix}</Matrix>` : ""}<ChildList>${items}</ChildList></Layer>`;
    })
    .join("");
  const desc = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<GeneralSceneDescription verMajor="1" verMinor="6" provider="test"><UserData/><Scene><AUXData/><Layers>${layerXml}</Layers></Scene></GeneralSceneDescription>`;
  return zip({ "GeneralSceneDescription.xml": desc, ...gdtfs });
}

// --- pure parts ---------------------------------------------------------------------------------------------------

test("parseMatrix reads {u}{v}{w}{o} as columns; compose applies the parent", () => {
  const m = parseMatrix("{1,0,0}{0,1,0}{0,0,1}{1000,2000,-500}");
  assert.deepEqual(m, [1, 0, 0, 1000, 0, 1, 0, 2000, 0, 0, 1, -500]);
  const rz90 = parseMatrix("{0,1,0}{-1,0,0}{0,0,1}{0,0,0}");
  const world = compose(rz90, parseMatrix("{1,0,0}{0,1,0}{0,0,1}{1000,0,0}"));
  // The child's +X offset turns into the parent's +Y.
  assert.deepEqual(world.map((n) => Math.round(n)), [0, -1, 0, 0, 1, 0, 0, 1000, 0, 0, 1, 0]);
  assert.throws(() => parseMatrix("{1,0,0}{0,1,0}{0,0,1}"), /four/);
  assert.throws(() => parseMatrix("{1,0,0}{0,1,0}{0,0,x}{0,0,0}"), /finite/);
});

test("poseOf gives metres and the console's angles (q = qZ·qY·qX), including the gimbal-lock case", () => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const R = (ax: number, ay: number, az: number) => {
    const [a, b, c] = [rad(ax), rad(ay), rad(az)];
    const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
    // Rz·Ry·Rx, row-major 3x3.
    return [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa, sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa, -sb, cb * sa, cb * ca];
  };
  for (const [ax, ay, az] of [
    [10, 20, 30],
    [-45, 60, 170],
    [0, 0, 90],
    [90, -30, 0],
    [12, 90, 33],
  ]) {
    const r = R(ax, ay, az);
    const m = [r[0], r[1], r[2], 1500, r[3], r[4], r[5], -250, r[6], r[7], r[8], 4000];
    const pose = poseOf(m);
    assert.deepEqual(pose.position, { x: 1.5, y: -0.25, z: 4 });
    // Same rotation as the console would build from the angles asked for (gimbal lock: other angles, same rotation).
    assert.ok(quatEquivalent(quatFromEuler(pose.rotation), quatFromEuler({ x: ax, y: ay, z: az }), 1e-4), `${ax},${ay},${az} -> ${JSON.stringify(pose.rotation)}`);
  }
  assert.deepEqual(poseOf(parseMatrix("{0,1,0}{-1,0,0}{0,0,1}{0,0,0}")).rotation, { x: 0, y: 0, z: 90 });
  assert.throws(() => poseOf(parseMatrix("{2,0,0}{0,1,0}{0,0,1}{0,0,0}")), /scaled/);
  assert.throws(() => poseOf(parseMatrix("{-1,0,0}{0,1,0}{0,0,1}{0,0,0}")), /mirrored/);
  assert.throws(() => poseOf(parseMatrix("{1,0,0}{0.5,0.866025,0}{0,0,1}{0,0,0}")), /sheared/);
});

test("mvrAddress: absolute 1-based integers and U.A text", () => {
  assert.equal(mvrAddress("1"), "1.001");
  assert.equal(mvrAddress("512"), "1.512");
  assert.equal(mvrAddress("513"), "2.001");
  assert.equal(mvrAddress(" 2.5 "), "2.005");
  assert.equal(mvrAddress("0"), null);
  assert.equal(mvrAddress("1.513"), null);
  assert.equal(mvrAddress("abc"), null);
});

test("parseXml keeps element text (CDATA and entities included) and parents", () => {
  const els = parseXml("<a><b>x &amp; <![CDATA[<y>]]> z</b><c/></a>");
  assert.equal(els[1].text, "x & <y> z");
  assert.equal(els[1].parent, 0);
  assert.equal(els[2].parent, 0);
  assert.equal(els[0].text, undefined);
});

test("gdtfModes: footprint from Offsets (16 bit counts twice), breaks counted, GeometryReference leaves it unknown", () => {
  const els = parseXml(
    `<GDTF><FixtureType Name="X"><Geometries><Geometry Name="Body"><GeometryReference Name="Ref1" Geometry="Cell"/></Geometry></Geometries><DMXModes>` +
      `<DMXMode Name="A"><DMXChannels><DMXChannel Offset="1,2"/><DMXChannel Offset="3"/><DMXChannel Offset="None"/></DMXChannels></DMXMode>` +
      `<DMXMode Name="B"><DMXChannels><DMXChannel DMXBreak="1" Offset="1"/><DMXChannel DMXBreak="2" Offset="1"/></DMXChannels></DMXMode>` +
      `<DMXMode Name="C"><DMXChannels><DMXChannel Offset="1" Geometry="Ref1"/></DMXChannels></DMXMode>` +
      `</DMXModes></FixtureType></GDTF>`,
  );
  const m = gdtfModes(els);
  assert.deepEqual(m.footprints, { A: 3, B: 1, C: null });
  assert.deepEqual(m.breaks, { A: 1, B: 2, C: 1 });
});

test("parseMvr: layers, nested group transforms, fixture numbers, addresses, GDTFs and other objects", () => {
  const s = parseMvr(
    mvr({
      Front: {
        fixtures: [{ name: "Spot 1", fid: 101, addresses: [[0, "1"]], matrix: "{1,0,0}{0,1,0}{0,0,1}{-2000,0,6000}" }],
        groups: [{ name: "Pipe", matrix: "{1,0,0}{0,1,0}{0,0,1}{0,3000,0}", fixtures: [{ name: "Wash 1", fixtureId: "201", spec: "Glow_Co@Wash_7.gdtf", mode: "8ch", addresses: [[0, "513"]], matrix: "{0,1,0}{-1,0,0}{0,0,1}{500,0,0}" }] }],
        truss: true,
      },
      Back: { matrix: "{1,0,0}{0,1,0}{0,0,1}{0,0,1000}", fixtures: [{ name: "Spot 9", fid: 109, spec: "Missing@Thing.gdtf" }] },
    }),
  );
  assert.equal(s.version, "1.6");
  assert.deepEqual(s.layers, ["Front", "Back"]);
  assert.equal(s.fixtures.length, 3);
  const [spot, wash, back] = s.fixtures;
  assert.deepEqual([spot.fid, spot.addresses, spot.position, spot.layer], [101, [{ break: 0, address: "1.001" }], { x: -2, y: 0, z: 6 }, "Front"]);
  assert.deepEqual([wash.fid, wash.addresses[0].address, wash.position, wash.rotation.z, wash.path], [201, "2.001", { x: 0.5, y: 3, z: 0 }, 90, ["Pipe"]]);
  assert.deepEqual(back.position, { x: 0, y: 0, z: 1 });
  assert.deepEqual(s.otherObjects, { GroupObject: 1, Truss: 1 });
  assert.deepEqual(s.gdtfs.get("ACME@Spot_300.gdtf")?.footprints, { Standard: 8, Basic: 4 });
  assert.match(String(s.gdtfs.get("Missing@Thing.gdtf")?.problem), /no Missing@Thing\.gdtf/);
  assert.throws(() => parseMvr(zip({ "other.xml": "<a/>" })), /GeneralSceneDescription/);
  assert.throws(() => parseMvr(Buffer.from("not a zip")), /not a zip/);
});

test("consoleName, gdtfLibraryName and blocksOf", () => {
  assert.equal(consoleName("Spot 1.1, left; \"A\""), "Spot 11 left A");
  assert.equal(consoleName("..."), "");
  assert.equal(gdtfLibraryName({ spec: "x.gdtf", entry: "ACME@Spot_300@v2.gdtf", header: { manufacturer: "ACME", name: "Spot 300", modes: [] }, footprints: {}, breaks: {} }), "ACME@Spot_300@v2.gdtf");
  assert.equal(gdtfLibraryName({ spec: "spot.gdtf", entry: "spot.gdtf", header: { manufacturer: "A/B", name: "Spot: 300", modes: [] }, footprints: {}, breaks: {} }), "AB@Spot_300.gdtf");
  const p = (fid: number, address: string | undefined, typeNo = 3, footprint = 8): PlannedFixture => ({ fixture: {} as never, fid, spec: "s", mode: "Standard", name: "", typeNo, footprint, ...(address ? { address } : {}) });
  const b = blocksOf([p(103, "1.017"), p(101, "1.001"), p(102, "1.009"), p(104, "1.100"), p(105, undefined), p(106, undefined), p(107, "1.505"), p(108, "2.001")]);
  assert.deepEqual(b.map((x) => x.map((f) => f.fid)), [[101, 102, 103], [104], [105, 106], [107], [108]]);
});

// --- the tool -----------------------------------------------------------------------------------------------------

interface World {
  stages: string[];
  types: Array<{ no: number; name: string; manufacturer?: string; modes: Array<{ no: number; name: string; footprint?: number; breaks?: number }> }>;
  /** Patched ranges (absolute, 0-based) by FID. */
  live: Array<{ fid: number; first: number; last: number }>;
  library: Map<string, Buffer>;
  /** Library files patch.libraryStat lists as matching a name ignoring case (bridge 0.38.0 matches). */
  libraryMatches: Array<{ source: string; file: string }>;
  oldBridge: boolean;
  /** patch.check reports these patched fixtures' occupancy as unknown. */
  occupancyUnknown: Array<{ fid: number; reason: string }>;
  state: { destination: string; copyOpen: boolean; modal?: { name: string } | false };
}

const abs = (a: string) => {
  const [u, d] = a.split(".").map(Number);
  return (u - 1) * 512 + d - 1;
};

async function harness(world: Partial<World> = {}): Promise<{ h: Harness; w: World }> {
  const w: World = { stages: ["Stage 1", "Main Floor"], types: [{ no: 3, name: "Wash 7", manufacturer: "Glow Co", modes: [{ no: 1, name: "8ch", footprint: 8, breaks: 1 }] }], live: [{ fid: 1, first: 0, last: 7 }], library: new Map(), libraryMatches: [], oldBridge: false, occupancyUnknown: [], state: { destination: "Root", copyOpen: false, modal: false }, ...world };
  const h = await startHarness(registerMvrTools);
  h.fake.on("patch.state", () => ({ ...w.state, stages: w.stages }));
  h.fake.on("patch.types", () => ({ types: w.types }));
  h.fake.on("patch.check", (a) => {
    if (w.oldBridge || !Array.isArray(a.ranges)) throw new BridgeReplyError("[bad-args] patch.check needs add, edits or fids", "bad-args");
    const ranges = a.ranges as Array<{ fid: number; address?: string; footprint?: number }>;
    const proposed = ranges.filter((r) => r.address).map((r) => ({ fid: r.fid, first: abs(r.address as string), last: abs(r.address as string) + (r.footprint as number) - 1 }));
    const conflicts: unknown[] = [];
    proposed.forEach((p, i) => {
      for (const o of w.live) if (p.first <= o.last && o.first <= p.last) conflicts.push({ fid: p.fid, range: "x", with: o.fid, withRange: "y" });
      for (const q of proposed.slice(i + 1)) if (p.first <= q.last && q.first <= p.last) conflicts.push({ fid: p.fid, with: q.fid, reason: "two requested ranges overlap" });
    });
    return { fids: ranges.map((r) => ({ fid: r.fid, free: !w.live.some((l) => l.fid === r.fid) })), conflicts, occupancyUnknown: w.occupancyUnknown };
  });
  h.fake.on("patch.libraryStat", (a) => {
    const b = w.library.get(String(a.file));
    return { file: a.file, path: `/lib/${a.file}`, exists: b !== undefined, ...(b ? { size: b.length, crc32: crc32(b).toString(16).padStart(8, "0") } : {}), listedIn: b ? ["user"] : [], matches: [...(b ? [{ source: "user", file: String(a.file) }] : []), ...w.libraryMatches.filter((m) => m.file.toLowerCase() === String(a.file).toLowerCase())] };
  });
  return { h, w };
}

const ok = (operation: string, extra: Record<string, unknown> = {}): OperationResult => ({ operation, target: {}, outcome: "succeeded", verification: { status: "matched" }, steps: [], summary: `${operation} succeeded`, ...extra });

function recorder(w: World, over: Partial<Record<keyof MvrDeps, (args: Record<string, unknown>) => OperationResult>> = {}) {
  const calls: Array<{ tool: keyof MvrDeps; args: Record<string, unknown> }> = [];
  const make = (tool: keyof MvrDeps, fallback: (args: Record<string, unknown>) => OperationResult): SubTool => async (_ctx, args) => {
    calls.push({ tool, args });
    return (over[tool] ?? fallback)(args);
  };
  const deps: MvrDeps = {
    libraryAdd: make("libraryAdd", (a) => {
      w.library.set(String(a.file_name), Buffer.from(String(a.content_base64), "base64"));
      return ok("patch_library_add");
    }),
    importType: make("importType", () => {
      const no = Math.max(...w.types.map((x) => x.no)) + 1;
      const type = { no, name: "Spot 300", manufacturer: "ACME", modes: [{ no: 1, name: "Standard", footprint: 8, breaks: 1 }, { no: 2, name: "Basic", footprint: 4, breaks: 1 }] };
      w.types.push(type);
      return ok("patch_import", { type });
    }),
    add: make("add", () => ok("patch_add")),
    set: make("set", () => ok("patch_set")),
    place: make("place", () => ok("place_fixtures")),
  };
  return { deps, calls };
}

const RIG = () =>
  mvr({
    Front: {
      fixtures: [
        { name: "Spot 1", fid: 101, addresses: [[0, "1.101"]], matrix: "{1,0,0}{0,1,0}{0,0,1}{-2000,1000,6000}" },
        { name: "Spot 2", fid: 102, addresses: [[0, "1.109"]], matrix: "{1,0,0}{0,1,0}{0,0,1}{2000,1000,6000}" },
        { name: "Wash 1.1", fid: 201, spec: "Glow_Co@Wash_7.gdtf", mode: "8ch", addresses: [[0, "2.001"]], matrix: "{0,1,0}{-1,0,0}{0,0,1}{0,-3000,4000}" },
      ],
    },
  });

const b64 = (b: Buffer) => b.toString("base64");

test("gma3_patch_import_mvr preview: the plan, types matched or to import, nothing sent but reads", async () => {
  const { h, w } = await harness();
  try {
    const { deps, calls } = recorder(w);
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    assert.equal(calls.length, 0);
    const plan = res.plan as { fixtures: Array<Record<string, unknown>>; types: Array<Record<string, unknown>>; byLayer: Record<string, number> };
    assert.equal(plan.fixtures.length, 3);
    assert.deepEqual(plan.types, [{ gdtf: "ACME@Spot_300.gdtf", import: "ACME@Spot_300.gdtf", inLibrary: false }, { gdtf: "Glow_Co@Wash_7.gdtf", use: { no: 3, name: "Wash 7" } }]);
    assert.deepEqual(plan.byLayer, { Front: 3 });
    assert.deepEqual(plan.fixtures[2], { fid: 201, name: "Wash 11", layer: "Front", gdtf: "Glow_Co@Wash_7.gdtf", mode: "8ch", address: "2.001", position: { x: 0, y: -3, z: 4 }, rotation: { x: 0, y: 0, z: 90 }, type: 3 });
    assert.ok(h.fake.requests.every((r) => ["patch.state", "patch.types", "patch.check", "patch.libraryStat"].includes(r.op)));
    const check = h.fake.requests.find((r) => r.op === "patch.check");
    assert.deepEqual(check?.args.ranges, [{ fid: 101, address: "1.101", footprint: 8 }, { fid: 102, address: "1.109", footprint: 8 }, { fid: 201, address: "2.001", footprint: 8 }]);
    assert.ok(res.warnings?.some((x) => /Wash 1\.1" -> "Wash 11"/.test(x)));
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: imports the missing type, adds in blocks, names and places, all read back", async () => {
  const { h, w } = await harness();
  try {
    const { deps, calls } = recorder(w);
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), stage: "Main Floor", exclusive: true }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    assert.equal(res.verification.status, "matched");
    assert.deepEqual(
      calls.map((c) => c.tool),
      ["libraryAdd", "importType", "add", "add", "set", "place"],
    );
    assert.equal(calls[0].args.file_name, "ACME@Spot_300.gdtf");
    assert.deepEqual(Buffer.from(String(calls[0].args.content_base64), "base64"), SPOT);
    assert.deepEqual(calls[1].args, { file: "ACME@Spot_300.gdtf", source: "user", exclusive: true, verify: true });
    assert.deepEqual(calls[2].args, { type: 4, mode: "Standard", fid: 101, count: 2, address: "1.101", stage: "Main Floor", exclusive: true, verify: true });
    assert.deepEqual(calls[3].args, { type: 3, mode: "8ch", fid: 201, count: 1, address: "2.001", stage: "Main Floor", exclusive: true, verify: true });
    assert.deepEqual(calls[4].args.edits, [{ fid: 101, name: "Spot 1" }, { fid: 102, name: "Spot 2" }, { fid: 201, name: "Wash 11" }]);
    assert.deepEqual((calls[5].args.placements as unknown[])[2], { fid: 201, position: { x: 0, y: -3, z: 4 }, rotation: { x: 0, y: 0, z: 90 } });
    assert.equal(calls[5].args.unit, "m");
    // The imported type's ranges were checked again with the console's footprint before anything was added.
    assert.equal(h.fake.requests.filter((r) => r.op === "patch.check").length, 2);
    assert.match(res.summary, /Imported 3 fixture\(s\).*1 fixture type/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: a GDTF already in the user library with the same bytes is imported without sending it again", async () => {
  const { h, w } = await harness({ library: new Map([["ACME@Spot_300.gdtf", SPOT]]) });
  try {
    const { deps, calls } = recorder(w);
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), exclusive: true, names: false, place: false }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    assert.deepEqual(calls.map((c) => c.tool), ["importType", "add", "add"]);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr refuses before any change: taken FID, DMX overlaps, duplicate and missing numbers, multi-break, no GDTF", async () => {
  const { h, w } = await harness({ live: [{ fid: 102, first: 100, last: 107 }] });
  try {
    const { deps, calls } = recorder(w);
    const file = mvr(
      {
        Front: {
          fixtures: [
            { name: "Spot 1", fid: 101, addresses: [[0, "1.101"]] },
            { name: "Spot 2", fid: 102, addresses: [[0, "1.150"]] },
            { name: "Spot 3", fid: 103, addresses: [[0, "1.150"]] },
            { name: "Spot 4", fid: 103, addresses: [[0, "1.200"]] },
            { name: "Nameless", addresses: [[0, "1.300"]], fixtureId: "A7" },
            { name: "Split", fid: 300, spec: "Glow_Co@Split.gdtf", mode: "Two", addresses: [[0, "3.001"]] },
            { name: "Lost", fid: 400, spec: "Gone@Away.gdtf" },
            { name: "Bad mode", fid: 401, mode: "Turbo" },
          ],
        },
      },
      { "ACME@Spot_300.gdtf": SPOT, "Glow_Co@Split.gdtf": TWOBREAK },
    );
    const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true }, deps);
    assert.equal(res.outcome, "failed");
    assert.equal(calls.length, 0);
    const err = String(res.steps.find((s) => s.name === "check_mvr")?.error);
    assert.match(err, /FID 101 "Spot 1": FID 101 1\.101-?.* overlaps|FID 101 "Spot 1": .*overlaps patched fixture 102/);
    assert.match(err, /FID 102 "Spot 2": .*FID 102 is taken/);
    assert.match(err, /fixture number 103 is also used/);
    assert.match(err, /"Nameless": no fixture number .*FixtureID is "A7"/);
    assert.match(err, /FID 300 "Split": mode "Two" has 2 DMX breaks/);
    assert.match(err, /FID 400 "Lost": the MVR has no Gone@Away\.gdtf/);
    assert.match(err, /FID 401 "Bad mode": .*has no DMX mode "Turbo"/);
    assert.match(err, /skip_unusable: true/);
    assert.equal(res.verification.status, "unavailable");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr skip_unusable: leaves out what cannot be imported, says why, imports the rest", async () => {
  const { h, w } = await harness({ live: [{ fid: 102, first: 600, last: 607 }] });
  try {
    const { deps, calls } = recorder(w);
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), exclusive: true, skip_unusable: true, place: false, names: false }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    assert.ok(res.warnings?.some((x) => /left out \(skip_unusable\): FID 102 "Spot 2": FID 102 is taken/.test(x)));
    const adds = calls.filter((c) => c.tool === "add").map((c) => [c.args.fid, c.args.count]);
    assert.deepEqual(adds, [[101, 1], [201, 1]]);
    assert.match(res.summary, /1 left out/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: a missing stage, an ambiguous type and an old bridge are refused with a reason", async () => {
  {
    const { h, w } = await harness();
    try {
      const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), stage: "Balcony", exclusive: true }, recorder(w).deps);
      assert.equal(res.outcome, "failed");
      assert.match(String(res.steps.at(-1)?.error), /no stage "Balcony".*gma3_patch_stages/);
    } finally {
      await h.close();
    }
  }
  {
    const { h, w } = await harness({ types: [{ no: 3, name: "Wash 7", manufacturer: "Glow Co", modes: [{ no: 1, name: "8ch", footprint: 8 }] }, { no: 5, name: "Wash_7", manufacturer: "Glow Co", modes: [{ no: 1, name: "8ch", footprint: 8 }] }] });
    try {
      const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true }, recorder(w).deps);
      assert.equal(res.outcome, "failed");
      assert.match(String(res.steps.at(-1)?.error), /2 types matching Glow Co \/ Wash 7.*types\["Glow_Co@Wash_7\.gdtf"\]/);
      // The override names one.
      const res2 = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true, types: { "Glow_Co@Wash_7.gdtf": 5 } }, recorder(w).deps);
      assert.equal(res2.outcome, "succeeded", res2.summary);
    } finally {
      await h.close();
    }
  }
  {
    const { h, w } = await harness({ oldBridge: true });
    try {
      const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true }, recorder(w).deps);
      assert.equal(res.outcome, "failed");
      assert.match(String(res.steps.at(-1)?.error), /bridge 0\.58\.0/);
    } finally {
      await h.close();
    }
  }
});

test("gma3_patch_import_mvr: a different file of that name in the user library is refused", async () => {
  const { h, w } = await harness({ library: new Map([["ACME@Spot_300.gdtf", Buffer.from("other bytes")]]) });
  try {
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), exclusive: true }, recorder(w).deps);
    assert.equal(res.outcome, "failed");
    assert.match(String(res.steps.find((s) => s.name === "check_mvr")?.error), /already has a different ACME@Spot_300\.gdtf/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr stops at the first failed sub-call and lists what was not attempted", async () => {
  const { h, w } = await harness();
  try {
    let adds = 0;
    const { deps, calls } = recorder(w, {
      add: () => (++adds === 2 ? { ...ok("patch_add"), outcome: "failed", verification: { status: "unavailable" }, summary: "patch_add failed at step 'check_add': FID 201 is not free" } : ok("patch_add")),
    });
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), exclusive: true }, deps);
    assert.equal(res.outcome, "partial");
    assert.deepEqual(calls.map((c) => c.tool), ["libraryAdd", "importType", "add", "add"]);
    const skipped = res.steps.filter((s) => s.status === "skipped").map((s) => s.name);
    assert.deepEqual(skipped, ["name", "place"]);
    assert.match(String(res.steps.find((s) => s.status === "failed")?.error), /FID 201 is not free/);
    assert.equal(res.verification.status, "unavailable");
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: a mismatched read-back of a sub-call is the import's mismatch", async () => {
  const { h, w } = await harness();
  try {
    const { deps } = recorder(w, { place: () => ({ ...ok("place_fixtures"), verification: { status: "mismatched", detail: "FID 201 rotation" }, summary: "place_fixtures succeeded. read-back MISMATCHED: FID 201 rotation" }) });
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), exclusive: true }, deps);
    assert.equal(res.verification.status, "mismatched");
    assert.match(String(res.verification.detail), /place: .*FID 201 rotation/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: an imported type whose footprint makes a range overlap stops before any fixture is added", async () => {
  const { h, w } = await harness({ live: [{ fid: 1, first: 109, last: 115 }] });
  try {
    // The GDTF says 4 channels for Basic, the console says 12 after the import.
    const { deps, calls } = recorder(w, {
      importType: () => {
        const type = { no: 9, name: "Spot 300", manufacturer: "ACME", modes: [{ no: 1, name: "Standard", footprint: 8 }, { no: 2, name: "Basic", footprint: 12 }] };
        w.types.push(type);
        return ok("patch_import", { type });
      },
    });
    const file = mvr({ Front: { fixtures: [{ name: "Spot 1", fid: 101, mode: "Basic", addresses: [[0, "1.101"]] }] } });
    const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true }, deps);
    assert.deepEqual(calls.map((c) => c.tool), ["libraryAdd", "importType"]);
    assert.equal(res.outcome, "partial");
    assert.match(String(res.steps.find((s) => s.name === "recheck_patch")?.error), /overlaps patched fixture 1.*no fixture was added/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: the recheck after an import covers fixtures of types the show already had (review of #162)", async () => {
  const { h, w } = await harness();
  try {
    // Spot Basic: 4 channels in the GDTF, 12 on the console after the import, so 1.101-1.112 reaches the Wash at 1.109.
    const { deps, calls } = recorder(w, {
      importType: () => {
        const type = { no: 9, name: "Spot 300", manufacturer: "ACME", modes: [{ no: 1, name: "Standard", footprint: 8 }, { no: 2, name: "Basic", footprint: 12 }] };
        w.types.push(type);
        return ok("patch_import", { type });
      },
    });
    const file = mvr({
      Front: {
        fixtures: [
          { name: "Spot 1", fid: 101, mode: "Basic", addresses: [[0, "1.101"]] },
          { name: "Wash 1", fid: 201, spec: "Glow_Co@Wash_7.gdtf", mode: "8ch", addresses: [[0, "1.109"]] },
        ],
      },
    });
    const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true }, deps);
    assert.deepEqual(calls.map((c) => c.tool), ["libraryAdd", "importType"]);
    const recheck = h.fake.requests.filter((r) => r.op === "patch.check").at(-1);
    assert.deepEqual(recheck?.args.ranges, [{ fid: 101, address: "1.101", footprint: 12 }, { fid: 201, address: "1.109", footprint: 8 }]);
    assert.match(String(res.steps.find((s) => s.name === "recheck_patch")?.error), /FID 101 .*overlaps MVR fixture 201.*no fixture was added/);
    assert.deepEqual(res.steps.filter((s) => s.status === "skipped").map((s) => s.name), ["add", "name", "place"]);
  } finally {
    await h.close();
  }
});

test("consoleName stays within the bridge's 128 bytes of UTF-8, cutting at a whole character (review of #162)", () => {
  assert.equal(consoleName("a".repeat(129)), "a".repeat(128));
  const e = consoleName("é".repeat(70));
  assert.equal(Buffer.byteLength(e, "utf8"), 128);
  assert.equal(e, "é".repeat(64));
  assert.equal(Buffer.byteLength(consoleName("a" + "€".repeat(60)), "utf8") <= 128, true);
});

test("gma3_patch_import_mvr skip_unusable: an unusable fixture's range does not make a usable one look taken (review of #162)", async () => {
  const { h, w } = await harness();
  try {
    const { deps, calls } = recorder(w);
    const file = mvr({
      Front: {
        fixtures: [
          { name: "Good", fid: 101, addresses: [[0, "1.101"]] },
          { name: "Scaled", fid: 102, addresses: [[0, "1.101"]], matrix: "{2,0,0}{0,1,0}{0,0,1}{0,0,0}" },
        ],
      },
    });
    const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true, skip_unusable: true, names: false, place: false }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    assert.deepEqual(calls.filter((c) => c.tool === "add").map((c) => c.args.fid), [101]);
    const first = h.fake.requests.find((r) => r.op === "patch.check");
    assert.deepEqual(first?.args.ranges, [{ fid: 101, address: "1.101", footprint: 8 }]);
    assert.ok(res.warnings?.some((x) => /FID 102 "Scaled": .*scaled/.test(x)));
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: a stage named loosely is sent as the show spells it; two loose matches are refused (review of #162)", async () => {
  {
    const { h, w } = await harness();
    try {
      const { deps, calls } = recorder(w);
      const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), exclusive: true, layer_stages: { Front: "main_floor" }, names: false, place: false }, deps);
      assert.equal(res.outcome, "succeeded", res.summary);
      assert.ok(calls.filter((c) => c.tool === "add").every((c) => c.args.stage === "Main Floor"));
    } finally {
      await h.close();
    }
  }
  {
    const { h, w } = await harness({ stages: ["Main Floor", "main floor"] });
    try {
      const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true, stage: "MAIN_FLOOR" }, recorder(w).deps);
      assert.equal(res.outcome, "failed");
      assert.match(String(res.steps.at(-1)?.error), /more than one stage matches "MAIN_FLOOR".*exact name/);
      const exact = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true, stage: "main floor" }, recorder(w).deps);
      assert.equal(exact.outcome, "succeeded", exact.summary);
    } finally {
      await h.close();
    }
  }
});

test("gma3_patch_import_mvr: two GDTFs of one fixture type share one import when identical, and are refused when they differ (review of #162)", async () => {
  {
    const { h, w } = await harness();
    try {
      const { deps, calls } = recorder(w);
      const file = mvr(
        { Front: { fixtures: [{ name: "Spot 1", fid: 101, addresses: [[0, "1.101"]] }, { name: "Spot 2", fid: 102, spec: "ACME@Spot_300@copy.gdtf", addresses: [[0, "1.109"]] }] } },
        { "ACME@Spot_300.gdtf": SPOT, "ACME@Spot_300@copy.gdtf": SPOT },
      );
      const preview = await mvrImport(h.ctx, { content_base64: b64(file), preview: true }, deps);
      assert.deepEqual((preview.plan as { types: unknown[] }).types, [{ gdtf: "ACME@Spot_300.gdtf", import: "ACME@Spot_300.gdtf", inLibrary: false }, { gdtf: "ACME@Spot_300@copy.gdtf", sameAs: "ACME@Spot_300.gdtf" }]);
      const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true, names: false, place: false }, deps);
      assert.equal(res.outcome, "succeeded", res.summary);
      assert.deepEqual(calls.map((c) => c.tool), ["libraryAdd", "importType", "add"]);
      assert.deepEqual([calls[2].args.type, calls[2].args.fid, calls[2].args.count], [4, 101, 2]);
    } finally {
      await h.close();
    }
  }
  {
    const { h, w } = await harness();
    try {
      const { deps, calls } = recorder(w);
      const SPOT_V2 = gdtf("ACME", "Spot 300", [{ name: "Standard", offsets: ["1", "2", "3", "4", "5", "6", "7", "8"] }]);
      const file = mvr(
        { Front: { fixtures: [{ name: "Spot 1", fid: 101, addresses: [[0, "1.101"]] }, { name: "Spot 2", fid: 102, spec: "ACME@Spot_300@v2.gdtf", addresses: [[0, "1.109"]] }] } },
        { "ACME@Spot_300.gdtf": SPOT, "ACME@Spot_300@v2.gdtf": SPOT_V2 },
      );
      const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true }, deps);
      assert.equal(res.outcome, "failed");
      assert.equal(calls.length, 0);
      assert.match(String(res.steps.find((x) => x.name === "check_mvr")?.error), /2 different GDTFs of ACME \/ Spot 300 \(ACME@Spot_300\.gdtf, ACME@Spot_300@v2\.gdtf\)/);
    } finally {
      await h.close();
    }
  }
});

test("gma3_patch_import_mvr: an open patch copy, a destination other than Root or a modal is refused before any upload, preview too (review of #162)", async () => {
  for (const state of [
    { destination: "Root", copyOpen: true, modal: false as const },
    { destination: "ShowData.DataPools", copyOpen: false, modal: false as const },
    { destination: "Root", copyOpen: false, modal: { name: "MessageBox" } },
  ]) {
    const { h, w } = await harness({ state });
    try {
      const { deps, calls } = recorder(w);
      for (const preview of [true, false]) {
        const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview, exclusive: true }, deps);
        assert.equal(res.outcome, "failed");
        assert.match(String(res.steps.at(-1)?.error), /a patch session cannot start: .*(patch copy is open|not Root|modal is open)/);
      }
      assert.equal(calls.length, 0);
      assert.ok(!h.fake.requests.some((r) => r.op === "patch.libraryStat" || r.op === "patch.check"));
    } finally {
      await h.close();
    }
  }
});

test("gma3_patch_import_mvr: two fixture types whose names clean to one library file get distinct files (review of #162)", async () => {
  const { h, w } = await harness({ types: [] });
  try {
    const A = gdtf("ACME", "Spot/A", [{ name: "Standard", offsets: ["1", "2"] }]);
    const B = gdtf("ACME", "SpotA", [{ name: "Standard", offsets: ["1", "2"] }]);
    const file = mvr(
      { Front: { fixtures: [{ name: "A 1", fid: 101, spec: "a.gdtf" }, { name: "B 1", fid: 201, spec: "b.gdtf" }] } },
      { "a.gdtf": A, "b.gdtf": B },
    );
    const { deps, calls } = recorder(w);
    const res = await mvrImport(h.ctx, { content_base64: b64(file), preview: true }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    const files = (res.plan as { types: Array<{ import?: string }> }).types.map((x) => x.import);
    const hex = (b: Buffer) => crc32(b).toString(16).padStart(8, "0");
    assert.deepEqual(files, [`ACME@SpotA@${hex(A)}.gdtf`, `ACME@SpotA@${hex(B)}.gdtf`]);
    assert.ok(res.warnings?.some((x) => /would share one library file name/.test(x)));
    assert.equal(calls.length, 0);
    // The library is checked under the distinct names.
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "patch.libraryStat").map((r) => r.args.file), files);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: unknown DMX occupancy stops only an import with addresses (review of #162)", async () => {
  const { h, w } = await harness({ occupancyUnknown: [{ fid: 7, reason: "its mode is unavailable" }] });
  try {
    const { deps } = recorder(w);
    const unpatched = mvr({ Front: { fixtures: [{ name: "Wash 1", fid: 201, spec: "Glow_Co@Wash_7.gdtf", mode: "8ch" }] } });
    const ok1 = await mvrImport(h.ctx, { content_base64: b64(unpatched), exclusive: true }, deps);
    assert.equal(ok1.outcome, "succeeded", ok1.summary);
    assert.ok((ok1.steps.find((x) => x.name === "check_patch")?.detail as { occupancyUnknown?: unknown[] }).occupancyUnknown?.length === 1);
    const addressed = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true }, deps);
    assert.equal(addressed.outcome, "failed");
    assert.match(String(addressed.steps.at(-1)?.error), /DMX occupancy of 1 patched fixture\(s\) cannot be established \(FID 7/);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: a library file differing only in case is refused before any upload (review of #162)", async () => {
  const { h, w } = await harness({ libraryMatches: [{ source: "user", file: "acme@spot_300.gdtf" }] });
  try {
    const { deps, calls } = recorder(w);
    for (const preview of [true, false]) {
      const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview, exclusive: true }, deps);
      assert.equal(res.outcome, "failed");
      assert.match(String(res.steps.find((x) => x.name === "check_mvr")?.error), /ACME@Spot_300\.gdtf differs only in case from acme@spot_300\.gdtf \(user\)/);
    }
    assert.equal(calls.length, 0);
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr: a fixture number above 99,999,999 is that fixture's problem, skipped with skip_unusable (review of #162)", async () => {
  const { h, w } = await harness();
  try {
    const { deps, calls } = recorder(w);
    const file = mvr({ Front: { fixtures: [{ name: "Wash 1", fid: 201, spec: "Glow_Co@Wash_7.gdtf", mode: "8ch", addresses: [[0, "2.001"]] }, { name: "Huge", fid: 100000000, spec: "Glow_Co@Wash_7.gdtf", mode: "8ch", addresses: [[0, "2.009"]] }] } });
    const refused = await mvrImport(h.ctx, { content_base64: b64(file), preview: true }, deps);
    assert.equal(refused.outcome, "failed");
    assert.match(String(refused.steps.find((x) => x.name === "check_mvr")?.error), /FID 100000000 "Huge": its fixture number 100000000 is above the console's 99999999/);
    const res = await mvrImport(h.ctx, { content_base64: b64(file), exclusive: true, skip_unusable: true, names: false, place: false }, deps);
    assert.equal(res.outcome, "succeeded", res.summary);
    assert.deepEqual(calls.map((c) => [c.tool, c.args.fid]), [["add", 201]]);
    assert.ok(h.fake.requests.filter((r) => r.op === "patch.check").every((r) => (r.args.ranges as Array<{ fid: number }>).every((x) => x.fid <= 99999999)));
  } finally {
    await h.close();
  }
});

test("gma3_patch_import_mvr validation: path or content, exclusive unless preview, known layers", async () => {
  const { h, w } = await harness();
  try {
    const { deps } = recorder(w);
    assert.match((await mvrImport(h.ctx, { preview: true }, deps)).summary, /exactly one of path/);
    assert.match((await mvrImport(h.ctx, { content_base64: b64(RIG()) }, deps)).summary, /exclusive: true is required/);
    const res = await mvrImport(h.ctx, { content_base64: b64(RIG()), preview: true, layers: ["Rear"] }, deps);
    assert.match(String(res.steps.at(-1)?.error), /no layer "Rear".*"Front"/);
    const tool = h.tools.get("gma3_patch_import_mvr");
    assert.ok(tool?.description?.includes("preview: true"));
  } finally {
    await h.close();
  }
});
