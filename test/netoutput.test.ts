import { test, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ACN_PACKET_ID, MAX_SOURCES, NetOutputListener, SOURCE_TIMEOUT_MS, isOutOfOrder, listenerOptionsFromEnv, parseArtDmx, parseSacn, sacnMulticastGroup } from "../src/netoutput.ts";
import { collectNetworkOutput, mergeSources, parseChannels } from "../src/tools/netoutput.ts";
import { startMcpServer, mcpText, mcpIsError } from "./helpers/mcp-server.ts";

/** gma3_network_output: E1.31 / ArtDmx parsers, the passive listener, and the tool over UDP on ephemeral ports. */

function sacnPacket(o: { universe?: number; data?: number[]; priority?: number; name?: string; sequence?: number; options?: number; cid?: number; startCode?: number } = {}): Buffer {
  const data = o.data ?? [255, 0, 128];
  const buf = Buffer.alloc(126 + data.length);
  buf.writeUInt16BE(0x0010, 0);
  buf.writeUInt16BE(0, 2);
  ACN_PACKET_ID.copy(buf, 4);
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16);
  buf.writeUInt32BE(0x4, 18);
  buf.fill(o.cid ?? 0xab, 22, 38);
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38);
  buf.writeUInt32BE(0x2, 40);
  buf.write(o.name ?? "grandMA3 onPC", 44, "utf8");
  buf[108] = o.priority ?? 100;
  buf[111] = o.sequence ?? 7;
  buf[112] = o.options ?? 0;
  buf.writeUInt16BE(o.universe ?? 1, 113);
  buf.writeUInt16BE(0x7000 | (buf.length - 115), 115);
  buf[117] = 0x02;
  buf[118] = 0xa1;
  buf.writeUInt16BE(0, 119);
  buf.writeUInt16BE(1, 121);
  buf.writeUInt16BE(data.length + 1, 123);
  buf[125] = o.startCode ?? 0;
  Buffer.from(data).copy(buf, 126);
  return buf;
}

function artDmxPacket(o: { net?: number; sub?: number; data?: number[]; sequence?: number; op?: number } = {}): Buffer {
  const data = o.data ?? [10, 20, 0, 40];
  const buf = Buffer.alloc(18 + data.length);
  buf.write("Art-Net\0", 0, "latin1");
  buf.writeUInt16LE(o.op ?? 0x5000, 8);
  buf[10] = 0;
  buf[11] = 14;
  buf[12] = o.sequence ?? 3;
  buf[13] = 0;
  buf[14] = o.sub ?? 0;
  buf[15] = o.net ?? 0;
  buf.writeUInt16BE(data.length, 16);
  Buffer.from(data).copy(buf, 18);
  return buf;
}

test("parseSacn reads a valid data packet: universe, priority, sequence, source name, CID, slots", () => {
  const r = parseSacn(sacnPacket({ universe: 300, priority: 150, sequence: 42, data: [1, 2, 3, 0, 5] }));
  assert.ok(r.ok);
  assert.equal(r.frame.protocol, "sacn");
  assert.equal(r.frame.universe, 300);
  assert.equal(r.frame.priority, 150);
  assert.equal(r.frame.sequence, 42);
  assert.equal(r.frame.sourceName, "grandMA3 onPC");
  assert.equal(r.frame.cid, "abababab-abab-abab-abab-abababababab");
  assert.deepEqual([...r.frame.data], [1, 2, 3, 0, 5]);
  assert.equal(r.frame.preview, false);
  assert.equal(parseSacn(sacnPacket({ options: 0x40 })).ok && (parseSacn(sacnPacket({ options: 0x40 })) as { frame: { terminated: boolean } }).frame.terminated, true);
});

test("parseSacn rejects a wrong identifier, wrong vectors, a non-zero start code, short and truncated packets", () => {
  const badId = sacnPacket();
  badId[4] = 0x42;
  assert.match((parseSacn(badId) as { reason: string }).reason, /packet identifier/);
  const badRoot = sacnPacket();
  badRoot.writeUInt32BE(0x8, 18);
  assert.match((parseSacn(badRoot) as { reason: string }).reason, /root vector 0x8/);
  const badFraming = sacnPacket();
  badFraming.writeUInt32BE(0x8, 40);
  assert.match((parseSacn(badFraming) as { reason: string }).reason, /framing vector/);
  const badDmp = sacnPacket();
  badDmp[117] = 0x03;
  assert.match((parseSacn(badDmp) as { reason: string }).reason, /DMP vector/);
  assert.match((parseSacn(sacnPacket({ startCode: 0xdd })) as { reason: string }).reason, /start code 221/);
  assert.match((parseSacn(sacnPacket({ universe: 0 })) as { reason: string }).reason, /universe 0/);
  assert.match((parseSacn(Buffer.alloc(60)) as { reason: string }).reason, /too short/);
  assert.match((parseSacn(sacnPacket({ data: [1, 2, 3, 4] }).subarray(0, 128)) as { reason: string }).reason, /truncated/);
});

