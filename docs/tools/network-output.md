# Network DMX output: sACN and Art-Net on the wire

`gma3_network_output` in `src/tools/netoutput.ts`, the parsers and listener in `src/netoutput.ts`. No bridge request
and no Lua: the server listens passively to the DMX the console sends to this machine.

Use it to see what actually leaves the console, after the console's own merge and priority, and when the bridge
cannot answer (during `gma3_load_show`, with the bridge stopped, or for a universe whose values `gma3_dmx` cannot read).
`gma3_dmx_output` tells you how output is configured; this tool tells you what arrives.

## gma3_network_output

Read-only. Takes no mutation lock.

| Param | Notes |
| --- | --- |
| `universes` | protocol universes to report: sACN 1..63999, Art-Net 0..32767 (absolute, net × 256 + subnet × 16 + universe). Default: every universe seen. Also the sACN multicast groups joined (default 1-4) |
| `listen_ms` | how long to collect, 200..10000 ms (default 1500) |
| `channels` | channels to return: `"1-24"`, `"1,5,7-9"` or `[1, 2, 3]`. With it, every selected channel is returned, zeros included. Without it, only nonzero channels |
| `samples` | 1..50 (default 1). More than 1 takes that many snapshots spread over `listen_ms` and returns `samples: [{t_ms, values: {"sACN 1": {ch: value}}}]`, e.g. to measure a fade |

Per universe:

| Field | Meaning |
| --- | --- |
| `protocol`, `universe` | `sACN` or `Art-Net` and the protocol universe; Art-Net also as `{net, subnet, universe}` |
| `priority` | sACN: the winning priority |
| `fps` | packets per second during the window (a static universe may be sent at a reduced keep-alive rate) |
| `slots`, `nonzero` | slots in the frame, channels above 0 |
| `merge` | `single source`, `<name> wins at priority N`, or `HTP of N sources`: the highest sACN priority wins, equal ones merge HTP; preview and terminated streams are left out |
| `sources` | each sender: name and CID (sACN), IP, priority, fps, last sequence number, `preview` / `terminated` flags, `last_seen_ms_ago` |
| `values` | `{channel: value}` (0..255) |

Also: `sockets` (each protocol's port, whether it listens, and a bind error in words), `multicast_groups` joined,
`ignored_packets` (datagrams on the ports that were not DMX data, by reason: a sync or discovery packet, a non-zero
start code), and `hints` when nothing, or not every requested universe, arrived.

### When nothing arrives

The hints cover the usual causes:

- **Output off.** grandMA3 sends network DMX only when a protocol's output is on and an enabled data entry covers the
  universe (Menu > Network / DMX Protocols). `gma3_dmx_output` shows this while the bridge is up;
  `gma3_configure_dmx_output` changes it.
- **Not granted.** grandMA3 onPC without MA hardware may output only a limited number of universes, or none. A
  universe that is not granted is not output (see [dmx-output.md](dmx-output.md)).
- **Destination.** For sACN to this machine, use an `Output Unicast` entry with destination `127.0.0.1` (onPC on this
  machine) or this machine's address, or `Output Multicast`. For Art-Net, broadcast on the interface this machine is
  on, or unicast to it.

## The listener

- Two UDP sockets, sACN on 5568 and Art-Net on 6454, bound on the first call with `reuseAddr` (SO_REUSEADDR, and
  SO_REUSEPORT on macOS), so they share the ports with other receivers. Multicast and broadcast reach every socket on
  the port; a unicast datagram is delivered to one of them only, so another receiver on the same port may take it.
- A port that another application holds without address reuse (sometimes the console itself, a visualiser or node
  software) cannot be bound. The tool reports it per protocol and still listens on the other port; with both ports
  held it returns an error.
- sACN multicast: the listener joins `239.255.(u >> 8).(u & 255)` on every IPv4 interface for the universes asked for
  (1-4 when none are given). Join errors are ignored. `GMA3_NET_OUTPUT_MULTICAST=0` turns joining off.
- The latest frame is kept per protocol, universe and source (sACN by CID, Art-Net by sender address and physical
  port), with the packet count and the time last seen.
- The sockets close after `GMA3_NET_OUTPUT_IDLE_MS` (default 60 s) with no call, and the frames are dropped. Nothing
  listens permanently.

Packets are validated before they count. E1.31: preamble, ACN packet identifier, root vector 0x4, framing vector
0x2, DMP vector 0x02 and address type 0xa1, universe 1..63999, property count, start code 0. ArtDmx: ID `Art-Net\0`,
OpCode 0x5000, length 1..512.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GMA3_NET_OUTPUT_HOST` | `0.0.0.0` | Bind address. `0.0.0.0` receives unicast to any of this machine's addresses, broadcast and multicast |
| `GMA3_NET_OUTPUT_SACN_PORT` | `5568` | sACN port (`0`: ephemeral, for tests) |
| `GMA3_NET_OUTPUT_ARTNET_PORT` | `6454` | Art-Net port (`0`: ephemeral, for tests) |
| `GMA3_NET_OUTPUT_MULTICAST` | `1` | `0`: do not join sACN multicast groups |
| `GMA3_NET_OUTPUT_IDLE_MS` | `60000` | Close the sockets after this long with no call (at least 1000) |

## Tests

`test/netoutput.test.ts`: the parsers with hand-built packets (valid, wrong identifier, wrong vectors, start code,
short and truncated), channel lists and options, the priority / HTP merge, an end-to-end run sending sACN and Art-Net
to the listener on ephemeral ports (values, fps, samples of a rising fade, ignored packets, idle close), the hints
when nothing arrives, a port held by another socket, and the tool over MCP with no bridge running.
