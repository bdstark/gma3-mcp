# Patch tools (KB-26, SU-03, SU-22)

`gma3_patch_types`, `gma3_patch_list`, `gma3_patch_add`, `gma3_patch_set`, `gma3_patch_remove`: bridge 0.19.0 (the
`patch.*` ops); an older plugin is reported as such. `gma3_patch_library`, `gma3_patch_import` and
`gma3_patch_remove_type` (fixture types, [SETUP.md](../../SETUP.md) SU-03): bridge 0.26.0. The design and its evidence
are in [DIALOG.md](../../DIALOG.md) ("KB-25", "KB-26"), the [KB-25 record](../probes/kb-25-dialogs-macos-2.5.1.md) and
the [SU-03 record](../probes/su-03-import-macos-2.5.1.md). `gma3_patch_library_add` (a file into the user library,
SU-22): bridge 0.38.0, [SU-22 record](../probes/su-22-library-add-macos-2.5.1.md). `gma3_patch_move` (fixtures under a
grouping fixture) and `gma3_patch_retype` (fixtures to another type of the same mode): bridge 0.40.0 and 0.29.0.

## Common behaviour

**No dialogs.** Patching on grandMA3 happens in the patch edit copy (`ShowData.Patch`). The Patch menu opens the copy
and asks "Save and Exit / Discard and Exit / Stay in Patch" when it closes. These tools never open the menu. They enter
the copy with `ChangeDestination "ShowData"."Patch"` and commit it with `ChangeDestination Root`, both sent with
`CmdIndirect`, which commits silently. `Cmd()` is never used: a dialog opened from the plugin thread would stall the
bridge.

**Exclusive use.** Every change tool requires `exclusive: true`; without it the call is refused before anything is
sent. The patch copy and the command line are shared with the operator. Opening the Patch menu fills the same copy,
and a session moves the operator's prompt into the patch. A change tool therefore assumes nobody else uses the console
for its ~10 seconds.

**Isolation check: best-effort detection.** Before committing, the tool fingerprints the copy and the live patch:
every object and property of every patch collection, leaving out the FIDs the call touches and the data the console
derives itself (listed in the KB-25 and KB-26 records; bridge 0.25.1 adds what a fresh fixture-type import leaves
different; bridge 0.38.0 leaves out the default curve's Min and Max points with their default values, one of which a GDTF import swaps for the other; bridge 0.38.1 leaves out a fixture type's `ORIGINALFILENAME`, which the live type keeps after an import and every copy has empty). It compares the two, one collection per request. Anything else that
differs means someone changed the show during the session: nothing is committed and the copy is left open.

Fixture types are compared by identity, not by number (bridge 0.26.0): deleting a type renumbers the ones after it,
and every display text naming a type carries its number. An import session leaves out what an import appends: the
new type at the end of the fixture-type list, and new attributes and features at the end of the attribute-definition
lists. Every other container (fixture lists, the inside of existing types) and every other collection is compared in
full, so an unrelated addition still fails the check. A type removal leaves the removed type out of the live side.

The check is read over several seconds, so it is **not a consistent snapshot**. An edit landing in a collection
after that collection was read is missed, and would be committed with the session. That is why exclusive use is
required rather than implied.

**No undo.** A committed patch change cannot be reverted with `Oops`. The tools say so in every successful result.

**The session.** Each change tool sends these steps, stopping at the first one that does not succeed:

| Step | Kind | Bridge op | What it does |
| --- | --- | --- | --- |
| `check_state` | read | `patch.state` | The command line is at Root, the copy is closed (nobody is in the Patch menu) and no modal is open |
| `check_add` / `check_edits` / `check_fixtures` | read | `patch.check` | The tool's pre-flight (below) |
| `enter` | mutation | `patch.enter` | Queues the two `ChangeDestination` commands into the copy and its stage's Fixtures |
| `wait_copy` | read | `patch.state` | Polls (100 ms, up to 3 s) until the copy is open at that destination |
| `add` / `set` / `remove` | mutation | `patch.add` / `patch.set` / `patch.remove` | The change, in the copy only |
| `isolation_check` | read | `patch.collections`, `patch.fingerprint` | Fingerprints of copy and live per collection, touched FIDs left out |
| `commit` | mutation | `patch.commit` | Queues `ChangeDestination Root` |
| `wait_commit` | read | `patch.state` | Polls until the destination is Root and the copy is closed |
| `read_back` | read | `patch.list` | After the commit; see each tool |