test("parseArtDmx reads a valid packet with a 15-bit universe and rejects a wrong ID, OpCode, length and short packets", () => {
  const r = parseArtDmx(artDmxPacket({ net: 2, sub: 0x35, data: [9, 8] }));
  assert.ok(r.ok);
  assert.equal(r.frame.universe, 2 * 256 + 3 * 16 + 5);
  assert.deepEqual([...r.frame.data], [9, 8]);
  assert.equal(r.frame.sequence, 3);
  const badId = artDmxPacket();
  badId[0] = 0x61;
  assert.match((parseArtDmx(badId) as { reason: string }).reason, /not an Art-Net packet/);
  assert.match((parseArtDmx(artDmxPacket({ op: 0x2000 })) as { reason: string }).reason, /OpCode 0x2000/);
  assert.match((parseArtDmx(Buffer.alloc(10)) as { reason: string }).reason, /too short/);
  assert.match((parseArtDmx(artDmxPacket({ data: [1, 2, 3, 4] }).subarray(0, 20)) as { reason: string }).reason, /truncated/);
  const zero = artDmxPacket();
  zero.writeUInt16BE(0, 16);
  assert.match((parseArtDmx(zero) as { reason: string }).reason, /length 0/);
});

test("multicast group, channel lists and env options", () => {
  assert.equal(sacnMulticastGroup(1), "239.255.0.1");
  assert.equal(sacnMulticastGroup(300), "239.255.1.44");
  assert.deepEqual(parseChannels("1-3, 7,9..10"), [1, 2, 3, 7, 9, 10]);
  assert.deepEqual(parseChannels([5, 2, 2]), [2, 5]);
  assert.throws(() => parseChannels("0-4"), /outside/);
  assert.throws(() => parseChannels("5-1"), /backwards/);
  assert.throws(() => parseChannels("x"), /not a channel/);
  const o = listenerOptionsFromEnv({ GMA3_NET_OUTPUT_SACN_PORT: "0", GMA3_NET_OUTPUT_ARTNET_PORT: "16454", GMA3_NET_OUTPUT_MULTICAST: "0" });
  assert.deepEqual(o, { host: "0.0.0.0", sacnPort: 0, artnetPort: 16454, multicast: false, idleMs: 60000 });
  assert.equal(listenerOptionsFromEnv({}).sacnPort, 5568);
  assert.equal(listenerOptionsFromEnv({}).artnetPort, 6454);
});

test("merge: highest sACN priority wins, equal priorities merge HTP, terminated streams are left out", () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 60000 });
  const rinfo = { address: "10.0.0.1", port: 5568 };
  l.ingest("sacn", sacnPacket({ cid: 1, priority: 100, data: [10, 200] }), rinfo);
  l.ingest("sacn", sacnPacket({ cid: 2, priority: 100, data: [50, 20] }), rinfo);
  let m = mergeSources(l.allSources());
  assert.deepEqual([...m.data], [50, 200]);
  assert.match(m.merge, /HTP of 2 sources at priority 100/);
  l.ingest("sacn", sacnPacket({ cid: 3, priority: 120, data: [1, 1], name: "Backup" }), rinfo);
  m = mergeSources(l.allSources());
  assert.deepEqual([...m.data], [1, 1]);
  assert.match(m.merge, /Backup wins at priority 120/);
  l.ingest("sacn", sacnPacket({ cid: 3, priority: 120, data: [1, 1], options: 0x40, sequence: 8 }), rinfo);
  assert.deepEqual([...mergeSources(l.allSources()).data], [50, 200]);
  l.close();
});

const sender = dgram.createSocket("udp4");
after(() => sender.close());
/** Incrementing 1..255 sequence numbers, as a real sender uses (equal or older ones are dropped as out of order). */
let seqCounter = 0;
const nextSeq = () => (seqCounter = (seqCounter % 255) + 1);
const send = (buf: Buffer, port: number) => new Promise<void>((res, rej) => sender.send(buf, port, "127.0.0.1", (e) => (e ? rej(e) : res())));

