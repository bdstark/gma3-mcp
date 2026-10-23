/**
 * Passive network DMX listener for gma3_network_output (docs/tools/network-output.md).
 *
 * Parses sACN (ANSI E1.31) data packets and Art-Net ArtDmx packets and keeps the latest frame per
 * (protocol, universe, source). It reads what the console actually puts on the wire after its own merge and
 * priority, without the bridge: it works while the bridge is down (a show load) and needs no grant read.
 *
 * Sockets bind on demand (SO_REUSEADDR, and on macOS SO_REUSEPORT through libuv, so another receiver on the
 * same port still gets multicast and broadcast) and close after an idle period, so nothing listens permanently.
 * Node built-ins only.
 */
import dgram from "node:dgram";
import os from "node:os";

export type NetProtocol = "sacn" | "artnet";

export const SACN_DEFAULT_PORT = 5568;
export const ARTNET_DEFAULT_PORT = 6454;

/** E1.31 ACN packet identifier: "ASC-E1.17\0\0\0". */
export const ACN_PACKET_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);
export const ARTNET_ID = Buffer.from("Art-Net\0", "latin1");
export const VECTOR_ROOT_E131_DATA = 0x00000004;
export const VECTOR_E131_DATA_PACKET = 0x00000002;
export const VECTOR_DMP_SET_PROPERTY = 0x02;
export const ARTNET_OP_DMX = 0x5000;

/** Offset of the first DMX slot (after the start code) in an E1.31 data packet. */
const SACN_DATA_OFFSET = 126;
const ARTNET_DATA_OFFSET = 18;

export interface DmxFrame {
  protocol: NetProtocol;
  universe: number;
  /** Slot values 1..n (index 0 = channel 1). */
  data: Uint8Array;
  sequence: number;
  /** sACN only. */
  priority?: number;
  sourceName?: string;
  cid?: string;
  preview?: boolean;
  terminated?: boolean;
  /** Art-Net only. */
  physical?: number;
}

export type ParseResult = { ok: true; frame: DmxFrame } | { ok: false; reason: string };

const fail = (reason: string): ParseResult => ({ ok: false, reason });

