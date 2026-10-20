# KB-28 probe: the NX-K's remaining keys as executor-held Quickeys — macOS, onPC 2.5.1.0

Date: 2026-10-20. Evidence for [KEYBOARD.md](../../KEYBOARD.md) "KB-28". Question under test: do the codes the NX-K
surface still sends through the keyboard shortcut table (which does not reach pop-ups and dialogs) behave like the
KB-10 codes on the executor path, so `gma3_mcp_hardkeys` can qualify them? Script: `scripts/kb28-probe.mjs`; reports:
[run](kb-28-quickey-codes-run-macos-2.5.1.json) (72/72) and [pop-up](kb-28-quickey-codes-popup-macos-2.5.1.json).

**Result: 24 more codes qualified for tap and hold, 18 of them for chords.** Every code below put exactly one token on
the command line (or acted once) on `Press Page P.E`, added nothing on `Unpress`, and did not repeat while held for
1.5 s. Digits, `+ - . /`, `Thru` and six keywords rolled with digits (the second key down before the first is up)
gave the same line as two sequential taps. In a focused text field, keys pressed **in separate requests** kept their
order, while keys pressed in one Lua chunk reproduced the KB-10 reordering. Typed one per request, digits, `.` and
Please entered and accepted a value in an encoder's calculator pop-up (Dimmer 75.5).

| Item | Value |
| --- | --- |
| Host | macOS, onPC 2.5.1.0 Release, hostname `bdsmbpm401` |
| Show / user | `test-fixture-disposable` (20 Mega Hex Par, FID 101–120; Sequence 2 "Beam Moves"), Admin |
| Bridge | the show's own `gma3_mcp_bridge` 0.25.1, `lua on`, input disabled. The probe uses no module API: it creates its objects and presses through `Cmd()` in Lua chunks, the dispatch shape of the KB-13 backend |
| Probe objects | Quickeys 960 (`KB28 A`) and 961 (`KB28 B`), assigned to executors 1.190 and 1.191 (all empty before); the code is rewritten with `Set('Code', …)` and read back before every press. Removed at the end of every run, slots verified empty |
| Other key sources | the NX-K surface plugin stopped (the probe refuses to run while `_G.__mtpnxk_surface.running`); no physical key was used. Desktop control only opened the pop-ups and cancelled one dialog (below) |
| Clearing | `Keyboard(1,'press','Escape')` up to three times on the command line; `CLEAR` (KB-10) inside the pop-up |

## Command line (`run`, 72/72)

| Code | Press puts | Hold 1.5 s | Rolled with digits |
| --- | --- | --- | --- |
| NUM0, NUM2–NUM4, NUM6–NUM9 | the digit | one token | yes: `12`, `23`, `90`, `- 6`, `Thru 8` … |
| PLUS / MINUS | `+ ` / `- ` | one token | yes: `4 + `, `- 6` |
| DOT / SLASH | `.` / `/` | one token | yes: `1.`, `.5`, `7/` |
| AT | `At ` | one token | yes: `1 At `, `At 2` |
| UPDATE / EDIT | `Update ` / `Edit ` | one token | yes, same as sequential taps: `1` then UPDATE gives `Update ` (the console drops the digit), UPDATE then `2` gives `Update Cue 2` |
| CUE / GROUP | `Cue ` / `Group ` | one token | yes: `1 Cue `, `Cue 2`, `1 Group `, `Group 2` |
| PREVIEW | `Preview ` (a keyword, not the preview-mode toggle: the mode stayed `Normal`) | one token | yes: `1 Preview `, `Preview Cue 2` |
| COPY / MOVE / DELETE / MACRO | `Copy ` / `Move ` / `Delete ` / `Macro ` | one token | **not qualified**, see below |
| FULL | nothing on an empty selection; with Fixture 101 selected, Dimmer 100 in the programmer, line empty | held 1.5 s on a cleared programmer: Dimmer 100 once, line empty, MA untouched, nothing on Unpress | not tested |
| HIGHLIGHT | toggles Highlight once (the reader shows it a frame later); Unpress leaves it; a second tap restores it | held 1.5 s: flipped once and stayed, Unpress left it | not tested |

NUM1 and THRU (KB-10: chord not qualified) now have rolled-pair evidence (`12`, `1.`, `1 Thru `, `Thru 8`).

### Rolled keywords that were taken out

