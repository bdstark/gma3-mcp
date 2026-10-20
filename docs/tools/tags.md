# Tags (SU-21)

Create tags, put them on sequences, groups, macros, cues and other objects, find which objects carry a tag, and set a
tag's kill type and forwarding, without raw commands or Lua. Needs bridge **0.36.0** (the `tags`, `tags.of` and
`tags.protect` ops, and `TAGS` decoded in the object reads). Evidence:
[the SU-21 probe record](../probes/su-21-tags-macos-2.5.1.md).

| Tool | What it does |
| --- | --- |
| `gma3_tags` | Read-only: the tags with their settings and the objects that carry each one (reverse lookup), filtered and paged; or the tags given objects carry |
| `gma3_store_tag` | Create or rename tags |
| `gma3_delete_tag` | Delete tags; reports the objects each was removed from and re-reads them |
| `gma3_assign_tag` | `Assign [Off] Tag n At <objects>`, with `protect` per reference and `data_pool`; reads every object back |
| `gma3_configure_tag` | Type (None, Kill Instant, Kill Delayed), Forward Commands, pool action, appearance and note |
| `gma3_playback` on `Tag n` | Go+, Off, ... on a tag: the tag's sequences are resolved first and each one is read back |

`gma3_get_object`, `gma3_objects` and `gma3_list_children` return an object's `TAGS` as a list of
`{tag, name, protect}`, not as raw handles.

## What the console does (onPC 2.5.1)

- **The tag pool is show-wide** (`ShowData().Tags`, one pool for every data pool), and sparse.
- **A tag can be on** sequences, groups, macros, macro lines, presets, other tags and cues. A cue's tag lands on its
  **Part 0** (the cue itself has no `TAGS`), so results list the part: `Sequence 5 Cue 2 Part 0`. Fixtures cannot carry
  tags (`Illegal object`).
- **`Assign Tag` with a tag that does not exist answers OK and does nothing**, and `Store Tag` on an existing tag
  answers OK and keeps its name. The tools check the tag first and read everything back.
- **Names are unique.** Labelling a tag with another tag's name stores it with `#2` appended. Commas are removed from
  names. Both are refused before anything is sent.
- **Kill types** (live): with **Kill Instant**, starting one tagged sequence turns the other tagged sequences off at
  once. With **Kill Delayed**, it turns them off after the started cue's in-fade (2 s in the test). A reference with
  **Protect** keeps running. `Go+ Tag n` on a kill tag starts the sequences one after another, so only one is left
  running. The manual says to set the type before the sequences run (otherwise it applies once they have been
  started).
- **Forward Commands** (on by default) passes playback commands on the tag (`Go+ Tag n`, `Off Tag n`, ...) to every
  tagged object. With it off, `Go+ Tag n` answers OK and starts no tagged sequence (live).
- **Settings through the command line**: `Set Tag n Property "TagType" | "ForwardCommands" | "Action" | "Note"`. An
  illegal value there is answered `Illegal value` / `Not allowed`; Lua `Set` would ignore it silently. Appearance is
  assigned with `Assign Appearance a At Tag n` and cleared with `Set Tag n Property "Appearance" ""`.
- **The reverse lookup** is `tag:GetReferences()`, which lists every object. `tag:Children()` lists only the first.
- **An unreadable protect flag:** once a kill tag has acted on a sequence, that tag's entry in the sequence's `TAGS`
  holds other text instead of the 0/1 protect flag (`#5BC000E58:-'..--).0-*(+,))+(0(`, in both roles). The tools report
  `protect: null, protectUnreadable: true` there. Protect still applies, and can be written; it reads back until the
  sequence runs again.

## gma3_tags

| Parameter | Meaning |
| --- | --- |
| `tags` | Tags by number or exact name (default every tag); missing ones are listed in `missing` |
| `from`, `to` | A number range |
| `class` | Only objects of this class: `Sequence`, `Group`, `Macro`, `MacroLine`, `Part` (a cue), `Preset`, `Tag` |
| `references` | List the objects (default true) |
| `offset`, `limit` | A page of tags (default 0 and 100, at most 1000); `total` and `incomplete` say whether more follow |
| `references_offset`, `references_limit` | A page of each tag's objects (default 0 and 200, at most 2000); `objectsIncomplete` per tag |
| `of` | Instead: the tags these objects carry (`"Sequence 1 Thru 10"`, `"Sequence 5 Cue 2"`), with `data_pool` for another data pool |