**When a session cannot be finished.** If the change step is refused or gets no reply, the tool closes the copy
again, but only when it provably holds no change at all: fingerprints equal with nothing left out (steps
`close_check`, `close`, `wait_close`). The same applies if the copy never opens. Otherwise, and always after a failed
isolation check, the copy is left open and the result carries `copyLeftOpen: true`.

The command line is then inside the edit patch, and **no Patch window is open**: the session entered the copy from the
command line, not through the menu. Menu › Patch only answers "Already in edit patch! Command line is inside of the
edit patch!" (live 2026-10-21). To keep everything in the copy, type `ChangeDestination Root` at the console: it
commits without a question, like the tools' own commit. No way to discard the copy without the Patch menu is known;
its "Discard and Exit" only appears when the copy was opened through the menu (KB-25). When the Patch menu itself is
open on a display (someone is patching there), close it there with **Save and Exit** or **Discard and Exit**.

**Outcome.** The outcome is decided per session, not by counting steps:

| Outcome | When |
| --- | --- |
| `succeeded` | The change was committed and the copy closed. `committed: true`; `verification` reports the read-back |
| `failed` | Nothing was committed (`committed: false`): a refusal before anything was sent, a refused change with the copy closed again, or a failed isolation check (`copyLeftOpen: true`) |
| `unknown` | A step after `enter` got no reply, the copy never opened, or the commit was not confirmed; `committed` / `copyLeftOpen` say what is known |

**Bridge-side safety net.** Each mutating op re-checks in the console:
- `patch.add`: the copy, the destination, a free FID range, a free DMX range inside one universe, a single-break
  mode. It calls `AddFixtures` once per fixture (amount 1, the fixture's own FID and address; bridge 0.25.2), stops
  at the first call that fails, checks that exactly the requested fixtures exist where requested, and deletes them
  again on any problem. A single call for a whole block crashed onPC 2.5.1 for a mode with cells (see
  [SETUP.md](../../SETUP.md) SU-02).
- `patch.set`: unpatches every fixture it readdresses first and then applies the new addresses, so swaps work. It
  checks the new ranges against every other fixture and restores every change of the call on any problem.
- **Unreadable occupancy is never free space.** A patched fixture whose range cannot be established makes every
  range check report it as `occupancyUnknown`, and an add or readdress is refused, both in the pre-flight and in the
  copy. Such a fixture has an unreadable break, a break that is not an address, a DMX mode that cannot be read, or a
  break the mode does not have. A rename or an unpatch adds no range and is not affected.
- `patch.remove`: refuses fixtures with sub-fixtures.
- All five mutating ops are on the bridge's input-ownership guard (refused with `[busy]` while someone owns console
  input) and need `exclusive = true`.

## gma3_patch_types

Read-only (`patch.types`). The show's fixture types with number, name, short name, manufacturer and source, and per
DMX mode its number, name, `footprint`, `breaks` (number of DMX breaks), `breakChannels` and `cells` (bridge 0.28.0,
`null` before: the geometry references under the mode's root geometry, which a patched fixture of that mode gets as
its selectable cells). `search` filters on
name, short name and manufacturer. Each type also has its `guid`. A type that is not in the show yet comes from the
library: `gma3_patch_library` finds it and `gma3_patch_import` adds it.

## gma3_patch_list

