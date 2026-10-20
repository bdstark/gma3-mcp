# SU-21 probe: tags (macOS, onPC 2.5.1)

Evidence for [SU-21 in SETUP.md](../../SETUP.md#su-21--tags).

- **Date:** 2026-10-19
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.35.0
- **Method:** the bridge's `lua`, `cmd`, `object`, `children` and `dump` ops on Tags 950–952, Sequences 950–952,
  Group 950 and Macro 950 (all empty before, all deleted afterwards; the show had no tags before or after).
  Manual pages: [Tags](https://help.malighting.com/grandMA3/2.5/HTML/tags.html),
  [Tag keyword](https://help.malighting.com/grandMA3/2.5/HTML/keyword_tag.html).

## Where tags live

| Lua | Result |
| --- | --- |
| `DataPool().Tags` | a **string**: the data pool's own `TAGS` property (empty), not a pool |
| `ShowData().Tags` | the `Tags` pool at `14.5`, **show-wide** (not per data pool), `Count()` 1000 with no tags stored |
| `ShowData().Tags:Ptr(i)` | nil for empty slots: the pool is sparse, list it with `:Children()` |
| `ShowData().Tags[950]` | the tag stored at 950 (`Tag`, address `14.5.950`) |
| `ObjectList("Tag Thru")`, `"Tag 950 Thru 952"` | resolve tags like any pool range |

`Tag` properties (schema): `NAME`, `NOTE`, `SCRIBBLE`, `APPEARANCE`, `TAGS` (a tag can carry tags), `TAGTYPE`
(enum `TagType`: None 0, Kill Instant 4, Kill Delayed 5), `FORWARDCOMMANDS` (YesNo, default Yes), `ACTION`
(`TagActionToken`, default "Pool Default"), `LOCK`. `STRUCTURELOCKED` reads Yes. `NO` reads as display text
`"950 (2)"`: the number with the reference count appended.

## Creating, naming, deleting

| Command | Result |
| --- | --- |
| `Store Tag 950 /NoConfirmation`, `Store Tag 951 "McpTag B" /NoConfirmation` | creates the tag, named in one step with a quoted name |
| `Label Tag 950 "McpTag A"` | renames |
| `Store Tag 952 "McpTag C" /NoConfirmation` | created as `McpTag C` (used by name below) |
| `Label Tag 952 "Mcp,Tag:C"` (after the assignments below) | stored as `McpTag:C`: **commas are stripped, colons kept** |
| `Delete Tag 951 /NoConfirmation` while assigned to sequences, a group, a macro, a macro line and a cue part | deleted; it disappears from every object's `TAGS` at once, with no dangling text |

## Assigning

| Command | Result |
| --- | --- |
| `Assign Tag 950 At Sequence 950` | OK; `Sequence 950:Get("Tags")` → `McpTag A:0` |
| `Assign Tag 951 At Sequence 950` (second tag) | `McpTag A:0,McpTag B:0` |
| `Assign Tag "McpTag C" At Sequence 950 Thru 952` (Tag 952 still named `McpTag C`; it was relabelled later) | by name and over a range: all three sequences get it |
| the same assignment twice | idempotent (count unchanged) |
| `Assign Tag 951 At Group 950`, `At Macro 950`, `At Macro 950.1` | group, macro and macro line each carry it |
| `Assign Tag 950 At Tag 952` | tag on tag works (`Tag 952` `TAGS` → `McpTag A:0`) |
| `Assign Tag 951 At Sequence 950 Cue 1` | lands on the cue's **`Part 0`** (`14.14.1.7.950.-1.0`), not on the `Cue`; the cue has no `TAGS` property |
| `Assign Off Tag 950 At Sequence 952` | removes it from the sequence |

## Reading: the object side

An object's `TAGS` property is a comma-separated list of `<tag>:<flag>`, where the flag is the reference's
`Protect` (0/1):

| Read | Value |
| --- | --- |
| `s:Get("Tags")` (default role) | `McpTag A:0,McpTag B:0`: tag **names** |
| `s:Get("Tags", Enums.Roles.Edit)` (what the bridge's `object` op uses today) | `#BC000E42:0,#BC000E44:0`: tag **handles** |
| `HandleToStr(ShowData().Tags[950])` | `#BC000E42`; `StrToHandle("#BC000E42")` returns the tag |
| after setting the reference's `Protect` to Yes | `McpTag A:1,McpTag B:0` |
| with a tag named `McpTag:C` | `McpTag A:1,McpTag:C:0`: the name form must be split on the **last** colon; the handle form is unambiguous |

So `gma3_get_object` already returns `TAGS`, but as unresolved handles (the bridge's `#hex` resolution only handles a
single handle, not a list).

## Reading: the tag side

| Read | Result |
| --- | --- |
| `tag:Count()` | the number of references, correct (3 for three sequences; a later frame is needed after a change in the same Lua chunk) |
| `tag:Children()`, `:Ptr(i)`, `Dump()` | **only the first reference** appears as a `TagReference` child; `Ptr(2)` is nil and `Dump()` prints `Count: 2` above one child. Unchanged after more assigns in later requests |
| `TagReference` properties | `CLASS` ("Sequence"), `DATAPOOL`, `NO`, `NAME`, `OBJECTHANDLE`, `PROTECT` (writable) |
| `tag:GetReferences()` | **every** referencing object as a handle: sequences, group, macro, `MacroLine`, `Part`, another `Tag` |
| `tag:HasReferences()` | true |

`GetReferences()` is the reverse lookup a tool should use. It returns the referencing objects themselves, so a
reference's `Protect` has to be read from that object's `TAGS` flag.

## Writing the object side directly

| Lua | Result |
| --- | --- |
| `s:Set("Tags", "McpTag B:0")` | replaces the list by name |
| `s:Set("Tags", "#BC000E42:1,#BC000E44:0")` | replaces the list by handle, protect flag included; the tags' `Count()` follow |
| `s:Set("Tags", "")` | **silently ignored**: the list is unchanged. Clearing needs `Assign Off Tag … At …` |

## Tag settings

| `tag:Set(...)` | Read back |
| --- | --- |
| `TagType "Kill Instant"`, then `"None"` | applied |
| `TagType "KillDelayed"`, `TagType "bogus"` | silently ignored (value unchanged) |
| `ForwardCommands "No"` / `"Yes"` | applied |
| `Action` with any value: `"Off"`, `"Go+"`, `"Toggle"`, `"Flash"`, `"List Reference"`, `"None"`, `8`, `"8"` | **all silently ignored** ("Pool Default" kept) |

`Action` is written through the command line instead (second run, 2026-10-20, Tag 950 created and deleted):

| Command | Read back |
| --- | --- |
| `Set Tag 950 Property "Action" "Off"`, `"Toggle"`, `"Go+"`, `"Flash"`, `"Temp"`, `"Top"`, `"Pause"`, `"List Reference"`, `"None"`, `"Pool Default"` | each applied, feedback OK |
| `Set Tag 950 Property "Action" "bogus"` | feedback `Not allowed`, value unchanged |

`Enums.TagActionToken`: None 0, Flash 1, Go+ 3, Off 8, Temp 13, Toggle 14, Top 15, Pause 18, List Reference 100,
Pool Default 417.

As with sequences and executors (SB-01), invalid values are dropped without an error, so every write needs a read-back.

## Playback through a tag

| Command | Result |
| --- | --- |
| `Go+ Tag 950` (Forward Commands on, three empty sequences tagged) | all three start (`HasActivePlayback` true, current cue 1) |
| `Off Tag 950` | all three stop |

Kill Instant / Kill Delayed behaviour, Protect during playback and what each pool action does were not probed.

## Not probed

- Presets, recipes, timecode tracks, layouts and executor-label assignment (the manual lists them).
- Tags across data pools (the tag pool is show-wide; `TagReference.DATAPOOL` records the pool), including how to
  address a sequence of another data pool in `Assign Tag … At …`.
- Two tags with the same name addressed by name (the manual says a name addresses every pool object that has it).
- `Lock` on a tag, and how the tag editor's "Add New Tag Reference" relates to the missing children.
- Undo of `Assign Tag`.