The first full run rolled every keyword with a digit. `1` then COPY (and MOVE) lost the digit even as two
sequential taps (`Copy `); rolled, the line read `Copy Copy ` while both were down and executed when they came up.
`1` then DELETE opened the console's delete confirmation for the object selected in the sequence sheet
(`Delete Sequence 2 'Beam Moves' 7 'Circle Sync'`), and that dialog stalled the bridge's plugin thread (the next Lua
request timed out). It was cancelled by hand; cue 7 was still there afterwards and the probe objects had been removed.
These four keywords (MACRO would run a show macro the same way) are qualified for tap and hold only. Their combined
semantics with a held digit belong to the console's command syntax, not to the dispatch path, and were not run again.

## Edit Command pop-up (`popup`)

Opened with the keyboard icon on display 1 and left empty and focused; its text is the command-line buffer, read
through `CmdObj().cmdtext`. Each sequence was pressed once inside one Lua chunk and once as one request per key:

| Keys | One chunk | One request per key |
| --- | --- | --- |
| NUM1 THRU NUM5 | ` Thru 15` | `1 Thru 5` |
| NUM2 PLUS NUM3 | ` +23` | `2 +3` |
| NUM9 MINUS NUM4 | ` -94` | `9 -4` |
| NUM1 DOT NUM5 | `1.5` | `1.5` |
| NUM8 SLASH NUM2 | `8/2` | `8/2` |
| AT NUM5 NUM0 | `50` | `50` |

Within one chunk, keyword-like keys (Thru, `+`, `-`) land before digits pressed ahead of them, as in KB-10; DOT and SLASH
behave like digits. One key per request (each request is a later console frame) kept the order every time. **AT
inserted nothing in the pop-up**, at the start and mid-line (`1 At 5` typed one per request gave `15`).

## Calculator pop-up (by hand, `type`)

Fixture 101 selected, Dimmer encoder clicked: `[Absolute] Edit 'Dimmer 1' [0 .. 100]`. `type NUM7 NUM5 DOT NUM5` (one
request per key) showed `75.5` in the field; `type PLEASE` closed the pop-up and the programmer read Dimmer 75.5. In a
second opening, `type PLUS NUM1 NUM0` showed `+10`; Please stored **10**, not 85.5: in the calculator's Absolute mode
the entry is a value, not a relative step (the console's interpretation, not the key path). Programmer cleared
afterwards.

## Acceptance report

| Criterion | Answer |
| --- | --- |
| Tap / hold per code on the executor path | qualified for NUM0, NUM2–NUM4, NUM6–NUM9, PLUS, MINUS, DOT, SLASH, AT, UPDATE, EDIT, COPY, MOVE, DELETE, CUE, GROUP, MACRO, PREVIEW, FULL, HIGHLIGHT |
| Chord (rolled pairs) | qualified for the digits, PLUS, MINUS, DOT, SLASH, AT, UPDATE, EDIT, CUE, GROUP, PREVIEW, and now NUM1 and THRU, **only for the directed pairs tested** (held key first, then the key pressed next to it; the module lists exactly these, `CHORD_PAIRS`); not for COPY, MOVE, DELETE, MACRO, FULL, HIGHLIGHT |
| Text fields | keys reach the focused field (pop-up and calculator); order is kept when each key is its own request (frame); AT inserts nothing in the Edit Command pop-up |
| Held/latched state at the end | MASTATE false, command line empty, programmer cleared, probe objects removed, show not saved |

## Consequences

- `gma3_mcp_hardkeys` 0.11.0 adds the codes above to `BANK_QUALIFIED` with these flags and notes.
- A surface that types into dialogs dispatches at most one key press per console frame; several presses in one
  plugin tick can reorder a text field.
- The rolled pairs were pressed one request (frame) per key, so they qualify that lifecycle only. A combo presses its
  keys in one call, which is one frame on the shipped backends; the module refuses a combo with a probed code there
  (review 14 of #74) until a frame-separated or same-frame pair is probed.
- NEXT, PREV and MENU (selection stepping and a window) were not probed and stay on the shortcut table.

## Limitations

- One onPC, one show and user, macOS; no physical keys. Stuck-key recovery (a direct `Unpress Quickey`) was not tested
  for any new code and stays qualified for MA1 only.
- Probe objects are owned by name and the `kb28-probe` Note; cleanup releases a slot this process pressed before deleting it (`cleanup --unpress` for an aborted run).
- The bridge in this show was 0.25.1; the probe depends only on `lua`, `ping`, `feedback.read` and `programmer`.
- Rolled pairs cover the listed combinations, not every pair; release order was always first-down first-up, so the
  module releases a combo that contains one of these peer-restricted codes in press order (newest first stays the
  rule for the KB-10 MA1 + STORE chord).
