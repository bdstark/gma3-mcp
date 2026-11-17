# Saving and loading the show (SU-20)

Save the show file from a chat with no shell, without replacing another show's file by accident. Needs bridge
0.35.0; `gma3_load_show` needs 0.54.0.

| Tool | What it does |
| --- | --- |
| `gma3_show_files` | Read-only: the current show, the shows folder, and every `.show` file with its size and time |
| `gma3_save_show` | Save under the current name or a new one; answers SaveShow's own confirmation; reports the file written |
| `gma3_load_show` | Load another show from the shows folder, answer the unsaved-changes question as asked, and restart the bridge the load unloaded |

## What the console does (onPC 2.5.1)

From the probe ([su-20-save-show-macos-2.5.1.md](../probes/su-20-save-show-macos-2.5.1.md)):

- **Plain `SaveShow`** under the current name writes at once, with no dialog.
- **`SaveShow "name"`** under a new name asks "Change show file name?" (OK / Cancel). OK writes the file at once, and
  that name becomes the console's current show.
- **Under the name of another existing file**, it asks "Change show file name and overwrite existing show file?".
  Cancel writes nothing.
- **A dialog opened from the plugin thread stalls the bridge**, so the bridge queues SaveShow with `CmdIndirect`,
  which lands on a later frame. The server then polls and answers the dialog. Earlier records warned against
  SaveShow through the bridge: `SaveShow /NoConfirmation` read `/NoConfirmation` as a name and opened the rename
  dialog on the plugin thread.
- **The shows folder** (`GetPath(Enums.PathType.Showfiles)`) is listed with `DirList`. It reports each file's local
  wall-clock time as if it were UTC (6 h off in MDT). The bridge corrects it with the console's UTC offset (`time`)
  and keeps the wall-clock text (`localTime`).

## gma3_show_files