test("end to end: the listener binds ephemeral ports, receives sACN and Art-Net, samples a fade, closes after idle", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 1500 });
  const sockets = await l.ensure();
  const sacnPort = sockets.find((s) => s.protocol === "sacn")!.boundPort!;
  const artPort = sockets.find((s) => s.protocol === "artnet")!.boundPort!;
  assert.ok(sacnPort > 0 && artPort > 0);
  let level = 0;
  let seq = 0;
  const timer = setInterval(() => {
    level = Math.min(255, level + 10);
    seq = (seq % 255) + 1;
    void send(sacnPacket({ universe: 1, data: [level, 0, 77], sequence: seq }), sacnPort);
    void send(artDmxPacket({ sub: 1, data: [0, 33], sequence: seq }), artPort);
    void send(Buffer.from("not dmx"), artPort);
  }, 20);
  try {
    const { result, isError } = await collectNetworkOutput(l, { listen_ms: 600, samples: 3, channels: "1-3" });
    assert.equal(isError, false);
    const r = result as { universes: Array<{ protocol: string; universe: number; fps: number; nonzero: number; values: Record<string, number>; sources: Array<{ name?: string; ip: string }> }>; samples: Array<{ t_ms: number; values: Record<string, Record<string, number>> }>; ignored_packets?: Record<string, number> };
    const s = r.universes.find((u) => u.protocol === "sACN" && u.universe === 1)!;
    assert.ok(s, "sACN universe 1 received");
    assert.equal(s.sources[0].name, "grandMA3 onPC");
    assert.equal(s.sources[0].ip, "127.0.0.1");
    assert.ok(s.fps > 5, `fps ${s.fps}`);
    assert.equal(s.values["3"], 77);
    assert.equal(s.values["2"], 0, "selected channels include zeros");
    const a = r.universes.find((u) => u.protocol === "Art-Net" && u.universe === 1)!;
    assert.deepEqual(a.values, { 1: 0, 2: 33 });
    assert.equal(r.samples.length, 3);
    assert.ok(r.samples[2].t_ms > r.samples[0].t_ms);
    assert.ok(r.samples[2].values["sACN 1"]["1"] > r.samples[0].values["sACN 1"]["1"], "the fade rises between samples");
    assert.ok(r.ignored_packets && Object.keys(r.ignored_packets).some((k) => /too short/.test(k)));

    const filtered = (await collectNetworkOutput(l, { universes: [1, 9], listen_ms: 300 })).result as { universes: Array<{ universe: number; values: Record<string, number> }>; hints?: string[] };
    assert.ok(filtered.universes.every((u) => u.universe === 1));
    assert.equal(filtered.universes.find((u) => u.values["3"] !== undefined)?.values["3"], 77, "nonzero channels without a channel list");
    assert.match(filtered.hints?.[0] ?? "", /universe\(s\) 9/);
  } finally {
    clearInterval(timer);
  }
  assert.ok(l.open);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(l.open, false, "closed after idle");
});

test("nothing received: hints name output on, the grant on onPC and the sACN destination; a port in use is reported", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  const { result } = await collectNetworkOutput(l, { listen_ms: 200 });
  const r = result as { universes: unknown[]; hints: string[] };
  assert.deepEqual(r.universes, []);
  const text = r.hints.join(" ");
  assert.match(text, /onPC without MA hardware may output only a limited number of universes/);
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /multicast/i);
  l.close();

  // A socket without address reuse holds the port: the bind error is reported, not thrown.
  const holder = dgram.createSocket({ type: "udp4", reuseAddr: false });
  await new Promise<void>((res) => holder.bind(0, "127.0.0.1", () => res()));
  const held = holder.address().port;
  const l2 = new NetOutputListener({ host: "127.0.0.1", sacnPort: held, artnetPort: held, multicast: false, idleMs: 5000 });
  try {
    const out = await collectNetworkOutput(l2, { listen_ms: 200 });
    assert.equal(out.isError, true);
    assert.match(JSON.stringify(out.result), /held by another application/);
  } finally {
    l2.close();
    holder.close();
  }

  const bad = await collectNetworkOutput(l, { listen_ms: 50, samples: 99, channels: "0" });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.result), /listen_ms.*samples|samples.*listen_ms/s);
});

