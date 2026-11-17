# Load-show probe: loading a show (macOS, onPC 2.5.1)

Evidence for `gma3_load_show` ([docs/tools/show.md](../tools/show.md#gma3_load_show)) and the bridge op `show.load`
(0.45.0).

Version note: this probe ran on silly82/gma3-mcp, where `show.load` and the per-start `instance` were bridge 0.45.0.
Upstream ships them as bridge 0.54.0 (`instance` and the ping's show state from 0.53.0); the console behaviour below
is unchanged. The keystroke restart used here is opt-in upstream (`restart: keystroke`); `auto` sends OSC or waits.

- **Date:** 2026-10-23
- **Platform:** macOS (Darwin 27.2), grandMA3 onPC 2.5.1.0, bridge 0.38.2 (the version stored in the shows used)
- **Method:**
  - raw `LoadShow "<name>"` and `NewShow "<name>"` sent through `gma3_command` (`Cmd` on the plugin thread);
  - the dialogs read from the screen and answered by hand;
  - the bridge restarted after each load by typing `Plugin "gma3_mcp_bridge"` at the console (keystrokes).
- **Show files:** copies of the operator's `saisonstart` show only; the original was not loaded or saved.

## Loading unloads the bridge

| Observation | Result |
| --- | --- |
| `LoadShow "<name>"` through `gma3_command` | the request timed out after 15 s; the bridge never answered again |
| Why | loading a show unloads the show's plugins, this bridge included: plugins are show data |
| The old TCP socket afterwards | stays open without answers (`ping`: "timeout after 4000ms") |
| Later connects | `ECONNREFUSED` until the plugin is started again |
| Plugin autostart on show load | none in onPC 2.5.1 (none found in the manual or the bridge docs) |

The answer to the request that queues the load is the last one the old bridge sends. Every check after the load
needs a fresh connection.

## Dialogs

| Command | Dialog | Answer and result |
| --- | --- | --- |
| `NewShow "<name>"` | "Create New Show" / "Do you want to create a new show named '<name>'?", New Show / Cancel | New Show creates the show |
| `LoadShow "<other>"`, current show has unsaved changes | "Warning" / "Show file '<current>' has changed!\nDo you want to save the old show file first?", Save / Do not save / Cancel | Save saved the old show, then loaded |
| `LoadShow "<other>"`, no unsaved changes | none | loads at once |

## Restarting the bridge

- Typing `Plugin "gma3_mcp_bridge"` at the console started the bridge in about 1 s in a show that contains the
  plugin.
- A macro stored in the show works as a one-tap start: Macro 100 with the line `Plugin "gma3_mcp_bridge"`, run with
  `Go+ Macro 100`.

## gma3_load_show live (bridge 0.45.0)

Same day, the plugin replaced by 0.45.0 in a disposable show (`mcp_test_load_start`), `test/live/load-show.live.ts`
run with `GMA3_LIVE=1 GMA3_LIVE_EXCLUSIVE=1 GMA3_LIVE_LOAD=1`, restart `auto` (keystrokes; OSC input stayed off).
Final run 3/3.

| Case | Result |
| --- | --- |
| Load a scratch copy, no unsaved changes | no dialog; two silent probes, then the keystroke restart (`Plugin "gma3_mcp_bridge"`, one send); a new instance named the scratch show after about 6 s: matched |
| Unsaved changes (a stored macro), `unsaved: refuse` | the question came; Cancel was pressed; read back: the question closed, the same show and the same bridge instance answered: nothing loaded |
| Back to the start show, `unsaved: discard` | Do not save was pressed; **its reply was lost**: the press starts the load at once and the load unloads the bridge first. The new instance naming the start show proves the press acted (the tool marks the step so) |

Corrections from the live run:
- The question's text is "Show file '<current>' has **changed!**" (exclamation mark). The first build expected a
  full stop, did not recognise the question, reported it as an unexpected dialog and answered nothing (the safe
  path); it was cancelled through `dialog.press` and the text fixed.
- Typed keys go to onPC's keyboard focus. Typing while the Add Window pop-up was open put the text into its filter
  field and ran nothing; the restart after a load found the command line focused every time.

## Open items

- The OSC restart path (`restart: osc`) right after a load is not live-tested: OSC input stayed off. It depends on
  the loaded show's OSC input settings (Enable Input, Receive Command), and the console then accepts commands on
  every interface.
- Windows (no keystroke restart there: `auto` uses OSC).