The current show and its file, the folder path, and every file newest first: name, size in bytes, `time` (ISO 8601,
UTC) and `localTime` (the console's wall clock). It includes the open dialog, if any.

## gma3_save_show

| Parameter | Meaning |
| --- | --- |
| `name` | Show name without `.show` (it is dropped if given). Default: the current show. 1-32 characters (outside ASCII, 32 bytes in UTF-8), no quotes, slashes, `\ : * ? < > |` or control characters, no leading or trailing spaces |
| `overwrite` | Replace another show's existing file with this name (default false: refuse) |
| `timeout_ms` | How long to wait for the save (2000-120000, default 20000) |
| `exclusive` | Required: the file is written and the current show name may change |

The console cuts a show name longer than 32 characters, so SaveShow's dialog would name another show and the tool
could not answer it. A longer name is refused before anything is sent. The 2.5.1 help says 31, but onPC 2.5.1 kept 32
live (see the [probe record](../probes/su-20-save-show-macos-2.5.1.md#name-length)). Only ASCII names have been seen,
so a name with other characters is counted in UTF-8 bytes, which may refuse a name the console would keep.

Steps:
1. **Read** the files and the current show. The tool refuses when a dialog is already open, when whether one is
   open can't be read (a failed lookup is never "no dialog"), when the current name can't be read, or when the folder
   can't be listed (an existing file could not be ruled out).
2. **Check the name.** The current name is a normal save. A new name expects the rename dialog. Another show's
   existing file expects the overwrite dialog and is refused without `overwrite: true`; the refusal names the
   file's size and time. Names compare case-insensitively, as on macOS and Windows.
3. **Queue** SaveShow. File times have whole seconds, so when the existing file is from the console's current
   second, the tool first waits until the clock has passed it. If the reply to the queue request is lost, the save
   may still run: it is watched, never resent, and never reported as "not queued".
4. **Poll** every 150 ms:
   - the expected dialog is answered with OK only when its message is the one the console shows for this show: "Do
     you intend to change the show file name to '<name>'?" or "You are going to change the show file name and
     overwrite the file with the name '<name>' that already exists. Do you want to continue ?".
     - The text around the name is compared with whitespace collapsed, since it wraps.
     - The name between the first and the last quote is compared exactly, every space and apostrophe kept: "Joe's
       Show" is not "s Show", and "Show  B" (two spaces) is not "Show B".
     - The bridge checks the title and the name again just before it clicks. Any other message is refused;
   - any other dialog stops the tool, including a same-title dialog for another show. It is reported and left for
     the operator, never answered;
   - the save is done when a file this save produced is there (new, or with a later time than before) and the
     console names it current.

   Only the latest read counts. If the last read failed, the tool reads once more. If that fails too, the result
   is `unavailable`, and the earlier read appears only as `lastObserved`.

Verification:
- `matched`: written and current. The result has `file` (name, size, time), `previous` (the current show and the
  file before), `current`, and `dialog` (expected, answered).
- `mismatched`: the file is missing or still has its earlier time, or another show is current.
- `unavailable`: an unexpected dialog, an unreadable dialog state, a lost reply with no write seen, completion that
  could not be observed, or nothing within the timeout.

A new name makes it the current show. The result warns that later saves without a name write the new file.

### After-save hook

Once a save is `matched` (and only then), the server starts a local program so the saved file can be recorded
elsewhere, for example committed to a git repository of show files. It runs detached with no stdio and never fails
the save. The tool waits at most 2 s for the program to start, because Node reports start failures (a missing
interpreter, a wrong path) as an event, not an exception. The result reports `afterSave: { hook, started }`, and a hook
that is configured but can't start adds a warning.

| Setting | Effect |
| --- | --- |
| `GMA3_AFTER_SAVE_HOOK=/path/to/program` | Run this program (a relative path is resolved against the server's working folder) |
| `GMA3_AFTER_SAVE_HOOK=` (empty) | Never run a hook |
| unset | Never run a hook (there is no default path: nothing runs unless the operator names the program) |

The program gets the name of the file the console wrote as its argument. Names compare case-insensitively, so this is
the console's spelling, not necessarily the one requested. It also gets `GMA3_SHOW_NAME`, `GMA3_SHOWS_PATH` (the
console's shows folder as the console reports it; empty if unknown) and the server's own environment, so
`GMA3_INSTALL_DIR` and `GMA3_BRIDGE_PORT` say which console saved. Two quick saves can start two hooks at once, so a
hook that writes to git should take a lock.

The bridge answers only SaveShow's own two dialogs (`show.answer` checks the title) and clicks only OK or Cancel.

## gma3_load_show

Loading a show unloads the show's plugins, this bridge included (plugins are show data). The bridge answers the
request that queues LoadShow and then goes away; the tool brings it back and judges the result from the new bridge.
From the probe ([load-show-macos-2.5.1.md](../probes/load-show-macos-2.5.1.md)):

- **A raw `LoadShow` through `gma3_command`** times out, and the bridge never answers again. The old socket stays
  open without answers; later connects are refused until the plugin is started.
- **With unsaved changes**, LoadShow first asks "Warning" / "Show file '<current>' has changed! Do you want to save
  the old show file first?" (Save / Do not save / Cancel). Without unsaved changes it loads with no dialog.
- **No plugin starts on show load** in onPC 2.5.1. `Plugin "gma3_mcp_bridge"` starts the bridge in about 1 s in a
  show that contains it; a macro with that line stored in the show is a one-tap start.

| Parameter | Meaning |
| --- | --- |
| `name` | Show name without `.show`, as `gma3_show_files` lists it; the same rules as for `gma3_save_show`. The file must be in the shows folder |
| `unsaved` | The answer when the current show has unsaved changes: `refuse` (default: Cancel, nothing is loaded), `save` (Save, then load) or `discard` (Do not save: the changes are lost) |
| `restart` | How the start command `Plugin "gma3_mcp_bridge"` (plus the bridge port when it is not 9800) is sent between probes until a new bridge answers. `auto` (default): `osc` when this server has an OSC sender, else `none`. `osc`: over OSC (`/cmd`). `keystroke` (opt-in, never chosen by `auto`): typed into onPC (macOS System Events; the server needs Accessibility permission; the keys go to whatever has onPC's keyboard focus, normally the command line, but live once a filter field). `none`: only wait, for an operator who starts the plugin |
| `timeout_ms` | How long to wait for the bridge after the load (5000-300000, default 120000) |
| `exclusive` | Required: the console's show is replaced and the bridge is stopped and restarted |

Steps:
1. **Read** the files, the current show and the running bridge's `instance` (`ping`, a new identity per start since
   0.53.0) and, from 0.53.0, whether the show has unsaved changes (`show.saveNeeded`). With unsaved changes and
   `unsaved: refuse`, the tool refuses here. The tool also refuses when a dialog is open, when whether one is open can't be read, when the current show's
   name or the instance can't be read, when the folder can't be listed, or when the file is not in it. Nothing is sent.
2. **Queue** `LoadShow "<name>"` with `CmdIndirect` (`show.load`), under the file's own spelling. The bridge checks
   the dialog state and the file again. An older bridge without `show.load` is reported as such. If the reply is
   lost, the load is watched, never resent.
3. **Watch** every 150 ms while the bridge still answers:
   - the unsaved-changes question is answered with the button `unsaved` names, only when its title and text are the
     ones for the current show (whitespace collapsed). The answered question may stay visible for a moment; that is
     not another dialog. `refuse` presses Cancel and reads back that the question closed and the same show and
     bridge instance answer: nothing was loaded (the result is still an error);
   - any other dialog stops the tool. It is reported and left for the operator, never answered;
   - two reads in a row that get no answer at all (the second over a fresh connection) mean the load has begun; an
     error reply or one slow frame does not. When the bridge still answers 15 s after LoadShow (15 s
     after the answer, for a save first), the load has not begun; the result says so and nothing is resent.
4. **Restart.** The old connection is closed. Every probe after the load is a fresh connection with a short
   timeout, and the start command is sent between probes, until `timeout_ms`. A ping from the instance that was
   running before is not counted (and stops the sends): it is not the new show's bridge.

Verification:
- `matched`: a new bridge instance answers and names the requested show as current. The result has `previous`,
  `current`, `file`, `restart` (how, the command, sends and failed sends, waited ms) and `unsavedAnswer` when the
  question was answered.
- `mismatched`: the bridge answers, but another show is current.
- `unavailable`: refused before the load, the question not answered, an unexpected dialog, a load that never
  began, no new bridge within `timeout_ms`, or a new bridge that does not name the show. When no new bridge came the
  result says why it is likely (only the old one answered, nothing sent, every send failed, or the show lacks the
  plugin / OSC input / the keyboard focus) and how to start it at the console.

Every restart needs the bridge plugin in the loaded show. OSC also needs OSC input with Receive Command on in that
show (`gma3_osc`); the console then accepts commands on every interface, so enable it only where that is acceptable, or start the
bridge at the console (`restart: none`, or `keystroke` on a Mac by choice). Otherwise the show is loaded but not confirmed. The restarted bridge runs with default policies (Lua, input and
control off; the result warns). A loaded show that carries a bridge older than 0.54.0 is confirmed with a warning:
re-import the plugin into that show and save it. There is no undo.

Live-tested by silly82 on macOS with the keystroke restart (`test/live/load-show.live.ts`, 3/3, in its fork as bridge
0.45.0); the OSC restart and the `saveNeeded` refusal are not live-tested yet (see the probe's open items).