test("the tool is registered and works over MCP with the bridge down", async () => {
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((res) => probe.bind(0, "127.0.0.1", () => res()));
  const sacnPort = probe.address().port;
  probe.close();
  // Port 1 for the bridge: nothing listens there, the tool must not need it.
  const client: Client = await startMcpServer({ GMA3_BRIDGE_PORT: "1", GMA3_BRIDGE_TIMEOUT_MS: "500", GMA3_OSC_PORT: "1", GMA3_NET_OUTPUT_HOST: "127.0.0.1", GMA3_NET_OUTPUT_SACN_PORT: String(sacnPort), GMA3_NET_OUTPUT_ARTNET_PORT: "0", GMA3_NET_OUTPUT_MULTICAST: "0" });
  const timer = setInterval(() => void send(sacnPacket({ universe: 5, data: [0, 0, 99], sequence: nextSeq() }), sacnPort).catch(() => {}), 20);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("gma3_network_output"));
    const res = await client.callTool({ name: "gma3_network_output", arguments: { listen_ms: 500 } });
    assert.equal(mcpIsError(res), false, mcpText(res));
    const r = JSON.parse(mcpText(res)) as { universes: Array<{ protocol: string; universe: number; nonzero: number; values: Record<string, number> }> };
    const u = r.universes.find((x) => x.universe === 5);
    assert.ok(u, mcpText(res));
    assert.equal(u.protocol, "sACN");
    assert.equal(u.nonzero, 1);
    assert.deepEqual(u.values, { 3: 99 });
  } finally {
    clearInterval(timer);
    await client.close().catch(() => {});
  }
});

// --- review of #135 ---------------------------------------------------------------------------------------------

test("review: an idle timeout shorter than listen_ms does not close the sockets mid-collection; the countdown starts after", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 300 });
  const sockets = await l.ensure();
  const sacnPort = sockets.find((s) => s.protocol === "sacn")!.boundPort!;
  const timer = setInterval(() => void send(sacnPacket({ universe: 7, data: [0, 66], sequence: nextSeq() }), sacnPort).catch(() => {}), 20);
  try {
    const { result, isError } = await collectNetworkOutput(l, { listen_ms: 900, samples: 3 });
    assert.equal(isError, false);
    const r = result as { universes: Array<{ universe: number; values: Record<string, number> }>; samples: Array<{ values: Record<string, Record<string, number>> }> };
    assert.deepEqual(r.universes.find((u) => u.universe === 7)?.values, { 2: 66 }, "the final result still holds the universe");
    assert.ok(r.samples.every((s) => s.values["sACN 7"]?.["2"] === 66), JSON.stringify(r.samples));
    assert.equal(l.running, 0);
    assert.ok(l.open, "still open right after the collection");
  } finally {
    clearInterval(timer);
  }
  await new Promise((res) => setTimeout(res, 450));
  assert.equal(l.open, false, "closed once the idle time passed after the collection");
});

test("review: a protocol whose bind failed is bound again on a later call, once its port is free", async () => {
  const holder = dgram.createSocket({ type: "udp4", reuseAddr: false });
  await new Promise<void>((res) => holder.bind(0, "127.0.0.1", () => res()));
  const held = holder.address().port;
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: held, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    const first = (await collectNetworkOutput(l, { listen_ms: 200 })).result as { sockets: Array<{ protocol: string; listening: boolean; error?: string }> };
    assert.equal(first.sockets.find((s) => s.protocol === "sACN")?.listening, false);
    assert.match(first.sockets.find((s) => s.protocol === "sACN")?.error ?? "", /held by another application/);
    assert.equal(first.sockets.find((s) => s.protocol === "Art-Net")?.listening, true);
    await new Promise<void>((res) => holder.close(() => res()));
    const second = (await collectNetworkOutput(l, { listen_ms: 200 })).result as { sockets: Array<{ protocol: string; listening: boolean; error?: string }> };
    assert.deepEqual(second.sockets.find((s) => s.protocol === "sACN"), { protocol: "sACN", port: held, listening: true });
  } finally {
    l.close();
  }
});

test("review: a live high-priority keep-alive source quiet during a short window still wins the merge", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  const sockets = await l.ensure();
  const sacnPort = sockets.find((s) => s.protocol === "sacn")!.boundPort!;
  // The priority-150 source's last keep-alive arrived 10 ms before the call; the priority-100 one sends during it.
  l.ingest("sacn", sacnPacket({ universe: 3, cid: 1, priority: 150, data: [200, 0], name: "Main" }), { address: "10.0.0.1", port: 5568 }, Date.now() - 10);
  const timer = setInterval(() => void send(sacnPacket({ universe: 3, cid: 2, priority: 100, data: [10, 10], name: "Backup", sequence: nextSeq() }), sacnPort).catch(() => {}), 20);
  try {
    const r = (await collectNetworkOutput(l, { listen_ms: 200, samples: 2, channels: "1-2" })).result as { universes: Array<{ universe: number; priority: number; merge: string; values: Record<string, number>; sources: Array<{ name: string; fps: number }> }>; samples: Array<{ values: Record<string, Record<string, number>> }> };
    const u = r.universes.find((x) => x.universe === 3)!;
    assert.equal(u.priority, 150, JSON.stringify(u));
    assert.deepEqual(u.values, { 1: 200, 2: 0 });
    assert.match(u.merge, /Main wins at priority 150/);
    assert.ok(r.samples.every((s) => s.values["sACN 3"]?.["1"] === 200), JSON.stringify(r.samples));
    assert.equal(u.sources.find((s) => s.name === "Main")?.fps, 0, "reception statistics count this window only");
  } finally {
    clearInterval(timer);
    l.close();
  }
});

