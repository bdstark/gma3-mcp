# Probe: undo groups, show-file state and object-change hooks (onPC 2.5.1, macOS)

Date: 2026-10-23 · grandMA3 onPC 2.5.1.0 on macOS 27.2 (M1) · show `mcp_test_load_start` (a scratch copy) ·
bridge 0.45.0 started with `lua=on` for the probes, then 0.46.0 for the live check. Every object made by the probes
(Macros 950-961, Sequence 99, Sequence 14 Cue 50, Preset 1.950) was removed afterwards.

Version note: probed by silly82 on its fork (bridge 0.45.0/0.46.0 there). Upstream ships undo groups as bridge
0.55.0, opt-in through `GMA3_UNDO_GROUPS=1`, grouping only the `cmd` op's commands (not CmdIndirect, `set` or Lua);
the show-file state is in the ping from 0.53.0. Change hooks and the HTTP API were not taken.

## Results

| API | Result |
| --- | --- |
| `NeedShowSave()` | `false` after load, `true` after a `Store Macro` |
| `GetShowFileStatus()` | a string such as `ShowLoaded` (enum `ShowFileStatus`: NoShow, ShowLoaded, ShowSaving, ShowDownloading, …) |
| `GetSample("CPU")` | CPU load in percent (e.g. 7.6); `CPUTEMP`, `GPUTEMP`, `MEMORY` answer `0` on onPC, other names `nil` |
| `CreateUndo(name)` / `CloseUndo(u)` | a handle (`Root 20.1.1.1.1`); `Cmd(c, u)` and `CmdIndirect(c, u)` join the group |
| One `Oops` after a group | reverts every command of the group (two `Store Macro` + a `Label`: all gone) |
| Without a group | one `Oops` per command |
| Group closed before its `CmdIndirect` commands ran | the group does not hold them: one `Oops` reverted only the last one |
| `Oops` while a group is open | "Not possible at the moment", with or without the handle; after `CloseUndo` it works |
| Empty group | adds no Oops step (the next `Oops` reverted the store before it) |
| `HookObjectChange(fn, obj, plugin)` | needs the **Plugin object** (`DataPool().Plugins[...]`, i.e. the component's `Parent()`); the component answers `nil` |
| A second hook with the same function | answers `-1`: one hook per callback function, so every hook needs its own closure |
| change `10` | the object's children changed: store or delete in a pool, `Store Cue` in a sequence, `Store Preset` in a preset pool |
| change `11` | the object itself changed (`Label`) |
| change `6` | a hooked sequence was deleted |
| Not reported | a `Label` of a child on a pool hook; `Go+`/`Off` of a sequence; programmer values; selection; command line |
| When callbacks run | while the plugin loop yields (the bridge's server loop) |

## What 0.46.0 does with it

- `undo.open {name}` / `undo.close`: one group per MCP tool call (the server opens and closes it around the mutation
  span); commands join only the group of their own connection; close waits three frames when `CmdIndirect` joined.
  A disconnect or bridge stop closes an open group.
- `ping.show`: `saveNeeded`, `fileStatus`, `cpu` (temperatures only when non-zero); `ping.undo`; `ping.changes`.
- `changes.since` / `changes.watch`: hooks on every datapool pool, every preset pool and every sequence (65 in the probe
  show), installed on first use; new sequences are hooked and deleted ones unhooked after a `Sequences` pool change; a
  ring of 256 entries; watchers get id-less `{"event":"changes",…}` lines (at most every 0.1 s).

Live check with 0.46.0: a group "live test" with `Store Macro 960`, `Store Macro 961`, `Label Macro 960` closed with
`commands: 3`; one `Oops` removed both macros. `changes.watch` pushed `pool:Macros children`; `Store Sequence 99`,
`Store Sequence 99 Cue 2` and `Delete Sequence 99` gave `pool:Sequences children`, `sequence:99 children`,
`sequence:99 6`, `pool:Sequences children`, and the hook count was back at 65.

Merged server (undo groups per tool call, `gma3_changes`, SSE `changes`) over the HTTP API against 0.46.0:
`gma3_store_macro` (create, 3 lines, 23 steps) was removed completely by one `Oops`; `gma3_command "Oops"` first
answered "Not possible at the moment" (its own group was open), so the bridge now closes the connection's group
before a command that runs Oops. `gma3_changes` with `wait_ms` returned `pool:Macros children`, and `/api/events`
sent `event: changes`. Note: an `Oops` with nothing of the MCP's left to undo reverts the operator's last step
(here: the plugin import).

`gma3_network_output` received nothing on this Mac: onPC's sACN and Art-Net have no interface selected
(`interface 0.0`) and only universe 2 is granted, so the console opens no output socket. Not changed here (station
network setting); to be checked in the venue with the wing.
