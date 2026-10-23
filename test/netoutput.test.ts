import { test, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ACN_PACKET_ID, NetOutputListener, listenerOptionsFromEnv, parseArtDmx, parseSacn, sacnMulticastGroup } from "../src/netoutput.ts";
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
  l.ingest("sacn", sacnPacket({ cid: 3, priority: 120, data: [1, 1], options: 0x40 }), rinfo);
  assert.deepEqual([...mergeSources(l.allSources()).data], [50, 200]);
  l.close();
});

const sender = dgram.createSocket("udp4");
after(() => sender.close());
const send = (buf: Buffer, port: number) => new Promise<void>((res, rej) => sender.send(buf, port, "127.0.0.1", (e) => (e ? rej(e) : res())));

test("end to end: the listener binds ephemeral ports, receives sACN and Art-Net, samples a fade, closes after idle", async () => {
  const l = new NetOutputListener({ host: "127.0.0.1", sacnPort: 0, artnetPort: 0, multicast: false, idleMs: 1500 });
  const sockets = await l.ensure();
  const sacnPort = sockets.find((s) => s.protocol === "sacn")!.boundPort!;
  const artPort = sockets.find((s) => s.protocol === "artnet")!.boundPort!;
  assert.ok(sacnPort > 0 && artPort > 0);
  let level = 0;
  const timer = setInterval(() => {
    level = Math.min(255, level + 10);
    void send(sacnPacket({ universe: 1, data: [level, 0, 77] }), sacnPort);
    void send(artDmxPacket({ sub: 1, data: [0, 33] }), artPort);
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
  const timer = setInterval(() => void send(sacnPacket({ universe: 5, data: [0, 0, 99] }), sacnPort).catch(() => {}), 20);
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
