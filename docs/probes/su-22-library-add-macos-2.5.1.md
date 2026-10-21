# SU-22 probe: a GDTF sent into the user library and imported (macOS, onPC 2.5.1)

Evidence for [SU-22 in SETUP.md](../../SETUP.md#su-22--add-a-fixture-type-file-to-the-user-library).

- **Date:** 2026-10-20
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, bridge 0.38.0
- **Show:** `test-fixture-disposable`, chosen by the user for this run (never saved). The live test checked the loaded
  show and the bridge version before every write.
- **File:** `SHEHDS@180W_Beam@2026-10-20.gdtf` from bdstark/gma3-fixtures (GDTF 1.2, 93 698 bytes, CRC-32 `ef9eae94`,
  16 zip entries: `description.xml` and 15 gobo PNGs). It has one 15-channel mode, a 12-slot colour wheel with CIE
  colours, a 15-slot gobo wheel with images, a prism and a reset channel defaulting to 0.
- **Method:** `test/live/library-add.live.ts` (`GMA3_LIVE=1 GMA3_LIVE_EXCLUSIVE=1 GMA3_LIVE_GDTF=<file>`), which calls
  the tools in-process against the bridge. It sends the file with `gma3_patch_library_add` (`content_base64`), imports
  it with `gma3_patch_import`, reads it with `gma3_patch_type_structure` and removes it with
  `gma3_patch_remove_type`. At the end it deletes the file from the user library folder. The bridge's `lua` op was
  used only to read objects while diagnosing (below). Bridge updates went through Macro 950 (`cmd` and `set`; the
  docs/setup/bridge.md sequence), which was deleted afterwards.
- **Report:** [su-22-library-add-macos-2.5.1.json](su-22-library-add-macos-2.5.1.json) (the final run, trimmed).

## The upload

| Step | Result |
| --- | --- |
| `check_content` | zip read on the server; `description.xml` names "180W Beam" by SHEHDS, mode "15 Channel", DataVersion 1.2 |
| `check_library` (`patch.libraryStat`) | not in any library |
| `write` (`patch.libraryAdd`) | 2 chunks (48 KiB of raw bytes each, 64 KiB of base64), then moved into place: `~/MALightingTechnology/gma3_library/fixturetypes/SHEHDS@180W_Beam@2026-10-20.gdtf` |
| `read_back` | size 93 698 and CRC-32 `ef9eae94` on the console, as sent; `patch.library` lists it under source `user` |
| the same file again | refused before writing: "already in the user library (93698 bytes, CRC-32 ef9eae94, the same bytes); pass replace: true" |

`DirList` over the user library lists the new file at once. No library cache had to be refreshed (`fixture_cache.dat`
in the same folder was left alone), and `Import Library "<file>"` finds it by name.

## The import

`gma3_patch_import { file, source: "user", exclusive: true }`: `Import Library "SHEHDS@180W_Beam@2026-10-20.gdtf"`
answered `OK` on the next frame and appended exactly one type, claimed by its manufacturer (the file name's model
`180W_Beam` is not the type's name `180W Beam`). Committed and read back by GUID (`1A B1 B0 DA ...`), source `User`.
The first import added 1 attribute (later imports 0: the console keeps it after a removal).

`gma3_patch_type_structure` on the imported type:

| Check | Result |
| --- | --- |
| Modes | one, "15 Channel": footprint 15, 1 break, 15 addresses used |
| Channels | Pan and Tilt 16-bit (1/2, 3/4), PositionMSpeed 5, Dimmer 6, Shutter1 7, Color1 8, Gobo1 9, Prism1 10, Focus1 11, Frost1 12, Control1 13, Control2 14, FixtureGlobalReset 15 |
| Reset | `FixtureGlobalReset` default `<000000>` (the grandMA2-library type had no attribute below 241) |
| PositionMSpeed | default `<000000>` (fast; the grandMA2-library type defaulted to 255, slowest) |
| Colour wheel | 12 slots, all with colours (`slotColors: set`), each selected by a Color1 channel set |
| Gobo wheel | 15 slots, each with its image (`USERGOBO/SHEHDS180W_G1_01_Open.png` ... `_15_Daisy.png`), each selected by a channel set |
| Prism | 1 slot ("18 Facet") |
| Limitations | none |

The GDTF's images are imported as `USERGOBO/<MediaFileName>.png`.

## Two findings, fixed in bridge 0.38.0

**The isolation check refused the first import (DmxCurves).** After the GDTF import, the copy's `DmxCurves` differed
from the live patch while everything else matched. The console's default curve, `DmxCurve 1`, has two points (Min
0 → 0, Max FFFFFF → FFFFFF; its `COUNT` reads 2), but `Children()` returns only one. In the live patch that was
"Max"; in the copy after the GDTF import it was "Min" (with IgnoreNetwork Yes, as in any copy). With the user's
approval the open copy was committed with `patch.commit`. Then three untouched copies were opened and closed:

| Copy | Live lists | Copy lists | DmxCurves |
| --- | --- | --- | --- |
| 1 (right after the committed GDTF import) | Min #1 | Max #4 | differs |
| 2 | Max #4 | Max #2 | equal |
| 3 | Max #2 | Max #5 | equal |

So which point the curve lists flips with a GDTF import and back with the next copy, and the point's number changes
with every copy (as KB-25 found). The grandMA2 imports of SU-03 did not flip it. The fingerprint now leaves out only
the first curve's Min (000000 -> 000000) and Max (FFFFFF -> FFFFFF) points with exactly those values; other curves'
points, an edited end point and the curves themselves are still hashed (`test/lua/patch_ops_test.lua`; narrowed after
the review of PR #84, which pointed out that leaving every point out would miss an edit to a custom curve). With that bridge, `gma3_patch_remove_type` of the committed type and the next import
passed the isolation check.

**Six colour-wheel slots read as no colour.** `gma3_patch_type_structure` reported `slotColors: unreadable`, with
Indigo, Magenta, Lime, Yellow, Amber and Red missing a colour. The `object` op showed that the console has all
twelve: a CIE colour outside sRGB converts with a slightly negative component, e.g. Red
`0.9999432564,-0.0000825030,-0.0000241920,1.0000000000` and Indigo `0.0733022690,-0.0000113584,1.0001984835,...`.
The bridge's slot-colour pattern (SU-19) accepted no minus sign. It does now (`test/lua/type_structure_test.lua`),
and the final run reads all twelve.

## Verified

User-library `.gdtf` imports are marked verified (`LIB_SOURCES` takes a table by extension): `gma3_patch_library`
reports `verified: true` for them and `gma3_patch_import` gives no warning. User-library `.xml` and WorldServer files
stay unverified; no such file was tried.

## Clean-up

The imported type was removed with `gma3_patch_remove_type` (by GUID, read back gone) after each run, the uploaded
file was deleted from the user library folder, and Macro 950 was deleted. The show's types afterwards were the four
it had before. The attribute the first import added stays in the show (the console keeps it).
