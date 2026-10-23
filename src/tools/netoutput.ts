/**
 * gma3_network_output (docs/tools/network-output.md): read-only. Listens passively to the console's sACN (E1.31,
 * UDP 5568) and Art-Net (ArtDmx, UDP 6454) output for a moment and reports the values on the wire, after the
 * console's merge and priority. No bridge request: it works while the bridge is down (a show load), and it is not a
 * mutation, so it never takes the mutation lock.
 *
 * The sockets bind on the first call and close after GMA3_NET_OUTPUT_IDLE_MS (default 60 s) with no call
 * (src/netoutput.ts), so nothing listens permanently.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { NetOutputListener, listenerOptionsFromEnv, type NetProtocol, type SourceState, type SocketStatus } from "../netoutput.js";
import { Validator, finiteNumber } from "../validate.js";
import { json, type RegisterTools } from "./context.js";

/** sACN universes whose multicast groups are joined when no universes are given. */
export const DEFAULT_MULTICAST_UNIVERSES = [1, 2, 3, 4];

const PROTOCOL_NAME: Record<NetProtocol, string> = { sacn: "sACN", artnet: "Art-Net" };

export const NOTHING_RECEIVED_HINTS = [
  "grandMA3 sends network DMX only when a protocol's output is on and an enabled data entry covers the universe (Menu > Network / DMX Protocols: Art-Net or sACN, Output on, an entry with the local universes, enabled); gma3_dmx_output shows this when the bridge is up",
  "the universe must be granted: grandMA3 onPC without MA hardware may output only a limited number of universes, or none (gma3_dmx_output reports the grant)",
  "sACN to this machine: use an Output Unicast entry with destination 127.0.0.1 (onPC on this machine) or this machine's address, or Output Multicast (the listener joins 239.255.x.y for the universes asked for, 1-4 by default)",
  "Art-Net to this machine: Broadcast on the interface this machine is on, or Unicast to its address; onPC on the same machine needs the output station on an interface whose broadcast reaches it",
  "another application bound to the same port (a visualiser, node software) may take unicast packets for itself; multicast and broadcast reach every listener",
];

/** "1-24", "1,5,7-9" or [1, 2, 3] to a sorted channel list (1..512). */
export function parseChannels(value: unknown): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > 512) throw new Error(`channel ${n} is outside 1..512`);
    out.add(n);
  };
  if (Array.isArray(value)) {
    for (const v of value) add(Number(v));
  } else if (typeof value === "string" || typeof value === "number") {
    for (const part of String(value).split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^(\d+)\s*(?:-|\.\.|thru)\s*(\d+)$/i.exec(part);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (b < a) throw new Error(`range ${part} runs backwards`);
        if (b > 512 || a < 1) throw new Error(`range ${part} is outside 1..512`);
        for (let n = a; n <= b; n++) out.add(n);
      } else if (/^\d+$/.test(part)) add(Number(part));
      else throw new Error(`"${part}" is not a channel or a range like 1-24`);
    }
  } else throw new Error("channels is a range like \"1-24\", a list like \"1,5,7-9\" or an array of numbers");
  if (!out.size) throw new Error("channels selects no channel");
  return [...out].sort((a, b) => a - b);
}

interface Merged {
  data: Uint8Array;
  priority?: number;
  merge: string;
  contributing: SourceState[];
}

/** What a receiver would output for one universe: highest sACN priority wins, HTP among equals; preview and terminated streams left out. */
export function mergeSources(sources: SourceState[]): Merged {
  const live = sources.filter((s) => !s.frame.preview && !s.frame.terminated);
  const pool = live.length ? live : sources;
  const top = Math.max(...pool.map((s) => s.frame.priority ?? 0));
  const winners = pool[0].protocol === "sacn" ? pool.filter((s) => (s.frame.priority ?? 0) === top) : pool;
  const len = Math.max(...winners.map((s) => s.frame.data.length));
  const data = new Uint8Array(len);
  for (const s of winners) for (let i = 0; i < s.frame.data.length; i++) if (s.frame.data[i] > data[i]) data[i] = s.frame.data[i];
  const prio = pool[0].protocol === "sacn" ? top : undefined;
  let merge: string;
  if (winners.length === 1) merge = sources.length === 1 ? "single source" : `${winners[0].frame.sourceName || winners[0].address} wins${prio !== undefined ? ` at priority ${prio}` : ""}`;
  else merge = `HTP of ${winners.length} sources${prio !== undefined ? ` at priority ${prio}` : ""}`;
  if (!live.length) merge += " (every stream is preview or terminated)";
  return { data, priority: prio, merge, contributing: winners };
}

