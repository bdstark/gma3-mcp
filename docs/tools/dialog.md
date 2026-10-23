# Console dialogs (KB-27, in part)

`gma3_dialog`: bridge 0.40.0 (`dialog.read`, `dialog.press`). The design is [DIALOG.md](../../DIALOG.md) "KB-27"; the
evidence is the [KB-25 record](../probes/kb-25-dialogs-macos-2.5.1.md).

For a dialog no structured tool answers. The case it was built for: the MA Show Start's Position Wizard (macro 5002)
opens a Lua `Confirm()`, "Are you sure you want to overwrite positions?" with OK and Cancel, and waits for it. In the
Halloween 2026 build `gma3_run_macro` reported `paused_at_go`, and the agent walked `GetTopModal()` in `gma3_lua` and
clicked OK with `Mouse()`. `gma3_run_macro` now reports the open dialog ([macros.md](macros.md#gma3_run_macro)). Tools
that open their own dialogs answer them themselves: `gma3_save_show` (SaveShow's questions) and `gma3_patch_move` (Move
Fixtures).

## Parameters

| Parameter | |
| --- | --- |
| `action` | `read` (read-only) or `press` |
| `button` | `press`: the button's text exactly as `read` lists it, e.g. `"OK"` |
| `expect_title` | `press`: the dialog's title as `read` returned it; `""` for a dialog without one (a `Confirm()` has none) |
| `expect_text` | `press`: the dialog's message as `read` returned it; whitespace is compared collapsed (the message wraps) |
| `exclusive` | `press`: must be `true` |

At least one of `expect_title` and `expect_text` is required, so a dialog the caller has not read is never answered.

## read

`dialog.read` returns `open`, `modal` (or `false`) and the console's `lastCommand`. `modal` has the `GetTopModal()`
object's `class` (`MessageBox` for a confirmation) and `name`, `title` (the child named `Title`), `text` (the child
named `Text`), `display`, and `buttons` with their `text` and `enabled`, in screen order. Buttons have generic names
(`Button 3`), so they are known by their text only (KB-25). Hidden children are left out.

## press

| Step | Kind | Bridge op | What it does |
| --- | --- | --- | --- |
| `read_dialog` | read | `dialog.read` | A dialog is open with the expected title and/or message, and the button is there and enabled; otherwise nothing is sent |
| `press` | mutation | `dialog.press` | The bridge reads the top modal again and compares class, title and message once more, then clicks the one visible, enabled button with that text at its centre with `Mouse(display, "move" / "press" / "release")`. Two buttons with the same text are refused |
| `read_after` | read | `dialog.read` | Polls (100 ms, up to 1.5 s) until the dialog closed or another took its place |

`state` is `closed`, `replaced` (another dialog is open now: read it again), `still_open` (verification `mismatched`) or
`unknown`. The console's last command afterwards (`OK: …`, `User Canceled Command: …`) does not name the button, so the
effect is checked on the object the dialog was about.

## What it does not do

- It binds a dialog by its title and message, not by the UI object: two open-and-closed dialogs with the same title
  and message cannot be told apart. KB-27's object binding (a `HookDelete` token) is not done.
- No keys (Enter, Escape) and no text input fields; no overlays or pop-ups other than the top modal.
- Nothing about a button's meaning is known: Delete, Overwrite, Discard and Load buttons are pressed only because the
  call names them. Read the message first; a dialog button has no undo from here.
