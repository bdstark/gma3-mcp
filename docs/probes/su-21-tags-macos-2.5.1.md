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

Kill Instant / Kill Delayed behaviour, Protect during playback, playback with Forward Commands off and what each
pool action does were not probed.

## Not probed

- Presets, recipes, timecode tracks, layouts and executor-label assignment (the manual lists them).
- Tags across data pools (the tag pool is show-wide; `TagReference.DATAPOOL` records the pool), including how to
  address a sequence of another data pool in `Assign Tag … At …`.
- Two tags with the same name addressed by name (the manual says a name addresses every pool object that has it).
- `Lock` on a tag, and how the tag editor's "Add New Tag Reference" relates to the missing children.
- Undo of `Assign Tag`.
- Writing or clearing a tag's `APPEARANCE` (by number, name or handle; Lua `Set` or the command line).

The implementation probe below answers the data-pool form, kill and protect behaviour, Forward Commands off,
same-named tags and appearance writes.

## Implementation probe (2026-10-19, bridge 0.36.0)

Run while implementing the tools, on the same show, with the bridge's `cmd`, `set`, `object`, `dump` and new `tags*`
ops (Lua was on for the first part, off afterwards). Tags 950-952, Sequences 950-952, Group 950, Macro 950 and a
temporary DataPool 2 were created and deleted; Preset 4.1 got Tag 950 by mistake and it was removed again at once
(its `TAGS` read empty afterwards).

### Reading

| Read | Result |
| --- | --- |
| `GetReferences()` of a tag on a sequence, a cue, a group, a macro and a macro line | the `Part 0` reads `no` nil and `Get("Part")` 0; its cue's `no` is 1000 for cue 1 |
| a reference's data pool | the ancestor of class **`Pool`** (`Default`, `Pool 2`) whose parent is `DataPools`; there is no class `DataPool` |
| a part's `Addr()` | `14.14.1.7.950.-1.0`: the negative index does not resolve as an address, so a part is re-read as `[DataPool n] Sequence s Cue c Part 0` |
| `HandleToStr(tag)` | `#1BC000E42` here (nine hex digits; the length varies) |
| `Dump()` of a sequence | `TAGS = "950 'McpKill'"`: a third form, without the protect flag |
| `Tag` properties with `PropertyInfo` | `ACTION` is enum `TagActionToken`, `TAGTYPE` enum `TagType`, `FORWARDCOMMANDS` YesNo |

### Writing

| Command | Result |
| --- | --- |
| `Set Tag 950 Property "Action" "Toggle"`, `"Flash"`, `"Pool Default"` | applied (Lua `Set` with names, numbers or "3" is ignored) |
| `Set Tag 950 Property "Action" "bogus"` | `Not allowed`, unchanged |
| `Set Tag 950 Property "TagType" "Kill Delayed"` / `"bogus"` | applied / `Illegal value`, unchanged |
| `Set Tag 950 Property "ForwardCommands" "No"`, `"Note" "hello, world"` | applied (a note keeps commas) |
| `Set Tag 950 Property "Appearance" "Appearance 1"` | OK, but nothing is assigned |
| `Assign Appearance 1 At Tag 950` | assigned |
| `Set Tag 950 Property "Appearance" ""` | cleared (`Assign Off Appearance At Tag 950` answers OK and clears nothing) |
| `Store Tag 950 "Other" /NoConfirmation` on an existing tag | OK; the name and references are kept |
| `Assign Tag "NoSuchTag" At Sequence 950`, `Assign Tag 951 At ...` (no Tag 951) | **OK, and nothing happens** |
| `Assign Tag 950 At Fixture 1` | `Illegal object` |
| `Assign Tag 950 At Preset 4.1` | assigned (presets carry tags) |
| `Label Tag 951 "McpTag A2"` while Tag 950 is `McpTag A2` | stored as **`McpTag A2#2`**: names are kept unique |
| `Store DataPool 2 /NoConfirmation`, then `Assign Tag 951 At DataPool 2 Sequence 950` | only that data pool's Sequence 950 gets it (`dataPool` `Pool 2`); the Default pool's Sequence 950 is unchanged. `Assign Off`, a cue (`... Cue 1` → its Part 0) and the protect write work the same way |

### Kill types and Protect

Three empty sequences, each with one cue, all carrying Tag 950; `HasActivePlayback` read 300 ms after each command.

| Setup | Commands | Result |
| --- | --- | --- |
| Kill Instant | `Go+ Sequence 950`, `Go+ Sequence 951` | 950 off, 951 on: starting 951 turned 950 off |
| Kill Instant | then `Go+ Sequence 952` | 951 off at once, 952 on |
| Kill Instant, 951's reference protected | `Go+` 950, 951, then 952 | 951 **keeps running**, 952 on |
| Kill Delayed, `CueInFade` 2 s on Sequence 952 Cue 1 (empty cue, and again with a dimmer value) | `Go+` 951, then 952 | 951 still on at +0.3 s and +1.2 s, **off at +2.6 s** |
| Kill Delayed with no fade on 952 | `Go+` 952 | the others go off at once |
| Kill Instant | `Go+ Tag 950` | only Sequence 950 is left running; `Off Tag 950` turns everything off |
| Kill Instant, 951 protected, after 951 has run once (its flag now unreadable, see below) | `Go+` 951, then 952 | 951 keeps running: Protect still applies |
| Type None, Forward Commands **off** (live test) | `Go+ Tag 952` | OK, and **no tagged sequence starts**; with Forward Commands on again, all three start |

**The protect flag becomes unreadable.** After a kill tag has acted on a sequence, that tag's entry in the sequence's
`TAGS` holds other text where the flag was, in both roles, and the text can contain a comma:
`#5BC000E58:-'..--).0-*(+,))+(0(` (Edit role) and `McpKill:-'..--).0-*(+,))+(0(` (default role). It was the same text
on all three sequences, and another tag of type None on the same sequence kept its plain `0`. Writing
`#5BC000E58:1` replaces it, and the flag reads back until the sequence runs again. The bridge splits entries at each
`,#<hex>:` and reports such a flag as unknown.

The `CueFade` property of a part does not take a value through `Set` (it read back `0.00`); `CueInFade` does.
