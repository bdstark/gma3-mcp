# Import Library and the console's library listing (bridge 0.41.0)

- **Date:** 2026-10-23
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, bridge 0.42.0 (`patch.import` as on main, 0.38.2), then
  0.41.0
- **Show:** mcp-test-disposable (throwaway, not saved)
- **Files:** `generic@fan.pxml` (grandMA2 library), `generic@grouping.xml` (grandMA3 library),
  `SHEHDS@180W_Beam@2026-10-20.gdtf`, `SHEHDS@180W_Beam@2026-10-22.gdtf` and
  `Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf` (user library, `~/MALightingTechnology/gma3_library/fixturetypes`)

## The failure

On 2026-10-23 the Halloween show-build fixes (#87) were checked live. Two `gma3_patch_import` runs of `generic@fan.pxml`
succeeded. After them, both SHEHDS files answered `Object not found: Import Library "<file>" /Path ""`, on two runs,
although bridge 0.38.2 (#86) sends `/Path ""`. Reproduced here: after the bridge reload, `gma3_patch_import` of
`generic@fan.pxml` succeeded and `SHEHDS@180W_Beam@2026-10-20.gdtf` (source user) answered `Object not found`. The copy
was closed unchanged.

## Why

`Import Library "<file>"` looks the name up in the console's cached library listing, `CmdObj().Library` (class
`Library`), not in the folder. Its children are `FixtureTypeFile` objects with `FileName` and `Path`. It has
`LIBRARYPATH` (the shipped `lib_fixture_types`), `OPTIONALLIBRARYPATH` (the user library), `LIBRARYDESTINATION` and
`USECACHE` (true).

| When | `LIBRARYDESTINATION` | Listing |
| --- | --- | --- |
| Before the bridge reload | nil | 11 709: grandma3 171, grandma2 11 535, user library 3 |
| After the reload (`Import Plugin Library`) | `Plugin` | 25 plugin files |
| After the `.pxml` import | `FixtureType` | 11 706: grandma3 171, grandma2 11 535, **no user library** |

When an import finds the listing built for another destination, it rebuilds it. The rebuild for fixture types took the
shipped library only: its cache, `lib_fixture_types/libcache.dat2.dat` (2026-10-14), names no user-library file.
`OPTIONALLIBRARYPATH` was set, and the user folder's own cache (`fixture_cache.dat`, 01:56 that night) listed all
three files, but neither was used. So whether a user-library import worked depended on who last built the listing.
The Patch menu's import dialog builds it with the user library: after a bridge reload, which imports a plugin, the
first fixture-type import rebuilds it without.

What did not bring the user library back (each followed by the user `.gdtf` import, all `Object not found`):

| Tried | Effect on the library |
| --- | --- |
| `/Path "/Users/…/gma3_library/fixturetypes"` | `LIBRARYPATH` became `…/lib_fixture_types/Users/…/fixturetypes`: `/Path` is relative to the shipped library |
| `/Path "" /Type "User"`, `/Type "User"` (twice in a row) | `LIBRARYPATH` became the user library and `OPTIONALLIBRARYPATH` empty; the listing unchanged |
| `/Type "GDTF"`, `"grandMA3"`, `"Shares"` | the paths back to the defaults; the listing unchanged (`Enums.FixtureTypeSourceImport` is grandMA3 0, grandMA2 1, User 3, Shares 4) |
| `List Library`, `Select Drive 1`, `Call FixtureType Library` | the paths back to the defaults; the listing unchanged |
| A successful `Import Library "generic@grouping.xml" /Path ""` | the listing unchanged |
| `RefreshLibrary(ShowData().Patch.FixtureTypes)` | the paths back to the defaults; the listing rebuilt without the user library |
| `RefreshLibrary(CmdObj().Library)`, then the import | a 1-entry listing of `onpc/temp`; the import rebuilt it without the user library |
| Moving the user folder's stale `fixture_cache.dat2` (121 bytes, 2026-10-16, no entries) aside, then a rebuild | the listing unchanged and no cache written there: the rebuild does not read the user folder (the file was put back) |

So the console does keep the library type of an earlier import, as suspected, but `/Type` cannot select it back:
the listing the name is resolved in is the problem.

## The command that works

grandMA3's own system tests import fixture types with `Import <no> /File "<name>" /Path "<absolute folder>"`
(`lib_plugins/systemtests/help/system_test_helping_functions_patch.lua`). In the copy's FixtureTypes, with the listing
still missing the user library (`Cmd`, synchronous):

| Command | Answer | Copy |
| --- | --- | --- |
| `Import 9 /File "SHEHDS@180W_Beam@2026-10-20.gdtf" /Path "…/gma3_library/fixturetypes" /NoConfirmation` | OK | type 9 "180W Beam" by SHEHDS, Source User |
| `Import /File "generic@fan.pxml" /Path "…/grandma2"` (no number), likewise for the other files | Object not found | unchanged: the number is required |
| `Import 10 /File "generic@fan.pxml" /Path "…/lib_fixture_types/grandma2"` | OK | type 10 "Fan", Source grandMA2 |
| `Import 11 /File "SHEHDS@180W_Beam@2026-10-22.gdtf" /Path "…/gma3_library/fixturetypes"` | OK | type 11 "180W Beam", Source User |
| `Import 12 /File "generic@grouping.xml" /Path "…/lib_fixture_types/grandma3"` | OK | type 12 "Grouping", Source grandMA3 |
| `Import 13 /File "Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf" /Path "…/gma3_library/fixturetypes"` | OK | type 13 "Sentinel Spot Q60 ILS" by Chauvet DJ |

The listing was not touched by any of them: the file is read from the folder named.

**A taken number:**

| Command | Result |
| --- | --- |
| `Import 13 /File "generic@grouping.xml" /Path "…/grandma3" /NoConfirmation` | OK, and type 13 (the Sentinel) was **overwritten** by Grouping |
| `Import 14 /File "SHEHDS@…-10-20.gdtf" /Path "…"` (free, no `/NoConfirmation`, `CmdIndirect`) | OK, no dialog, type 14 appended |
| `Import 14 /File "generic@grouping.xml" /Path "…"` (taken, no `/NoConfirmation`, `CmdIndirect`) | a MessageBox "Import": "Some targets already exist." with Overwrite / Merge / Insert / Cancel; Cancel (a `Mouse` click) answered `User Canceled Command(Import aborted per user request)` and type 14 was unchanged |

## Fixed in bridge 0.41.0

`patch.import` sends `Import <no> /File "<file>" /Path "<the library's folder>"`. The folder comes from
`GetPath(Enums.PathType.<library>)`, the same one `patch.library` lists. `<no>` is the number after the highest type
in the copy, and there is no `/NoConfirmation`: a taken number would open the overwrite question instead of
overwriting. A folder with a quote or a control character is refused. `patch.importState` reports an open dialog
(`modal`), and the server fails `wait_import` at once when one is open and no type was added. The server recognises
the console's answer by the command the bridge reports, and by `Import Library "<file>"` for older bridges.

## Proof on 0.41.0

onPC had been closed and relaunched on mcp-test-disposable (6 types). Bridge 0.41.0 was loaded with the show's reload
macro (stop, delete, `Import Plugin Library`, start), which left the listing holding the plugin library (25 entries,
destination `Plugin`). Then, through `gma3_patch_import` with server build a926d9c:

| # | File | Command sent | Result |
| --- | --- | --- | --- |
| 1 | `generic@fan.pxml` | `Import 7 /File … /Path "…/lib_fixture_types/grandma2"` | type 7 "Fan", committed, read-back matched |
| 2 | `SHEHDS@180W_Beam@2026-10-20.gdtf` (user) | `Import 8 /File … /Path "…/gma3_library/fixturetypes"` | type 8 "180W Beam" (15 Channel), committed, read-back matched, 1 attribute added |
| 3 | `SHEHDS@180W_Beam@2026-10-22.gdtf` (user, `allow_duplicate`) | `Import 9 …` | type 9 "180W Beam", committed; the read-back reported a mismatch because it matched type 8 by the shared GUID (the server's read-back by GUID, fixed by #87, not in this build) |
| 4 | `generic@fan.pxml` (`allow_duplicate`) | `Import 10 …` | type 10 "Fan", committed, read-back matched |

So a user-library `.gdtf` imports after a grandMA2 `.pxml`, and the reverse. The show was not saved.

## Left open

- The same-GUID GDTF case of #87 (patch a fixture on the 10-22 type, remove the old type) still needs #87's server
  and this bridge together.
- `Import /File /Path` names the folder, so a file name in two libraries could now be imported unambiguously. The
  `ambiguous-file` refusal (bridge and server) is kept for now.