test("review: multicast groups are left once no collection needs them, and a group no interface could join is reported", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: true, idleMs: 5000 });
  await l.ensure();
  const sock = (l as unknown as { sockets: Map<string, dgram.Socket> }).sockets.get("sacn")!;
  const added: string[] = [];
  const dropped: string[] = [];
  let full = false;
  sock.addMembership = ((group: string, iface?: string) => {
    if (full) throw new Error("addMembership ENOBUFS");
    added.push(`${group}@${iface ?? ""}`);
  }) as typeof sock.addMembership;
  sock.dropMembership = ((group: string, iface?: string) => void dropped.push(`${group}@${iface ?? ""}`)) as typeof sock.dropMembership;
  try {
    for (let u = 1; u <= 3; u++) {
      const r = (await collectNetworkOutput(l, { universes: [u], listen_ms: 200 })).result as { multicast_groups?: string[] };
      assert.deepEqual(r.multicast_groups, [sacnMulticastGroup(u)], "joined for the call");
      assert.deepEqual(l.joinedUniverses(), [], "left again after it");
    }
    assert.deepEqual(new Set(dropped), new Set(added), "every membership joined was dropped");
    full = true;
    const r = (await collectNetworkOutput(l, { universes: [11], listen_ms: 200 })).result as { multicast_failures?: Array<{ universe: number; group: string; error: string }>; hints?: string[] };
    assert.deepEqual(r.multicast_failures?.map((f) => [f.universe, f.group]), [[11, "239.255.0.11"]]);
    assert.match(r.multicast_failures![0].error, /ENOBUFS/);
    assert.ok(r.hints?.some((h) => /multicast could not be joined for universe\(s\) 11/.test(h)), JSON.stringify(r.hints));
  } finally {
    l.close();
  }
});

test("review: preview-only or terminated-only streams give no merged values and no contributing source", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    l.ingest("sacn", sacnPacket({ universe: 8, cid: 1, data: [255], options: 0x80 }), { address: "10.0.0.1", port: 5568 });
    let m = mergeSources(l.allSources());
    assert.deepEqual([...m.data], []);
    assert.deepEqual(m.contributing, []);
    assert.equal(m.priority, undefined);
    assert.match(m.merge, /no active stream/);
    l.close();
    l.ingest("sacn", sacnPacket({ universe: 8, cid: 2, data: [255], options: 0x40 }), { address: "10.0.0.1", port: 5568 });
    m = mergeSources(l.allSources());
    assert.deepEqual([...m.data], []);
    assert.deepEqual(m.contributing, []);
    await l.ensure();
    l.ingest("sacn", sacnPacket({ universe: 9, cid: 3, data: [255], options: 0x80 }), { address: "10.0.0.1", port: 5568 });
    const r = (await collectNetworkOutput(l, { listen_ms: 200, samples: 2 })).result as { universes: Array<{ universe: number; values: Record<string, number>; nonzero: number; fps: number; priority?: number; sources: Array<{ preview?: boolean }> }>; samples: Array<{ values: Record<string, Record<string, number>> }> };
    const u = r.universes.find((x) => x.universe === 9)!;
    assert.deepEqual(u.values, {});
    assert.equal(u.nonzero, 0);
    assert.equal(u.fps, 0);
    assert.equal(u.priority, undefined);
    assert.equal(u.sources[0].preview, true, "the preview stream stays in the source diagnostics");
    assert.ok(r.samples.every((s) => JSON.stringify(s.values["sACN 9"] ?? {}) === "{}"));
  } finally {
    l.close();
  }
});

// --- review of #135, round 2 ---------------------------------------------------------------------------------------

test("review 2: an Art-Net source resending static data every 4 s stays live; an sACN source quiet that long does not", async () => {
  assert.deepEqual(SOURCE_TIMEOUT_MS, { sacn: 2500, artnet: 5000 });
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    await l.ensure();
    const threeSecondsAgo = Date.now() - 3000;
    l.ingest("artnet", artDmxPacket({ sub: 2, data: [0, 44], sequence: 5 }), { address: "10.0.0.2", port: 6454 }, threeSecondsAgo);
    l.ingest("sacn", sacnPacket({ universe: 2, data: [55] }), { address: "10.0.0.3", port: 5568 }, threeSecondsAgo);
    const r = (await collectNetworkOutput(l, { listen_ms: 200, samples: 2 })).result as { universes: Array<{ protocol: string; universe: number; values: Record<string, number> }>; samples: Array<{ values: Record<string, Record<string, number>> }> };
    assert.deepEqual(r.universes.map((u) => [u.protocol, u.universe, u.values]), [["Art-Net", 2, { 2: 44 }]], JSON.stringify(r.universes));
    assert.ok(r.samples.every((s) => s.values["Art-Net 2"]?.["2"] === 44 && s.values["sACN 2"] === undefined), JSON.stringify(r.samples));
  } finally {
    l.close();
  }
});

