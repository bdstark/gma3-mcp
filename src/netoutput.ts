/**
 * Passive network DMX listener for gma3_network_output (docs/tools/network-output.md).
 *
 * Parses sACN (ANSI E1.31) data packets and Art-Net ArtDmx packets and keeps the latest frame per
 * (protocol, universe, source). It reads what the console actually puts on the wire after its own merge and
 * priority, without the bridge: it works while the bridge is down (a show load) and needs no grant read.
 *
 * Sockets bind on demand (SO_REUSEADDR, and on macOS SO_REUSEPORT through libuv, so another receiver on the
 * same port still gets multicast and broadcast) and close after an idle period with no collection running, so nothing
 * listens permanently. A protocol whose bind failed is bound again on the next call. sACN multicast groups are joined
 * for a collection and left again when no running collection needs them. Node built-ins only.
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

/**
 * How long a source counts as live after its last packet, per protocol. sACN: E1.31's network data loss timeout
 * (2.5 s). Art-Net: a node may resend unchanged data only about every 4 s (Art-Net 4 spec), so 5 s. A source that
 * sends static data at a reduced keep-alive rate stays in the merge between its packets.
 */
export const SOURCE_TIMEOUT_MS: Record<NetProtocol, number> = { sacn: 2500, artnet: 5000 };

/**
 * Whether a frame with sequence `next` is older than (or the same as) the cached one with `last`, so it must not
 * replace it. sACN (E1.31 6.7.2): discard when next - last, as a signed 8-bit difference, is in -20..0. Art-Net:
 * sequence 0 means sequencing is off (always accepted); otherwise 1..255 wraps to 1, and the same 20-frame window
 * applies. A source silent for longer than its liveness timeout has restarted: its frame is always accepted.
 */
export function isOutOfOrder(protocol: NetProtocol, last: number, next: number): boolean {
  if (protocol === "artnet") {
    if (last === 0 || next === 0) return false;
    const d = (next - last + 255) % 255; // 1..255 cycle: 0 = the same frame, 235..254 = up to 20 behind
    return d === 0 || d >= 255 - 20;
  }
  const d = (((next - last) % 256) + 256) % 256; // 0..255
  return d === 0 || d >= 256 - 20;
}

/** A multicast group that could not be joined on any interface. */
export interface MembershipFailure {
  universe: number;
  group: string;
  error: string;
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
  /**
   * The latest output frame. While a live (non-preview) frame is within its liveness timeout, sACN preview packets
   * do not replace it (E1.31 6.2.6: preview data must not affect live output); they go to `preview`.
   */
  frame: DmxFrame;
  /** Packets that made `frame` (preview packets kept apart are counted in `preview`). */
  packets: number;
  firstSeen: number;
  /** When `frame` arrived: the source's liveness for the merge. */
  lastSeen: number;
  /** The sequence of the newest packet of any kind, and when it came: the order check and the cache's recency. */
  lastSequence: number;
  lastPacket: number;
  /** sACN preview packets received while a live frame was kept, for diagnostics only. */
  preview?: { frame: DmxFrame; lastSeen: number; packets: number };
}