Read-only (`patch.list`). Fixtures of the live patch, every stage, sub-fixtures included, in patch order. The change
tools' read-back reads every page of their FID range. A listing that ends before its reported total makes the
verification `unavailable`; it never reports a fixture missing. Each row has
`fid`, `cid`, `idType`, `name`, `type`, `mode`, `patch`, `breaks` (`[{break, address}]`), `stage`, `depth`,
`parentFid`, `subfixtures` and `cells`. `subfixtures` counts child fixtures (a grouping fixture's members); `cells`
counts the fixture's own cells, its SubFixture children (12 on a 12-cell wall washer, 40 on a 40-cell Festoon, whose
`subfixtures` is 0; bridge 0.28.0). `fromFid` / `toFid` filter numeric FIDs; `limit` (default 200, max 2000) / `offset`
paginate.

## gma3_patch_add

| Parameter | |
| --- | --- |
| `type`, `mode` | Fixture type and DMX mode, by number or name (`gma3_patch_types`) |
| `fid` | First fixture ID; the block is `fid .. fid+count-1` |
| `count` | 1-256, default 1 |
| `name` | Optional; the console names the fixtures otherwise |
| `address` | DMX start `"U.AAA"`; fixtures are patched consecutively by the mode's footprint |
| `findFreeFrom` | Instead of `address`: the first free block from this `"U.AAA"` (`FindBestDMXPatchAddr`, re-checked) |
| `stage` | Default: the first stage. Fixtures are added at the stage's top level |
| `exclusive` | Must be `true` |
| `verify` | Default `true` |

With neither `address` nor `findFreeFrom` the fixtures are added unpatched.