test("review 2: a delayed older frame does not replace newer values (wraparound-aware; Art-Net sequence 0 is unsequenced)", () => {
  // Rules on their own.
  assert.equal(isOutOfOrder("artnet", 11, 10), true);
  assert.equal(isOutOfOrder("artnet", 11, 12), false);
  assert.equal(isOutOfOrder("artnet", 255, 1), false, "Art-Net wraps 255 -> 1");
  assert.equal(isOutOfOrder("artnet", 1, 255), true);
  assert.equal(isOutOfOrder("artnet", 0, 7), false);
  assert.equal(isOutOfOrder("artnet", 7, 0), false, "0 disables sequencing");
  assert.equal(isOutOfOrder("sacn", 11, 10), true);
  assert.equal(isOutOfOrder("sacn", 11, 11), true, "a duplicate is dropped");
  assert.equal(isOutOfOrder("sacn", 255, 0), false, "sACN wraps 255 -> 0");
  assert.equal(isOutOfOrder("sacn", 10, 240), false, "more than 20 behind counts as a jump forward (E1.31)");
  assert.equal(isOutOfOrder("sacn", 10, 250), true);

  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  const rinfo = { address: "10.0.0.1", port: 6454 };
  const t = Date.now();
  l.ingest("artnet", artDmxPacket({ data: [200], sequence: 11 }), rinfo, t);
  const late = l.ingest("artnet", artDmxPacket({ data: [10], sequence: 10 }), rinfo, t + 5);
  assert.equal(late.ok, false);
  let src = l.allSources()[0];
  assert.equal(src.frame.sequence, 11);
  assert.equal(src.frame.data[0], 200, "the newer value stays");
  assert.equal(src.packets, 1);
  assert.ok([...l.ignored.keys()].some((k) => /out-of-order/.test(k)));
  l.ingest("artnet", artDmxPacket({ data: [30], sequence: 0 }), rinfo, t + 10);
  assert.equal(l.allSources()[0].frame.data[0], 30, "an unsequenced frame is accepted");
  // A restarted source (silent longer than its liveness timeout) is accepted whatever its sequence.
  l.ingest("sacn", sacnPacket({ universe: 4, data: [90], sequence: 50 }), rinfo, t);
  l.ingest("sacn", sacnPacket({ universe: 4, data: [91], sequence: 49 }), rinfo, t + 5);
  src = l.allSources().find((s) => s.protocol === "sacn")!;
  assert.equal(src.frame.data[0], 90);
  l.ingest("sacn", sacnPacket({ universe: 4, data: [7], sequence: 49 }), rinfo, t + SOURCE_TIMEOUT_MS.sacn + 100);
  assert.equal(l.allSources().find((s) => s.protocol === "sacn")!.frame.data[0], 7, "a restart after the timeout is accepted");
  l.close();
});

test("review 2: a collection releases only the memberships it acquired, never one an overlapping collection still uses", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: true, idleMs: 5000 });
  await l.ensure();
  const sock = (l as unknown as { sockets: Map<string, dgram.Socket> }).sockets.get("sacn")!;
  let failing = true;
  const dropped: string[] = [];
  sock.addMembership = (() => {
    if (failing) throw new Error("addMembership ENOBUFS");
  }) as typeof sock.addMembership;
  sock.dropMembership = ((group: string) => void dropped.push(group)) as typeof sock.dropMembership;
  try {
    // Collection A: its join fails, so it acquires nothing.
    l.begin();
    const a = l.joinUniverses([5]);
    assert.deepEqual(a.acquired, []);
    assert.equal(a.failures.length, 1);
    // Collection B overlaps A and joins the same universe once the failure cleared.
    failing = false;
    l.begin();
    const b = l.joinUniverses([5]);
    assert.deepEqual(b.acquired, [5]);
    // A ends first: B's membership stays.
    l.end(a.acquired);
    assert.deepEqual(l.joinedUniverses(), [5], "still joined for B");
    assert.deepEqual(dropped, []);
    l.end(b.acquired);
    assert.deepEqual(l.joinedUniverses(), []);
    assert.deepEqual(dropped.length > 0 && dropped.every((g) => g === "239.255.0.5"), true);
  } finally {
    l.close();
  }
});