function pickValues(data: Uint8Array, channels?: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (channels) {
    for (const c of channels) if (c <= data.length) out[c] = data[c - 1];
  } else for (let i = 0; i < data.length; i++) if (data[i]) out[i + 1] = data[i];
  return out;
}

const universeLabel = (p: NetProtocol, u: number) => `${PROTOCOL_NAME[p]} ${u}`;

function groupByUniverse(sources: SourceState[]): Map<string, SourceState[]> {
  const g = new Map<string, SourceState[]>();
  for (const s of sources) {
    const k = `${s.protocol}|${s.universe}`;
    g.set(k, [...(g.get(k) ?? []), s]);
  }
  return new Map([...g.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
}

export interface CollectArgs {
  universes?: unknown;
  listen_ms?: unknown;
  channels?: unknown;
  samples?: unknown;
}

/** One listening window: validate, bind, collect for listen_ms (with optional samples), summarise. */
export async function collectNetworkOutput(listener: NetOutputListener, raw: CollectArgs): Promise<{ result: unknown; isError: boolean }> {
  const v = new Validator();
  const universes = Array.isArray(raw.universes) ? raw.universes.map((x, i) => v.check(() => finiteNumber(`universes[${i}]`, x, { integer: true, min: 0, max: 63999 })) ?? 0) : undefined;
  if (raw.universes !== undefined && !Array.isArray(raw.universes)) v.fail("universes is an array of numbers");
  const listenMs = raw.listen_ms === undefined ? 1500 : v.check(() => finiteNumber("listen_ms", raw.listen_ms, { integer: true, min: 200, max: 10000 }));
  const samples = raw.samples === undefined ? 1 : v.check(() => finiteNumber("samples", raw.samples, { integer: true, min: 1, max: 50 }));
  let channels: number[] | undefined;
  if (raw.channels !== undefined) {
    try {
      channels = parseChannels(raw.channels);
    } catch (err) {
      v.fail(err instanceof Error ? err.message : String(err));
    }
  }
  if (!v.ok || listenMs === undefined || samples === undefined) return { result: { error: v.errors.join("; ") }, isError: true };

  const sockets = await listener.ensure();
  if (!sockets.some((s) => s.listening)) {
    return { result: { tool: "gma3_network_output", error: "could not listen on either port", sockets: socketReport(sockets) }, isError: true };
  }
  const groups = listener.joinUniverses(universes?.length ? universes : DEFAULT_MULTICAST_UNIVERSES);
  const wanted = universes?.length ? new Set(universes) : undefined;
  const inScope = (s: SourceState, since: number) => s.lastSeen >= since && (!wanted || wanted.has(s.universe));

  const start = Date.now();
  const baseline = new Map(listener.allSources().map((s) => [`${s.protocol}|${s.universe}|${s.key}`, s.packets]));
  const sampled: Array<{ t_ms: number; values: Record<string, Record<string, number>> }> = [];
  const step = listenMs / samples;
  for (let i = 1; i <= samples; i++) {
    const wait = start + i * step - Date.now();
    if (wait > 0) await sleep(wait);
    if (samples > 1) {
      const values: Record<string, Record<string, number>> = {};
      for (const [, srcs] of groupByUniverse(listener.allSources().filter((s) => inScope(s, start)))) values[universeLabel(srcs[0].protocol, srcs[0].universe)] = pickValues(mergeSources(srcs).data, channels);
      sampled.push({ t_ms: Date.now() - start, values });
    }
  }
  const elapsed = Math.max(1, Date.now() - start);
  listener.touch();
  const now = Date.now();

  const seen = listener.allSources().filter((s) => inScope(s, start));
  const rows = [...groupByUniverse(seen).values()].map((srcs) => {
    const m = mergeSources(srcs);
    const fpsOf = (s: SourceState) => Math.round(((s.packets - (baseline.get(`${s.protocol}|${s.universe}|${s.key}`) ?? 0)) / elapsed) * 10000) / 10;
    const nonzero = m.data.reduce((n, x) => n + (x ? 1 : 0), 0);
    const p = srcs[0].protocol;
    const u = srcs[0].universe;
    return {
      protocol: PROTOCOL_NAME[p],
      universe: u,
      ...(p === "artnet" ? { artnet: { net: u >> 8, subnet: (u >> 4) & 0xf, universe: u & 0xf } } : {}),
      ...(m.priority !== undefined ? { priority: m.priority } : {}),
      fps: Math.max(...m.contributing.map(fpsOf)),
      slots: m.data.length,
      nonzero,
      merge: m.merge,
      sources: srcs.map((s) => ({
        ...(s.frame.sourceName !== undefined ? { name: s.frame.sourceName } : {}),
        ip: s.address,
        ...(s.frame.cid ? { cid: s.frame.cid } : {}),
        ...(s.frame.priority !== undefined ? { priority: s.frame.priority } : {}),
        ...(s.frame.physical !== undefined ? { physical: s.frame.physical } : {}),
        fps: fpsOf(s),
        sequence: s.frame.sequence,
        ...(s.frame.preview ? { preview: true } : {}),
        ...(s.frame.terminated ? { terminated: true } : {}),
        last_seen_ms_ago: now - s.lastSeen,
      })),
      values: pickValues(m.data, channels),
    };
  });

  const missing = wanted ? [...wanted].filter((u) => !seen.some((s) => s.universe === u)) : [];
  const ignored = Object.fromEntries(listener.ignored);
  const hints = !rows.length ? NOTHING_RECEIVED_HINTS : missing.length ? [`nothing received for universe(s) ${missing.join(", ")} (other universes arrived): check that a protocol entry sends them and that they are granted`] : undefined;
  const result = {
    tool: "gma3_network_output",
    summary: rows.length
      ? `${rows.length} universe(s) received in ${elapsed} ms: ${rows.map((r) => `${r.protocol} ${r.universe} (${r.nonzero} nonzero, ${r.fps} fps)`).join(", ")}.`
      : `Nothing received in ${elapsed} ms on ${sockets.filter((s) => s.listening).map((s) => `${PROTOCOL_NAME[s.protocol]} UDP ${s.boundPort}`).join(" and ")}.`,
    listen_ms: elapsed,
    sockets: socketReport(sockets),
    ...(groups.length ? { multicast_groups: groups } : {}),
    universes: rows,
    ...(sampled.length ? { samples: sampled } : {}),
    ...(Object.keys(ignored).length ? { ignored_packets: ignored } : {}),
    ...(hints ? { hints } : {}),
    notes: [
      channels ? "values: the selected channels ({channel: value}, 0..255)" : "values: nonzero channels only ({channel: value}, 0..255); pass channels for a range including zeros",
      "values are what the console puts on the network (after its merge and priority); with several sources, the highest sACN priority wins and equal ones merge HTP",
      "a static universe may be sent at a reduced keep-alive rate, so a low fps does not mean a problem",
      "read-only and passive: no bridge request; the listener closes after a minute with no call",
    ],
  };
  return { result, isError: false };
}

function socketReport(sockets: SocketStatus[]) {
  return sockets.map((s) => ({ protocol: PROTOCOL_NAME[s.protocol], port: s.boundPort ?? s.port, listening: s.listening, ...(s.error ? { error: s.error } : {}) }));
}

/** One listener per server process, shared by every call. */
let shared: NetOutputListener | undefined;

export const registerNetOutputTools: RegisterTools = (server) => {
  server.registerTool(
    "gma3_network_output",
    {
      title: "Listen to the console's sACN / Art-Net output",
      description:
        "Read-only and passive: listens for listen_ms to the sACN (E1.31, UDP 5568) and Art-Net (ArtDmx, UDP 6454) DMX the console sends to this machine and reports, per universe, the protocol, source name and IP, priority, fps, nonzero channel count and the values on the wire (after the console's merge and priority). " +
        "Needs no bridge, so it works during a show load or with the bridge down. channels limits the values (\"1-24\", \"1,5,7-9\"); samples takes up to 50 snapshots over listen_ms to measure a fade. Says why when nothing arrives (output off, universe not granted, destination).",
      inputSchema: {
        universes: z.array(z.number()).optional().describe("Protocol universes to report (sACN 1..63999, Art-Net 0..32767 absolute); default every universe seen. Also the sACN multicast groups joined (default 1-4)."),
        listen_ms: z.number().optional().describe("How long to collect, 200..10000 ms (default 1500)."),
        channels: z.union([z.string(), z.array(z.number())]).optional().describe('Channels to return, e.g. "1-24" or "1,5,7-9"; default the nonzero ones.'),
        samples: z.number().optional().describe("Snapshots over listen_ms (1..50, default 1); more than 1 returns timestamped values per sample."),
      },
    },
    async (args) => {
      shared ??= new NetOutputListener(listenerOptionsFromEnv(process.env));
      try {
        const { result, isError } = await collectNetworkOutput(shared, args as CollectArgs);
        return isError ? { ...json(result), isError: true } : json(result);
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );
};