"Every sequence tagged Encore" is one call: `tags: ["Encore"], class: "Sequence"`. Each object comes with its class,
name, data pool, address and protect flag.

## gma3_store_tag

| Parameter | Meaning |
| --- | --- |
| `tag` | Tag number (1-9999) |
| `name` | The name. It follows `objectName()`, like every other object name: none of `\ " $ & * ? , . ; ^ { } \| ~`. A name another tag already has is refused |
| `if_exists` | `refuse` (default) or `rename` an existing tag |
| `verify` | Read back (default true) |

Sends `Store Tag n "name" /NoConfirmation` or `Label Tag n "name"`. Nothing is sent when the tag already has the name.
Batch form: `tags: [{tag, name, if_exists}]`.

## gma3_delete_tag

`tag` by number or exact name. Reads every object that carries it (all pages of `GetReferences()`), sends
`Delete Tag n /NoConfirmation`, then reads back that the slot is empty and re-reads each object (up to 200) to confirm
the tag has gone. `removedFrom` lists the objects, each with `stillCarries`. Batch form: `tags: [{tag}]`.

## gma3_assign_tag

| Parameter | Meaning |
| --- | --- |
| `tag` | Number or exact name. A name is resolved to the number first, and the command always uses the number. A name more than one tag has is refused |
| `target` | A reference with numbers: `Sequence 950 Thru 952`, `Group 5`, `Macro 3`, `Macro 3.1`, `Sequence 5 Cue 2`, `Preset 4.1`, `Tag 7` |
| `data_pool` | The objects of another data pool: `Assign Tag n At DataPool 2 Sequence 950` (verified: the current pool's Sequence 950 is untouched) |
| `off` | Remove the tag instead |
| `protect` | Set the reference's Protect flag (default: left as it is). Written by rewriting the object's `TAGS` in handle form (`tags.protect`). An object whose other tag's flag cannot be read is refused rather than reset |
| `verify` | Read back (default true) |

Before sending, the objects are read: a missing object, a cue without a part, or an object that cannot carry tags
refuses the call. After sending, every object is read back. With `off`, none may list the tag; otherwise all must,
with the requested protect flag. Each object in the result gives `carries`, `protect`, `changed` and its tags. Batch
form: `assignments: [{tag, target, off, protect, data_pool}]`; `tag` and `data_pool` may be given once for all.

## gma3_configure_tag

| Parameter | Values |
| --- | --- |
| `type` | `None`, `Kill Instant`, `Kill Delayed` |
| `forward_commands` | true / false |
| `action` | `Pool Default`, `None`, `Go+`, `Off`, `Toggle`, `Flash`, `Temp`, `Top`, `Pause`, `List Reference` (the `TagActionToken` enum) |
| `appearance` | an appearance number (checked to exist), or `null` to clear |
| `note` | text (no double quotes); `""` clears it |

Values outside the lists are refused before sending. One command per setting, in that order; a refused one stops the
rest. Everything is read back. Batch form: `tags: [{tag, ...settings}]`.

## Playback on a tag

`gma3_playback` with `target: "Tag 5"` or `target: "Tag \"Encore\""`: the tag is resolved first (an unknown tag or a
name more than one tag has sends nothing), the command addresses it by number, and `playbackState.sequences` gives
each tagged sequence's state a frame later. A warning says when Forward Commands is off (the command then reaches no
sequence) or when the tag is a kill type and the command starts sequences.

## Live test

`test/live/tags.live.ts`: Tags 950-952, Sequences 950-952, Group 950, Macro 950, and DataPool 2 with its Sequence 950
(all must be absent; deleted at the end). Covers:
- create, the comma and duplicate-name refusals, and rename;
- assign over a range by name, on a group (protected), a macro line, a cue, and a sequence of DataPool 2;
- the reverse lookup with paging, and the decoded `TAGS`;
- `Go+` / `Off Tag` read back per sequence, `Go+ Tag` with Forward Commands off (nothing starts) and on again, and the
  settings;
- Kill Instant with a protected reference, and Kill Delayed after a 2 s fade;
- unassign, and delete with the objects re-read.