/** At most this many sources are cached; past it the least recently heard one is evicted first. */
export const MAX_SOURCES = 2048;

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
  /** Joined sACN universes: the interfaces each was joined on ("" = the default one) and how many collections need it. */
  private memberships = new Map<number, { interfaces: string[]; users: number }>();
  /** Collections running now: the sockets are never closed while one runs. */
  private active = 0;
  private idleTimer?: NodeJS.Timeout;
  private opening?: Promise<void>;
  /** Packets that arrived on a port but were not DMX data (counts by reason, capped). */
  readonly ignored = new Map<string, number>();

  constructor(readonly options: ListenerOptions) {}

  get open(): boolean {
    return this.sockets.size > 0;
  }

  /**
   * Bind every socket that is not bound yet, each protocol on its own (one whose earlier bind failed is tried again);
   * restart the idle timer. Bind errors are kept in the status.
   */
  async ensure(): Promise<SocketStatus[]> {
    this.touch();
    const missing = (["sacn", "artnet"] as const).filter((p) => !this.sockets.has(p));
    if (missing.length && !this.opening) {
      this.opening = Promise.all(missing.map((p) => this.bind(p, p === "sacn" ? this.options.sacnPort : this.options.artnetPort))).then(() => undefined);
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

  /** Restart the idle timer; it does not run while a collection runs. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.active > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.active === 0) this.close();
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  /** A collection starts: the idle timer stops until every running collection has ended. */
  begin(): void {
    this.active++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** A collection ends: its multicast groups are released and, once none runs, the idle countdown starts. */
  end(universes: number[] = []): void {
    this.releaseUniverses(universes);
    this.active = Math.max(0, this.active - 1);
    this.touch();
  }

  /** Collections running now. */
  get running(): number {
    return this.active;
  }

  /** The sACN universes whose multicast groups are joined now. */
  joinedUniverses(): number[] {
    return [...this.memberships.keys()].sort((a, b) => a - b);
  }

  /**
   * Join the sACN multicast groups of these universes for a collection (every IPv4 interface). Each call must be
   * paired with releaseUniverses (end) for its `acquired` list. A group no interface could join is a failure, reported.
   */
  joinUniverses(universes: number[]): { groups: string[]; failures: MembershipFailure[]; acquired: number[] } {
    const failures: MembershipFailure[] = [];
    // The universes this call holds a reference on: the caller releases exactly these (never another call's).
    const acquired: number[] = [];
    const sock = this.sockets.get("sacn");
    if (sock && this.options.multicast) {
      const ifaces = Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4")
        .map((i) => i.address);
      for (const u of new Set(universes)) {
        if (u < 1 || u > 63999) continue;
        const held = this.memberships.get(u);
        if (held) {
          held.users++;
          acquired.push(u);
          continue;
        }
        const group = sacnMulticastGroup(u);
        const joined: string[] = [];
        let firstError: string | undefined;
        for (const iface of ["", ...ifaces]) {
          try {
            if (iface) sock.addMembership(group, iface);
            else sock.addMembership(group);
            joined.push(iface);
          } catch (err) {
            // The default interface and its own address are the same membership; an interface may not do multicast.
            firstError ??= err instanceof Error ? err.message : String(err);
          }
        }
        if (joined.length) {
          this.memberships.set(u, { interfaces: joined, users: 1 });
          acquired.push(u);
        } else failures.push({ universe: u, group, error: firstError ?? "no IPv4 interface" });
      }
    }
    return { groups: this.joinedUniverses().map(sacnMulticastGroup), failures, acquired };
  }

  /**
   * Release the groups a collection acquired (joinUniverses' `acquired`): a group no running collection needs any more
   * is left on every interface.
   */
  releaseUniverses(universes: number[]): void {
    const sock = this.sockets.get("sacn");
    for (const u of new Set(universes)) {
      const held = this.memberships.get(u);
      if (!held) continue;
      held.users--;
      if (held.users > 0) continue;
      this.memberships.delete(u);
      if (!sock) continue;
      for (const iface of held.interfaces) {
        try {
          if (iface) sock.dropMembership(sacnMulticastGroup(u), iface);
          else sock.dropMembership(sacnMulticastGroup(u));
        } catch {
          // Already gone with the interface: nothing to release.
        }
      }
    }
  }

  /** Sources evicted from the cache because it was full (expired ones are dropped without counting). */
  evicted = 0;

  /**
   * Drop sources whose last packet is older than their liveness timeout. The map is kept in order of the last packet
   * (an update moves its entry to the end), so the sweep starts at the oldest entry and stops at the first one heard
   * within the shortest timeout: everything after it is newer.
   */
  private sweep(now: number): void {
    const shortest = Math.min(...Object.values(SOURCE_TIMEOUT_MS));
    for (const [id, s] of this.sources) {
      const age = now - s.lastPacket;
      if (age > SOURCE_TIMEOUT_MS[s.protocol]) this.sources.delete(id);
      else if (age <= shortest) break;
    }
  }

  /** The sources heard within their liveness timeout (older ones are dropped from the cache). */
  allSources(now = Date.now()): SourceState[] {
    this.sweep(now);
    return [...this.sources.values()];
  }

  /** How many sources the cache holds now. */
  get sourceCount(): number {
    return this.sources.size;
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
    this.sweep(now);
    const prev = this.sources.get(id);
    if (prev && now - prev.lastPacket <= SOURCE_TIMEOUT_MS[protocol] && isOutOfOrder(protocol, prev.lastSequence, r.frame.sequence)) {
      // A delayed older frame (or a duplicate) must not replace newer values in the cache.
      const reason = "out-of-order or duplicate frame (sequence not newer than the cached one)";
      this.ignored.set(reason, (this.ignored.get(reason) ?? 0) + 1);
      return { ok: false, reason };
    }
    if (prev) {
      prev.lastSequence = r.frame.sequence;
      prev.lastPacket = now;
      prev.address = rinfo.address;
      prev.port = rinfo.port;
      const liveKept = !prev.frame.preview && now - prev.lastSeen <= SOURCE_TIMEOUT_MS[protocol];
      if (r.frame.preview && liveKept) {
        prev.preview = { frame: r.frame, lastSeen: now, packets: (prev.preview?.packets ?? 0) + 1 };
      } else {
        prev.frame = r.frame;
        prev.packets++;
        prev.lastSeen = now;
        if (!r.frame.preview) prev.preview = undefined;
      }
      // Most recently heard last: the sweep and the cap evict from the front.
      this.sources.delete(id);
      this.sources.set(id, prev);
    } else {
      if (this.sources.size >= MAX_SOURCES) {
        const oldest = this.sources.keys().next().value;
        if (oldest !== undefined) this.sources.delete(oldest);
        this.evicted++;
      }
      this.sources.set(id, { protocol, universe: r.frame.universe, key, address: rinfo.address, port: rinfo.port, frame: r.frame, packets: 1, firstSeen: now, lastSeen: now, lastSequence: r.frame.sequence, lastPacket: now });
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
    this.evicted = 0;
    this.memberships.clear();
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
