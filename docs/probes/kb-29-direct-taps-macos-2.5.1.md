# KB-29 probe: the NX-K's codes as direct Quickey taps — macOS, onPC 2.5.1.0

Date: 2026-10-20. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-29". Question under test: do the 24 codes KB-28
qualified on the executor path behave the same as **direct taps** (`Press Quickey N` alone, no executor, no Unpress),
so a tap needs no executor? Script: `scripts/kb28-probe.mjs --direct`; reports: [run](kb-29-direct-taps-run-macos-2.5.1.json)
(26/26) and [pop-up](kb-29-direct-taps-popup-macos-2.5.1.json).

**Result: all 24 qualified for direct taps.** KB-10 had already found a directly addressed Quickey to be one complete
activation (a direct `Unpress` is a second tap, so none is issued).

| Item | Value |
| --- | --- |
| Host / show | onPC 2.5.1.0, `bdsmbpm401`, `test-fixture-disposable` (Fixture 101–120), Admin |
| Bridge | the show's `gma3_mcp_bridge` 0.25.1, `lua on`, input off; the NX-K surface plugin stopped |
| Probe objects | Quickeys 960/961 (`KB28 A`/`B`, marker `kb28-probe`) on executors 1.190/191, removed at the end |

## Command line (`run --direct`, 26/26)

| Code | One direct tap gives | 300 ms later |
| --- | --- | --- |
| NUM0, NUM2–NUM4, NUM6–NUM9 | the digit | unchanged |
| PLUS / MINUS / DOT / SLASH | `+ ` / `- ` / `.` / `/` | unchanged |
| AT, UPDATE, EDIT, COPY, MOVE, DELETE, CUE, GROUP, MACRO, PREVIEW | `At `, `Update `, `Edit `, `Copy `, `Move `, `Delete `, `Cue `, `Group `, `Macro `, `Preview ` | unchanged |
| HIGHLIGHT | Highlight on (a frame later), still on 400 ms later; a second tap turns it off | — |
| FULL (Fixture 101 selected) | Dimmer 100, line empty; still 100 after 1.5 s | — |

## Edit Command pop-up (`popup --direct`)

| Keys | One chunk | One request per tap |
| --- | --- | --- |
| NUM1 THRU NUM5 | ` Thru 15` | `1 Thru 5` |
| NUM1 DOT NUM5 | `1.5` | `1.5` |
| NUM2 PLUS NUM3 | ` +23` | `2 +3` |
| NUM9 MINUS NUM4 | ` -94` | `9 -4` |
| NUM8 SLASH NUM2 | `8/2` | `8/2` |
| AT NUM5 NUM0 | `50` | `50` |

Identical to the executor path (KB-28): order is kept one tap per request (frame), `At` inserts nothing here.

## Calculator (`type --direct`, by hand)

Fixture 101 selected, Dimmer encoder clicked (`[Absolute] Edit 'Dimmer 1'`): `NUM4 NUM2 DOT NUM5` showed `42.5`, `PLEASE`
closed it and the programmer read Dimmer 42.5. Programmer cleared afterwards.

## Surface check (plugin 0.13.0, static bank)

`bank=940/1.301-333 static input=mixed control=console`: executors 1.301–333 held MA1 … MACRO, one code each, and the
start log reported every Quickey key as `direct tap`. Through `mtpnxk sim`, `1 0 1 Enter` and then `3 7 . 5 Enter` into
the Dimmer calculator (every key-down at the same instant) stored Dimmer 37.5; the command history showed one
`Press Quickey N` line per key and no Assign, Press Page or Unpress Page.

## Limitations

- One onPC, one show; no physical keys. A direct tap next to an executor-held Quickey (e.g. MA1 held) was not tested;
  the module falls back to the executor path there.