function hex(buf: Buffer): string {
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** An E1.31 data packet (root, framing and DMP layers checked), or why it is not one. */
export function parseSacn(buf: Buffer): ParseResult {
  if (buf.length < SACN_DATA_OFFSET) return fail(`too short for an E1.31 data packet (${buf.length} bytes, need ${SACN_DATA_OFFSET})`);
  if (buf.readUInt16BE(0) !== 0x0010) return fail("wrong preamble size");
  if (!buf.subarray(4, 16).equals(ACN_PACKET_ID)) return fail("not an ACN packet (wrong packet identifier)");
  const rootVector = buf.readUInt32BE(18);
  if (rootVector !== VECTOR_ROOT_E131_DATA) return fail(`root vector 0x${rootVector.toString(16)} is not E1.31 data (0x4)`);
  const framingVector = buf.readUInt32BE(40);
  if (framingVector !== VECTOR_E131_DATA_PACKET) return fail(`framing vector 0x${framingVector.toString(16)} is not a data packet (0x2)`);
  if (buf[117] !== VECTOR_DMP_SET_PROPERTY) return fail(`DMP vector 0x${buf[117].toString(16)} is not Set Property (0x02)`);
  if (buf[118] !== 0xa1) return fail("wrong DMP address and data type");
  const universe = buf.readUInt16BE(113);
  if (universe < 1 || universe > 63999) return fail(`universe ${universe} is outside 1..63999`);
  const count = buf.readUInt16BE(123);
  if (count < 1 || count > 513) return fail(`property value count ${count} is outside 1..513`);
  if (buf.length < 125 + count) return fail(`truncated: ${count - 1} slots announced, ${Math.max(0, buf.length - SACN_DATA_OFFSET)} present`);
  if (buf[125] !== 0) return fail(`start code ${buf[125]} is not 0 (not dimmer data)`);
  const nameRaw = buf.subarray(44, 108);
  const nul = nameRaw.indexOf(0);
  const options = buf[112];
  return {
    ok: true,
    frame: {
      protocol: "sacn",
      universe,
      data: new Uint8Array(buf.subarray(SACN_DATA_OFFSET, 125 + count)),
      sequence: buf[111],
      priority: buf[108],
      sourceName: nameRaw.subarray(0, nul < 0 ? 64 : nul).toString("utf8"),
      cid: hex(buf.subarray(22, 38)),
      preview: (options & 0x80) !== 0,
      terminated: (options & 0x40) !== 0,
    },
  };
}

/** An ArtDmx packet, or why it is not one. Universe = net x 256 + subnet x 16 + universe (15 bits). */
export function parseArtDmx(buf: Buffer): ParseResult {
  if (buf.length < ARTNET_DATA_OFFSET) return fail(`too short for an ArtDmx packet (${buf.length} bytes, need ${ARTNET_DATA_OFFSET})`);
  if (!buf.subarray(0, 8).equals(ARTNET_ID)) return fail('not an Art-Net packet (ID is not "Art-Net\\0")');
  const op = buf.readUInt16LE(8);
  if (op !== ARTNET_OP_DMX) return fail(`OpCode 0x${op.toString(16)} is not ArtDmx (0x5000)`);
  const length = buf.readUInt16BE(16);
  if (length < 1 || length > 512) return fail(`length ${length} is outside 1..512`);
  if (buf.length < ARTNET_DATA_OFFSET + length) return fail(`truncated: ${length} slots announced, ${buf.length - ARTNET_DATA_OFFSET} present`);
  return {
    ok: true,
    frame: {
      protocol: "artnet",
      universe: ((buf[15] & 0x7f) << 8) | buf[14],
      data: new Uint8Array(buf.subarray(ARTNET_DATA_OFFSET, ARTNET_DATA_OFFSET + length)),
      sequence: buf[12],
      physical: buf[13],
    },
  };
}

/** sACN multicast group of a universe: 239.255.hi.lo. */
export function sacnMulticastGroup(universe: number): string {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/** The latest frame of one source on one universe, with counters. */
export interface SourceState {
  protocol: NetProtocol;
  universe: number;
  /** Stable key: the CID for sACN, the sender address for Art-Net. */
  key: string;
  address: string;
  port: number;
  frame: DmxFrame;
  packets: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ListenerOptions {
  host: string;
  sacnPort: number;
  artnetPort: number;
  multicast: boolean;
  /** Close the sockets after this long with no use. */
  idleMs: number;
}

export interface SocketStatus {
  protocol: NetProtocol;
  /** The configured port (0 = ephemeral). */
  port: number;
  /** The port actually bound, once listening. */
  boundPort?: number;
  listening: boolean;
  error?: string;
}

export function listenerOptionsFromEnv(env: NodeJS.ProcessEnv): ListenerOptions {
  const port = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : d;
  };
  const idle = Number(env.GMA3_NET_OUTPUT_IDLE_MS);
  return {
    host: env.GMA3_NET_OUTPUT_HOST || "0.0.0.0",
    sacnPort: port(env.GMA3_NET_OUTPUT_SACN_PORT, SACN_DEFAULT_PORT),
    artnetPort: port(env.GMA3_NET_OUTPUT_ARTNET_PORT, ARTNET_DEFAULT_PORT),
    multicast: env.GMA3_NET_OUTPUT_MULTICAST !== "0",
    idleMs: Number.isFinite(idle) && idle >= 1000 ? idle : 60_000,
  };
}

function describeBindError(protocol: NetProtocol, port: number, err: NodeJS.ErrnoException): string {
  const name = protocol === "sacn" ? "sACN" : "Art-Net";
  if (err.code === "EADDRINUSE")
    return `UDP port ${port} (${name}) is held by another application without address reuse (often the console itself, or another DMX tool such as a visualiser or node software); quit it or have it send to this machine on another path`;
  if (err.code === "EACCES") return `no permission to bind UDP port ${port} (${name})`;
  if (err.code === "EADDRNOTAVAIL") return `GMA3_NET_OUTPUT_HOST is not an address of this machine (${err.message})`;
  return `could not bind UDP port ${port} (${name}): ${err.message}`;
}

/** Binds sockets on demand, keeps the latest frame per source, closes after idle. */
export class NetOutputListener {
  private sockets = new Map<NetProtocol, dgram.Socket>();
  private status = new Map<NetProtocol, SocketStatus>();
  private sources = new Map<string, SourceState>();
  private joined = new Set<number>();
  private idleTimer?: NodeJS.Timeout;
  private opening?: Promise<void>;
  /** Packets that arrived on a port but were not DMX data (counts by reason, capped). */
  readonly ignored = new Map<string, number>();

  constructor(readonly options: ListenerOptions) {}

  get open(): boolean {
    return this.sockets.size > 0;
  }

  /** Bind both sockets if they are not bound yet; restart the idle timer. Bind errors are kept in the status. */
  async ensure(): Promise<SocketStatus[]> {
    this.touch();
    if (!this.open && !this.opening) {
      this.opening = Promise.all([this.bind("sacn", this.options.sacnPort), this.bind("artnet", this.options.artnetPort)]).then(() => undefined);
    }
    if (this.opening) {
      await this.opening;
      this.opening = undefined;
    }
    return this.statuses();
  }

  statuses(): SocketStatus[] {
    return (["sacn", "artnet"] as const).map((p) => this.status.get(p) ?? { protocol: p, port: p === "sacn" ? this.options.sacnPort : this.options.artnetPort, listening: false });
  }

  /** Restart the idle timer. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.options.idleMs);
    this.idleTimer.unref();
  }

  /** Join the sACN multicast groups of these universes (every IPv4 interface, errors ignored). Returns the groups joined so far. */
  joinUniverses(universes: number[]): string[] {
    const sock = this.sockets.get("sacn");
    if (sock && this.options.multicast) {
      const ifaces = Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4")
        .map((i) => i.address);
      for (const u of universes) {
        if (u < 1 || u > 63999 || this.joined.has(u)) continue;
        const group = sacnMulticastGroup(u);
        let any = false;
        for (const iface of [undefined, ...ifaces]) {
          try {
            if (iface) sock.addMembership(group, iface);
            else sock.addMembership(group);
            any = true;
          } catch {
            // Already joined on that interface, or the interface cannot do multicast: ignored.
          }
        }
        if (any) this.joined.add(u);
      }
    }
    return [...this.joined].sort((a, b) => a - b).map(sacnMulticastGroup);
  }

  /** Every source seen since the sockets opened. */
  allSources(): SourceState[] {
    return [...this.sources.values()];
  }

  /** Feed one datagram (used by the sockets; public for tests). */
  ingest(protocol: NetProtocol, msg: Buffer, rinfo: { address: string; port: number }, now = Date.now()): ParseResult {
    const r = protocol === "sacn" ? parseSacn(msg) : parseArtDmx(msg);
    if (!r.ok) {
      if (this.ignored.size < 20 || this.ignored.has(r.reason)) this.ignored.set(r.reason, (this.ignored.get(r.reason) ?? 0) + 1);
      return r;
    }
    const key = r.frame.cid ?? `${rinfo.address}:${r.frame.physical ?? 0}`;
    const id = `${protocol}|${r.frame.universe}|${key}`;
    const prev = this.sources.get(id);
    if (prev) {
      prev.frame = r.frame;
      prev.packets++;
      prev.lastSeen = now;
      prev.address = rinfo.address;
      prev.port = rinfo.port;
    } else {
      this.sources.set(id, { protocol, universe: r.frame.universe, key, address: rinfo.address, port: rinfo.port, frame: r.frame, packets: 1, firstSeen: now, lastSeen: now });
    }
    return r;
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const s of this.sockets.values()) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
    this.sockets.clear();
    this.status.clear();
    this.sources.clear();
    this.joined.clear();
    this.ignored.clear();
  }

  private bind(protocol: NetProtocol, port: number): Promise<void> {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      let bound = false;
      sock.on("error", (err: NodeJS.ErrnoException) => {
        if (!bound) {
          this.status.set(protocol, { protocol, port, listening: false, error: describeBindError(protocol, port, err) });
          try {
            sock.close();
          } catch {
            // never opened
          }
          resolve();
        }
        // After binding, a socket error is not fatal for a passive listener; the next call reports what arrived.
      });
      sock.on("message", (msg, rinfo) => this.ingest(protocol, msg, rinfo));
      sock.bind({ port, address: this.options.host }, () => {
        bound = true;
        sock.unref();
        this.sockets.set(protocol, sock);
        this.status.set(protocol, { protocol, port, boundPort: sock.address().port, listening: true });
        resolve();
      });
    });
  }
}