// --- follow-up review of #135 ----------------------------------------------------------------------------------------

test("follow-up: an sACN preview packet does not replace the live frame of the same CID and universe (E1.31 6.2.6)", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  const rinfo = { address: "10.0.0.1", port: 5568 };
  try {
    const t = Date.now();
    l.ingest("sacn", sacnPacket({ universe: 6, cid: 1, data: [200, 0], sequence: 10 }), rinfo, t);
    l.ingest("sacn", sacnPacket({ universe: 6, cid: 1, data: [5, 5], sequence: 11, options: 0x80 }), rinfo, t + 5);
    let src = l.allSources(t + 10)[0];
    assert.deepEqual([...mergeSources([src]).data], [200, 0], "the live values stay");
    assert.equal(src.frame.preview, false);
    assert.equal(src.lastSeen, t, "the live frame's liveness is its own");
    assert.equal(src.preview?.packets, 1);
    // The preview frame took its sequence: an older live frame is still refused.
    assert.equal(l.ingest("sacn", sacnPacket({ universe: 6, cid: 1, data: [1, 1], sequence: 11 }), rinfo, t + 15).ok, false);
    l.ingest("sacn", sacnPacket({ universe: 6, cid: 1, data: [100, 0], sequence: 12 }), rinfo, t + 20);
    src = l.allSources(t + 25)[0];
    assert.deepEqual([...mergeSources([src]).data], [100, 0]);
    assert.equal(src.preview, undefined, "a new live frame clears the preview diagnostics");
    // Once the live frame has expired, a preview stream is all that is left: no merged values.
    l.ingest("sacn", sacnPacket({ universe: 6, cid: 1, data: [9, 9], sequence: 13, options: 0x80 }), rinfo, t + 20 + SOURCE_TIMEOUT_MS.sacn + 100);
    assert.deepEqual([...mergeSources(l.allSources(t + 20 + SOURCE_TIMEOUT_MS.sacn + 110)).data], []);

    // Through the tool: the live value is reported, the preview stream only as a diagnostic.
    await l.ensure();
    l.ingest("sacn", sacnPacket({ universe: 12, cid: 2, data: [200, 0], sequence: 10 }), rinfo);
    l.ingest("sacn", sacnPacket({ universe: 12, cid: 2, data: [5, 5], sequence: 11, options: 0x80 }), rinfo);
    const r = (await collectNetworkOutput(l, { universes: [12], listen_ms: 200, channels: "1-2" })).result as { universes: Array<{ values: Record<string, number>; sources: Array<{ preview?: boolean; preview_stream?: { packets: number } }> }> };
    assert.deepEqual(r.universes[0].values, { 1: 200, 2: 0 });
    assert.equal(r.universes[0].sources[0].preview, undefined);
    assert.equal(r.universes[0].sources[0].preview_stream?.packets, 1);
  } finally {
    l.close();
  }
});

test("follow-up: expired sources are evicted while the listener stays open, and the cache is capped oldest-first", () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    const t = Date.now();
    for (let i = 0; i < 50_000; i++) l.ingest("artnet", artDmxPacket({ data: [1], sequence: 1 }), { address: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, port: 6454 }, t);
    assert.equal(l.sourceCount, MAX_SOURCES, "never more than the cap");
    assert.equal(l.evicted, 50_000 - MAX_SOURCES);
    const kept = l.allSources(t).map((s) => s.address);
    assert.ok(kept.includes("10.0.195.79") && !kept.includes("10.0.0.0"), "the oldest were evicted first");
    // One live source later: every expired one is gone from the cache, not only filtered.
    l.ingest("sacn", sacnPacket({ universe: 1, cid: 9, data: [7] }), { address: "10.9.9.9", port: 5568 }, t + SOURCE_TIMEOUT_MS.artnet + 100);
    assert.equal(l.sourceCount, 1);
    assert.equal(l.allSources(t + SOURCE_TIMEOUT_MS.artnet + 200)[0].address, "10.9.9.9");
    // A recently heard source moves to the back and survives the cap.
    l.close();
    for (let i = 0; i < MAX_SOURCES; i++) l.ingest("artnet", artDmxPacket({ data: [1], sequence: 1 }), { address: `10.1.${i >> 8}.${i & 255}`, port: 6454 }, t);
    l.ingest("artnet", artDmxPacket({ data: [2], sequence: 2 }), { address: "10.1.0.0", port: 6454 }, t + 1);
    l.ingest("artnet", artDmxPacket({ data: [3], sequence: 1 }), { address: "10.2.0.0", port: 6454 }, t + 2);
    const after = l.allSources(t + 3).map((s) => s.address);
    assert.ok(after.includes("10.1.0.0"), "refreshed, so not the oldest");
    assert.ok(!after.includes("10.1.0.1"), "the least recently heard was evicted");
  } finally {
    l.close();
  }
});

