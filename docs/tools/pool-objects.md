# Pool objects: copy, move, delete, rename (#141)

`gma3_pool_objects` copies, moves, deletes and renames groups, sequences, macros, MAtricks, timecodes, layouts and
presets, with a check before every command and a read-back after it. It replaces `gma3_command` lines such as
`Delete Group 5`, `Copy Sequence 3 At 9` and `Move Macro 1 At 3`, which a show rebuild otherwise sends unchecked.
No bridge change: it uses the `objects`, `children`, `object` and `cmd` ops.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `action` | `copy`, `move`, `delete` or `rename` |
| `object` | `"Group 5"`, `"Sequence 3"` (or `"Seq 3"`), `"Macro 12"`, `"MAtricks 2"`, `"Timecode 1"`, `"Layout 4"`, `"Preset 4.12"`. One object; ranges are refused (use the batch form) |
| `to` | copy and move: the destination number in the same pool; a preset also as `"4.20"` (same preset pool) |
| `name` | rename: the new name (required). copy: a name for the copy |
| `on_taken` | copy onto an occupied destination: `refuse` (default), `overwrite` (`/Overwrite`), `merge` (`/Merge`) |
| `on_name_taken` | a new name another object of the pool has: `refuse` (default) or `allow_suffix` |
| `force` | delete: delete even when the object is or may be in use; the uses become warnings |
| `preview` | read and plan, send nothing; the result has `plan` (the command lines) |
| `verify` | read back (default true) |
| `data_pool` | another data pool |
| `objects` | batch form: `[{action?, object, to?, name?, on_taken?, on_name_taken?, force?}]`; the other arguments (`action` too) are defaults for every item (an item's own fields win). A failed copy or move also skips later items on its destination |

Tags (`gma3_store_tag`, `gma3_delete_tag`), cues (`gma3_delete_cue`, `gma3_store_cues`) and fixtures (patch tools)
are refused with a pointer to their tools.

## Checks before anything is sent

Every action reads the object (`objects`: Name, Lock, the child count) and refuses when it does not exist or is not
an object of that pool. Move, delete and rename refuse a locked object (or one whose Lock cannot be read).

- **copy**: the destination is read; an occupied one is refused unless `on_taken` is `overwrite` or `merge`, and a
  locked destination is refused either way. A `name` is checked against the pool's names (`children`, as the store
  tools do, #102).
- **move**: only into a free number. The manual's Move: an occupied destination is pushed on to the next number,
  and so on until a free one, so a move onto a taken slot renumbers every object in between.
- **rename**: the name is checked against the pool's names; the object's current name sends nothing.
- **delete**: refused while the object is in use:
  - assigned to an executor: every page of the data pool is scanned (`children` of `DataPool.Pages`, as
    `gma3_assign_to_executor` reads sharing executors). The scan fails closed: a listing the console could not
    enumerate, a listing that stops before its total, a page without an address or number, an invalid executor, or
    an executor whose No or Object read failed (`fieldErrors`) makes it incomplete, and an incomplete scan refuses;
  - referenced by other objects: the object's `References` property (a preset's is text `"<handle>:<count>,..."`,
    sb-03), counted; a property that cannot be read refuses, because a use by cues, recipes or MAtricks cannot be
    ruled out then;
  - a sequence that is running (`object` op, `hasActivePlayback`).

  `force: true` deletes anyway; each use is a warning. Deleting a preset that cue data references turns those
  values into plain values and leaves no reference (docs/probes/cue-part-data-macos-2.5.1.md), so a forced delete
  loses that link for good.

## Commands

| Action | Command |
| --- | --- |
| copy | `Copy <object> At <destination> [/Overwrite or /Merge] /NoConfirmation`, then `Label <destination> "name"` when a name is given |
| move | `Move <object> At <destination>` |
| delete | `Delete <object> /NoConfirmation` |
| rename | `Label <object> "name"` |

Nothing is retried; a command without a reply is `unknown`, and in the batch form it stops the items after it.
Commands that name the object by number or by its old name (macro lines, cue commands) are not changed; the result
says so.

## Read-back

- copy: the destination exists with the given name, or else the source's name (a `"#2"` name the console gave a
  duplicate is accepted and reported), for a free destination and for `overwrite` alike; only `merge` without a
  name keeps the destination's own name, and its child count is not compared. Otherwise the destination holds the
  source's child count. The source is unchanged. A copy that keeps the source's name gets a warning: two objects under one name make a lookup by name
  ambiguous.
- move: the destination holds the object (name and child count), the source number is free.
- delete: the number is free.
- rename: the object reads the new name. With `on_name_taken: "allow_suffix"` a `"<name>#n"` the console gave a
  taken name (rename, or copy with a name) is accepted and the actual name is a warning.

## Not verified on a console yet

- Whether groups, sequences, macros, MAtricks, timecodes and layouts have a readable `References` property (only
  presets are probed). Where they do not, every delete of them needs `force: true`.
- The classes `Timecode` and `Layout` that a timecode or layout reads (`GetClass`); a different class refuses.
- `Copy ... At <Keyword> <n>` with the keyword repeated after `At` (the manual's example is `Copy Group 1 At 5`).

Live test on a disposable show: copy a group into a free number and onto a taken one with `overwrite`, move a macro
into a free number, rename a sequence, delete an unused preset and a preset a cue references (refused, then
`force`), and a sequence on an executor (refused).
