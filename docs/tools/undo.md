# Undo (#142, bridge 0.56.0)

`gma3_undo` undoes the last tool call(s) of this server. It needs undo groups (`GMA3_UNDO_GROUPS=1`, bridge 0.55.0):
each tool call's mutation span is one console undo group, so one Oops reverts the commands it sent. Bridge 0.56.0
answers `undo.close` with an id for a group that holds commands, and the server keeps those ids, newest last.

## gma3_undo

| Parameter | Meaning |
| --- | --- |
| `count` | How many of the latest grouped tool calls to undo, newest first (1-20, default 1). |
| `preview` | Check that the groups can be undone and send nothing. |

What it checks, before anything is sent:

- Undo groups are on, and the server has `count` groups to undo.
- No tool call without a group came after them. `gma3_load_show`, `gma3_save_show` and `gma3_patch_*` are never grouped
  (and `GMA3_UNDO_EXCLUDE` adds more), a failed `undo.open` and a 0.55.0 bridge's id-less close count too: Oops would
  not undo such a call as one step, so nothing older is undone.

Then the bridge (`undo.undo {ids, preview?}`):

1. Refuses while any undo group is open (the console answers Oops with "Not possible at the moment").
2. Checks each group is still on the console (`IsObjectValid` on the group handle) and its handle is readable.
3. Reads the console's undo list through the group handle's parent and checks that the groups are its latest steps, in
   order. Anything done at the console since (an operator, another connection, a property write or Lua of a tool call)
   is on top and refuses the call, naming that step.
4. With `preview`, stops here. Otherwise refuses (`busy`) while input ownership is active (an interaction, a held key,
   an input sequence or a surface gesture), the same admission `cmd` has, then sends one `Oops` per group, newest first,
   and reads back after each that the group left the undo list before sending the next. Every step of the list must be
   identified (handle text) for a read to count: a step that cannot be identified makes the check `unreadable`, and
   after an Oops it stops the run (`readback-unreadable`) with the group kept, since it may or may not have been undone.

Results: `succeeded` with `verification: matched` when every group left the list; `partial` when an Oops did not take
after earlier ones did (the remaining groups stay undoable); `unknown` for an Oops whose read-back could not be done;
`failed` with a read step when the bridge refused before any Oops (codes `busy`, `group-open`, `unknown-group`,
`group-gone`, `unreadable`, `not-latest`).

Not undone: property writes (`set`), commands queued with CmdIndirect (patch sessions, show load and save, recipe
editing, library import) and Lua. A tool that used them leaves steps outside its group: the latest-step check then
refuses rather than undo part of it. A patch change or a show load clears the console's undo list; those groups are
reported gone and forgotten.

## Not verified on a console

The undo list is read as the parent of the group handle (`CreateUndo` answers an object, `Root 20.1.1.1.1` on onPC
2.5.1, docs/probes/undo-and-hooks-macos-2.5.1.md) with the latest step as its last child, as the Oops menu lists it.
Neither that nor whether the handle stays readable after `CloseUndo` has been checked on a console. If either is wrong
the bridge answers `unreadable` or `not-latest` and nothing is undone: no blind Oops is ever sent.

Live test on a disposable show with `GMA3_UNDO_GROUPS=1`: `gma3_store_macro` (two macros), `gma3_undo preview: true`,
`gma3_undo` (both macros gone, one Oops); store again, select a fixture at the console, `gma3_undo` (refused,
`not-latest` naming the selection).