Pre-flight (`patch.check` `add`), nothing sent on failure:
- the FID range is free (`CheckFIDCollision`);
- the mode has a single DMX break;
- the DMX block is free (`CheckDMXCollision` plus the bridge's own range check against every patched fixture) and
  fits inside one universe.

The change is `patch.add`. Read-back lists the new FIDs and compares, per fixture: present, patch address (start +
i × footprint), name (when given) and mode.

**Cells (SU-08).** When the new fixtures have cells, the result carries `cellLayout`:
- `cells`, the count;
- `shared`: the cells' positions come from the fixture type, and every fixture of that type and mode shares one
  layout;
- `ask`, for types whose names suggest cells laid out per install (festoon, string, strand, tape, strip, garland,
  bulb). It tells the agent to ask whether the fixtures should share one layout or get their own; see
  `gma3_layout_cells` in [positions.md](positions.md#cell-layouts-su-08).

## gma3_patch_set

`edits`: up to 256 of `{fid, address?, unpatch?, name?}`, each FID once, each changing something. `address` and
`unpatch` are exclusive.

Pre-flight (`patch.check` `edits`), nothing sent on failure:
- every FID exists;
- readdressed fixtures use single-break modes;
- the new ranges overlap no other patched fixture. The moving fixtures' own current ranges are ignored, so swaps and
  moves across a fixture's own range pass.

The change is `patch.set`. Read-back compares each fixture's patch address and/or name.

## gma3_patch_remove

`fids`: up to 256 FIDs, each once. Removing a fixture deletes it from the show; the console handles what referred to
it. Pre-flight (`patch.check` `fids`): every FID exists and has no sub-fixtures. The change is `patch.remove`.
Read-back checks the FIDs are gone. The result's `removed` lists the fixtures as they were.

## gma3_patch_move

Moves fixtures into a grouping fixture's children, or back to the stage's top level. The MA Show Start expects the rig
under its grouping fixtures FID 1–8; the Halloween 2026 build did this by hand in about 33 `gma3_lua` calls,
synthetic mouse clicks included (live, onPC 2.5.1, 2026-10-23). FIDs, addresses, names, groups and presets are kept.

| Parameter | |
| --- | --- |
| `fids` | 1-256 FIDs, each once, all with the same parent |
| `parent` | The FID of a top-level grouping fixture (type `Grouping`), or `"root"` for the stage's top level |
| `position` | `"absolute"` (default) or `"relative"`: the answer to the console's question below |
| `exclusive` | Must be `true` |
| `verify` | Default `true` |

**The question.** Pasting fixtures under another parent opens the console's own dialog "Move Fixtures": *keep the
absolute position and rotation in 3D space, or the offset relative to the parent?* (Absolute / Relative / Cancel).
`absolute` keeps each fixture where it is in the world (its pose relative to the new parent changes); `relative` keeps
its pose relative to the parent, so it moves with the parent's position and rotation. With a parent at the origin and
unrotated, as the Show Start's grouping fixtures are, both give the same result.

Pre-flight (`patch.moveCheck`, against the live patch), nothing sent on failure: every FID exists and holds no fixtures
of its own; all share one parent (the top level, or one top-level grouping fixture) in one stage; the target is another
top-level grouping fixture of that stage, or the top level when they have a parent. Fixtures with different parents are
moved in one call per parent. The pre-flight also reads what the read-back compares: the fixtures' rows, the poses of
the fixtures and of both parents (`objects`), and their groups (`patch.groupsOf`).

The edit is several steps, each queued by the bridge with `CmdIndirect` after it checked where the command line is (the
destination is compared by object address) and that no dialog is open, then polled with `patch.moveState` (100 ms, up
to 3 s) before the next one:

| Step | Bridge op | What it does |
| --- | --- | --- |
| `move_source`, `wait_source` | `patch.moveStep` `source` | `ChangeDestination <position>` into the fixtures' grouping fixture (only when they have one) |
| `move_cut`, `wait_cut` | `patch.moveStep` `cut` | `Cut <positions>` in that list (runs as `a Thru b`); waits for `OK: Cut …`. Nothing moves yet |
| `move_target`, `wait_target` | `patch.moveStep` `target` | `ChangeDestination ..` (out of a grouping fixture) and/or `ChangeDestination <position>` into the target |
| `move_paste`, `wait_dialog` | `patch.moveStep` `paste` | `Paste <end of the target's list>`; waits for the Move Fixtures dialog |
| `move_answer`, `wait_paste` | `patch.moveAnswer` | Clicks Absolute or Relative on that dialog, and only on a dialog with that title and message; waits for `OK: Paste …` with every fixture under the target |

Any other dialog stops the move and is left alone. When a step fails after the paste and the Move Fixtures dialog is
still open, the tool clicks Cancel (`cancel_dialog`), which moves nothing, so the copy can be closed unchanged. A
paste without a reply may still have been queued: the tool waits for its dialog and cancels it the same way. If the
console pastes without asking, the result says `dialog: "not_shown"` and the read-back still checks the pose.

The isolation check leaves out the moved FIDs and compares fixtures without their number in their list
(`fixturePositions: false`, bridge 0.40.0): taking fixtures out of a list renumbers the ones after them. The order of
every other fixture is still compared.

Read-back, against the state before the session: each fixture's parent, address (every DMX break) and name (`patch.list`), its groups
(`patch.groupsOf`: every group, in every data pool, whose selection holds the fixture or one of its cells, named
`<data pool>.<group>`; a group with an entry that
resolves to no (sub)fixture is reported unreadable, never as not holding them), and its 3D pose (`objects`):
`absolute` compares the world pose (the parent's position and rotation applied; mesh mirroring and scale are not
considered), `relative` the pose relative to the parent, within 1 mm and by quaternion. A part that cannot be read
makes the verification `unavailable` and names it; the result's `fixtures` lists each fixture's parent, address,
groups and poses.

**Live** (onPC 2.5.1, bridge 0.40.0, 2026-10-23, `test/live/patch-move.live.ts` 1/1 in 71 s on a disposable show):
two fixtures moved into a grouping fixture placed at x = 1 m (absolute), then back to the top level (relative), every
step succeeded and both read-backs matched. What the run established:
- `ChangeDestination ..` leaves a grouping fixture for the stage's list, and `Paste <count + 1>` appends at the end.
- Pasting back to the top level asks "Move Fixtures" too.
- Absolute changed fixture 997's local x from 2 to 1 under the parent at x 1 (world x stayed 2); relative kept the
  local pose. Addresses (3.001, 3.007) and Group 996 were kept.
- The isolation check (with `fixturePositions: false`) passed on both moves. Whether a move would have failed it
  without that option was not tried.

## gma3_patch_retype

Moves fixtures to another fixture type in the show whose DMX mode of the same name has the same expanded DMX
addressing (every channel at the same address in every cell, the same cells); FIDs, addresses, cells, groups and
preset values are kept. The case it is for: a GDTF fixed and imported again (`gma3_patch_import` with
`allow_duplicate`, Halloween finding #5) lands as a second type with the same name; this moves the fixtures to the new
import, and `gma3_patch_remove_type` then removes the old one by number. It is the same session as
`gma3_assign_cell_layout` (`patch.retype`, [positions.md](positions.md#gma3_assign_cell_layout)) under a patch-centred
name. Give `type` by number when two types share a name.

## gma3_patch_library

Read-only (`patch.library`). The fixture-type files the console can import, from its own library paths
(`GetPath`): the grandMA3 library (a few fixtures and scenery), the grandMA2 library (about 11 500 fixtures), the user
library and WorldServer downloads. Every word of `query` must occur in the manufacturer, model or file name, ignoring
case; for an `.xml` file also in its header's name, manufacturer, short name or description (read from the first
16 KB before filtering, cached by path, size and time). `sources` limits the libraries; scenery (`set@` files) is left out unless `include_sets`; `limit` (default 50,
max 500) / `offset` paginate.

Each entry has `source`, `file` (the name to import), `format`, `manufacturer` and `model` (from the file name,
`manufacturer@model[@revision].ext`), and:

| Field | |
| --- | --- |
| `name`, `modes` | From the XML header of a grandMA3 or user `.xml` (`modesKnown: true`). A grandMA2 `.pxml` is encrypted: its modes are known only after the import |
| `verified` | `false` for user-library `.xml` and WorldServer files: their import is not verified on the console yet. User-library `.gdtf` is verified (bridge 0.38.0, [SU-22 record](../probes/su-22-library-add-macos-2.5.1.md)) |
| `inShow` | Show types with the same manufacturer and name: importing again would add a duplicate. Names compare ignoring case, and an underscore in the file name matches a space (bridge 0.38.1: `Chauvet_DJ@Sentinel_Spot_Q60_ILS` is "Chauvet DJ", "Sentinel Spot Q60 ILS") |
| `set` | Scenery |

## gma3_patch_library_add

Puts a fixture-type file into the console's user fixture library (`GetPath(Enums.PathType.UserFixtures)`), so
`gma3_patch_import` can import it with no file access outside MCP. The bytes travel over the bridge, so the client need
not run on the console's machine. The show is not changed.

| Argument | |
| --- | --- |
| `file_name` | `manufacturer@model[@revision].gdtf` or `.xml` (the extension in lower case: the libraries are listed by `*.gdtf` and `*.xml`); no `< > : " / \ | ? * ..` (the characters Windows refuses; `:` would name an NTFS stream), control characters or leading dot. Defaults to `path`'s file name |
| `content_base64` | The file's bytes, base64 (strict: whitespace between groups only) |
| `path` | Instead of `content_base64`: a file on the MCP server's host, read by the server and sent the same way |
| `replace` | Overwrite a user-library file of the same name (default `false`: refused) |

Steps, stopping at the first one that does not succeed (nothing is written before `write`):

| Step | Bridge op | What it does |
| --- | --- | --- |
| `read_file` | | With `path` only: the file exists and is at most 8 MiB |
| `check_content` | | At most 8 MiB, not empty. A `.gdtf` must be a zip (stored or deflate entries, no zip64, no encryption) whose `description.xml` passes the zip CRC and is well-formed XML with a `GDTF` root and a `FixtureType` child with a `Name`; an `.xml` must be well-formed XML with a `GMA3` root and a `FixtureType` child with a `Name`. The XML is parsed, not matched: comments and CDATA are skipped, either quote is accepted, characters XML does not allow (literal or as references), `]]>` outside CDATA, a malformed XML declaration or one naming another encoding than UTF-8, and invalid UTF-8 are refused, and a DOCTYPE is refused (no entity is resolved). Reports the type's name, manufacturer, short name, DMX mode names and the GDTF `DataVersion` |
| `check_library` | `patch.libraryStat` | The name is in no other library (`Import Library` names the file only and could not tell them apart), and no library has it in other case only (one file on macOS and Windows; refused on every platform); a library whose folder or listing cannot be read refuses the upload (`scan-incomplete`) instead of counting as empty, and not in the user library unless `replace` (the refusal names its size and CRC-32, and whether they are the bytes sent) |
| `write` | `patch.libraryAdd` | 48 KiB chunks (64 KiB of base64 per bridge line). The bridge appends each at its offset to `<file>.<upload id>.gma3mcp-part` beside the target (no library extension, so it is never listed or imported). The id is random per call, so two clients sending the same name never mix their bytes or abort each other's upload; the first to finish wins and the other is refused as existing unless it replaces. The libraries are scanned for the name at the first and the last chunk only. When an upload starts, part files idle for 10 minutes, and part files no upload knows (left by a bridge restart), are removed. The last chunk checks the part file's size and CRC-32 against the whole file, then renames it into place. With `replace`, a platform whose rename does not overwrite (Windows) has the old file moved aside first and back again if the new one cannot take its place, so a failed replace keeps the old file. A replaced `.xml` drops its cached header, so `gma3_patch_library` reads the new one. A refusal removes the part file; on a lost reply the tool sends `abort` (`clean_up` step) |
| `read_back` | `patch.libraryStat`, `patch.library` | The file on the console has the size and CRC-32 sent, and `patch.library` lists it under source `user` |

The result has `file`, `path` (on the console), `size`, `crc32`, `replaced`, `fixtureType` (from the file),
`libraryEntry` (as `gma3_patch_library` lists it) and `next`: the `gma3_patch_import` call that imports it. It warns
when neither the type's name nor its manufacturer matches the file name (`gma3_patch_import` claims the new type only
when one does) and when the show already has a matching type.

## gma3_patch_import

`file` exactly as `gma3_patch_library` lists it, optionally `source`. One patch session at the copy's fixture-type
pool:

| Step | |
| --- | --- |
| `check_library` | The file is in exactly one library (`Import Library` names the file only, so a name in two libraries is refused); the show has no type matching it unless `allow_duplicate` (the console would silently add a second type with the same name) |
| `enter` | `patch.enter` with target `fixturetypes`: the copy, then its `FixtureTypes` |
| `import` | `Import Library "<file>" /Path ""` with `CmdIndirect` (no dialog). The console keeps the path of an earlier import command and resolves the next `Import Library` against it, so without `/Path ""` every library import answered "Object not found" (bridge 0.38.2, live 2026-10-22); an empty path is the library's own folders |
| `wait_import` | Poll until exactly one type is appended. Claimed only when its name or manufacturer matches the file (ignoring case; an underscore matches a space); two new types, or an error answer from the console, fail the step |
| `isolation_check` | Everything compared in full except the import's appends (the new type; new attributes and features) |
| `commit`, read-back | The type in the live patch by GUID, with the same modes |

The result has `type` (number, name, manufacturer, GUID, and the DMX modes with footprints and breaks),
`attributesAdded`, `library`, and a `warning` for an unverified source. A committed import has no undo.

## gma3_patch_remove_type

`type` by number or name (a number when two types share a name). Pre-flight (`patch.typeInfo`): the type exists, has a
GUID, and no fixture uses it. The change (`patch.removeType`) deletes it by GUID in the copy. The types after it move
down one number; fixtures keep their type and only the displayed number changes. The result's `renumbered` lists
`{name, from, to}`. Read-back checks the GUID is gone. **The attributes the type brought stay in the show**, unused: the
console keeps them, and they cannot be told apart from its own unused attributes.

## gma3_patch_type_structure (SU-07)

Read-only (`patch.typeStructure`, bridge 0.28.0). One fixture type of the show, by number or name. Evidence: the
[SU-07 record](../probes/su-07-type-structure-macos-2.5.1.md).

| Param | Notes |
| --- | --- |
| `type` | number or name, as `gma3_patch_types` lists it |
| `mode` | number or name; without it every mode is summarised |
| `channels` | list the DMX channels (default: true with a mode, false without) |
| `geometry` | the geometry tree and models (default: true with a mode, false without) |
| `unit` | lengths in `m` (default), `cm`, `mm`, `ft` or `in`; angles are degrees |
| `channel_limit` | most channel rows per mode (default 2000; `channelsTruncated` says when it cut) |

Per mode:
- `footprint`, `breaks`, `breakChannels`;
- `rootGeometry` and `size`, the root geometry's model with its length, width and height;
- `cells` and `cellList`: each cell's name, the template it references, its position and rotation, and its break
  offsets;
- `channels`, `addressesUsed` and `virtualChannels`.

**How channels are expanded.** A mode's DMX channels are templates:
- a channel on a geometry the cells reference repeats in every cell, at the cell's break offset + its own offset − 1;
- a channel on a geometry inside the mode's root is at its own offset;
- a channel without a coarse offset is virtual: it has no DMX address (an RGB fixture's dimmer).

Each row has the channel name, `attribute` (and `attributes` when its functions use several), `break`, `offset`
(1-based within the break), `fine` / `ultra` when present, `cell`, `virtual` and the default.

`addressesUsed` counts the addresses the rows cover inside each break's declared range (1 to its channel count). The
`limitations` name every gap: the addresses of a break no channel uses, an address outside its break's range or in a
break the mode does not have, two channels on one address, a cell without an offset for a channel's break, and a
channel whose break cannot be read (listed with `addressUnknown: true` and no break). No address is guessed.

**Geometry.** The tree comes as flat nodes: name, class, parent, depth, position, rotation, model, and for a
reference the template it points to and its break offsets. With a mode, only the geometry that mode uses is listed
(its root's tree and the templates its cells reference), together with the models those nodes use.

### Cell order (SU-19)

A mode's cells are numbered in geometry-tree order: the patched fixture's 401.1, 401.2 and so on. The bulbs along a
string are wired in DMX order instead, because data runs along the string. Each mode with more than one cell
carries `cellOrder`:

- `dmxRuns`: the cells in DMX order (by break, then the cell's offset in it), as runs. The Festoon's "Pixel Mode - 2
  string" reads `1-9, 19-29, 10-18, 30-40`, the interleave the field test worked out by hand.
- `differsFromCellNumbers`: whether that order differs from the cell numbers.
- `dmx`: the full list, when a mode is given.
- `stepsInDmxOrder` and `stepsInCellNumberOrder`: the distance between neighbouring cells, from the type's own
  positions, in `unit`. In DMX order the Festoon steps one 2 ft pitch at a time (the last four bulbs are bunched); in
  cell-number order it jumps up to 7.2 ft.
- No order is given when a cell's DMX address is not fully known. That covers a break the bridge could not read (the
  cell carries `breakOffsetsIncomplete` and a limitation names it), a malformed offset, or none at all. The other
  breaks are never used to guess. `gma3_layout_cells` and `{cells_of}` then refuse before anything is written.
- The steps need all three coordinates of both cells. An unreadable coordinate gives no steps, never a zero.

Use the order with `gma3_layout_cells` `order: "dmx"` ([positions.md](positions.md#gma3_layout_cells)) and with
`{cells_of: <fid>, order: "dmx"}` in group lists ([groups.md](groups.md#compact-specs-and-the-batch-form-su-12)).
Evidence: the [SU-19 record](../probes/su-19-fixture-type-data-macos-2.5.1.md).

### Wheels (SU-19, bridge 0.34.0)

`wheels` lists the type's wheels. Each wheel has:
- `kind`: `color` (a Color attribute drives it, or the wheel is named like one), `gobo`, or `other`.
- `functions`: the channel functions that drive it, per mode and channel, since function names are scoped to their
  logical channel: channel, attribute, and the DMX range in the channel's resolution.
- `bits`: 8, 16 or 24, from whether the channel has a Fine / Ultra address. If that can't be read (as opposed to an
  explicit None), `bits` and every DMX number are `null`, and a limitation says so.
- `slots`: name, `color` (`{r, g, b, a}` in 0..1), `media` and `appearance` (a gobo image), and `selectedBy`. That
  is the channel sets whose WheelSlotIndex picks the slot: mode, channel, attribute, set name, and `dmxFrom` /
  `dmxTo` in the channel's resolution (8-bit: the colour wheel's "colour 1" is 11-21).
- `slotColors`:
  - `set`;
  - `unset`, when every slot reads white. A colour wheel then gets a note to ask what colour each slot is instead
    of guessing; converted grandMA2-library types have no slot colours.
  - `unreadable`.
- `unselectedSlots`: slots no channel set selects.

The bridge sends the wheel channel functions beside the modes (`wheelFunctions`, each tagged with its mode), because
nested inside a mode they would pass the console serialiser's depth bound.

## Live test procedure

`test/live/patch.live.ts`, with `GMA3_LIVE=1` **and** `GMA3_LIVE_EXCLUSIVE=1` (patch changes are committed with no
undo). It needs a disposable show with a fixture type that has a single-break mode, and FIDs 990–993 free. It:
1. adds FID 990–991 named "MCP live patch" at the first free block from 3.001;
2. checks that a second add at FID 990 is refused before anything is sent;
3. swaps the two addresses and renames 990, then unpatches 991;
4. removes both, and checks that the command line is back at Root with the copy closed.

The cleanup is armed only after the run has passed the show guard and proved FIDs 990–991 free. It then removes only
those FIDs, and only fixtures whose name starts with "MCP live". A skipped run (a show that is not disposable, no
`GMA3_LIVE_EXCLUSIVE`) or a run that finds the FIDs occupied deletes nothing. `test/patch-live.test.ts` runs the live
file against a fake bridge in both cases and checks that no patch change is sent.

`test/live/type-structure.live.ts` (SU-07, read-only, any show with a fixture with cells) checks every mode of every
type: its channels cover its footprint with no limitation, every addressed channel lies inside the footprint and names
its attribute, and `gma3_patch_types` reports the same cell count. Every patched fixture's `cells` must equal its
mode's. One mode with cells is then read narrowed, in feet.

```bash
GMA3_LIVE=1 GMA3_LIVE_EXCLUSIVE=1 node --import tsx --test test/live/patch.live.ts
```

`test/live/patch-import.live.ts`, with the same two variables, bridge 0.26.0, a disposable show without Generic Fog or
Fan, and FID 994 free. It finds both in the grandMA2 library, imports Fog, checks a second Fog import is refused
before anything is sent, imports Fan, patches FID 994 as a Fan, removes Fog (Fan, after it, is renumbered while 994
uses it), checks removing Fan is refused while 994 uses it, then removes 994 and Fan. The cleanup removes only FID 994
named "MCP live import" and only the types the run imported, by GUID. 1/1 on macOS onPC 2.5.1 (2026-10-15), about
100 s.

```bash
GMA3_LIVE=1 GMA3_LIVE_EXCLUSIVE=1 node --import tsx --test test/live/patch-import.live.ts
```