test("follow-up: a source that expires or is evicted and resumes within one window never gets a negative fps", async () => {
  type Row = { protocol: string; universe: number; fps: number; sources: Array<{ ip: string; fps: number }> };
  // Expire and resume: 100 packets before the window, then (simulated time) one packet after the sACN timeout.
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    await l.ensure();
    const rinfo = { address: "10.0.0.1", port: 5568 };
    for (let i = 1; i <= 100; i++) l.ingest("sacn", sacnPacket({ universe: 3, cid: 1, data: [50], sequence: i }), rinfo);
    const pending = collectNetworkOutput(l, { universes: [3], listen_ms: 300 });
    await new Promise((res) => setTimeout(res, 50));
    l.ingest("sacn", sacnPacket({ universe: 3, cid: 1, data: [60], sequence: 5 }), rinfo, Date.now() + SOURCE_TIMEOUT_MS.sacn + 100);
    assert.equal(l.allSources(Date.now() + SOURCE_TIMEOUT_MS.sacn + 100)[0].packets, 1, "a new instance");
    const u = ((await pending).result as { universes: Row[] }).universes.find((x) => x.universe === 3)!;
    assert.ok(u.fps > 0 && u.sources[0].fps > 0, JSON.stringify(u));
  } finally {
    l.close();
  }

  // Evict and reinsert: a full cache during the window pushes the source out, then it is heard again.
  const m = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    await m.ensure();
    const a = { address: "10.200.0.1", port: 6454 };
    for (let i = 1; i <= 100; i++) m.ingest("artnet", artDmxPacket({ data: [9], sequence: (i % 255) + 1 }), a);
    const pending = collectNetworkOutput(m, { universes: [0], listen_ms: 300 });
    await new Promise((res) => setTimeout(res, 50));
    for (let i = 0; i < MAX_SOURCES; i++) m.ingest("artnet", artDmxPacket({ sub: 1, data: [1], sequence: 1 }), { address: `10.3.${i >> 8}.${i & 255}`, port: 6454 });
    assert.ok(!m.allSources().some((s) => s.address === a.address), "evicted");
    m.ingest("artnet", artDmxPacket({ data: [9], sequence: 7 }), a);
    const u = ((await pending).result as { universes: Row[] }).universes.find((x) => x.protocol === "Art-Net" && x.universe === 0)!;
    assert.ok(u.fps > 0 && u.sources[0].fps > 0, JSON.stringify(u));
    assert.ok(m.evicted >= 1);
  } finally {
    m.close();
  }
});

test("follow-up: a source whose live frame expired but whose preview packets are recent is reported, never merged", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 5000 });
  try {
    await l.ensure();
    const rinfo = { address: "10.0.0.1", port: 5568 };
    const t0 = Date.now() - 3000; // live at t0, preview at t0 + 2 s, read at t0 + 3 s (sACN timeout 2.5 s)
    l.ingest("sacn", sacnPacket({ universe: 4, cid: 1, data: [200, 0], sequence: 10 }), rinfo, t0);
    l.ingest("sacn", sacnPacket({ universe: 4, cid: 1, data: [5, 5], sequence: 11, options: 0x80 }), rinfo, t0 + 2000);
    const r = (await collectNetworkOutput(l, { universes: [4], listen_ms: 200, samples: 2, channels: "1-2" })).result as {
      universes: Array<{ universe: number; values: Record<string, number>; nonzero: number; fps: number; priority?: number; merge: string; sources: Array<{ live_frame_expired?: boolean; preview_stream?: { packets: number } }> }>;
      hints?: string[];
      samples: Array<{ values: Record<string, Record<string, number>> }>;
    };
    const u = r.universes.find((x) => x.universe === 4);
    assert.ok(u, `the universe is reported: ${JSON.stringify(r)}`);
    assert.deepEqual(u.values, {}, "no merged values: the live frame expired and preview never merges");
    assert.equal(u.nonzero, 0);
    assert.equal(u.fps, 0);
    assert.equal(u.priority, undefined);
    assert.match(u.merge, /no active stream/);
    assert.equal(u.sources[0].live_frame_expired, true);
    assert.equal(u.sources[0].preview_stream?.packets, 1);
    assert.equal(r.hints, undefined, "not a nothing-received case");
    assert.ok(r.samples.every((s) => JSON.stringify(s.values["sACN 4"]) === "{}"), JSON.stringify(r.samples));
  } finally {
    l.close();
  }
});
