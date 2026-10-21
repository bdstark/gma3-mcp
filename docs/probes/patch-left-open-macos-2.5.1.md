# The patch copy left open after a GDTF import (bridge 0.38.1)

- **Date:** 2026-10-21
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, bridge 0.38.0, then 0.38.1
- **Show:** throwaway-q60-check (new, disposable)
- **File:** `Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf` in the user library (gma3-fixtures)

## What happened on 0.38.0

1. `gma3_patch_import` of the file: the console imported "Sentinel Spot Q60 ILS" by "Chauvet DJ" with both modes, but
   `wait_import` did not claim it: the claim compared the names exactly with the file's `Sentinel_Spot_Q60_ILS` and
   `Chauvet_DJ`. The copy was left open, and the summary sent the operator to Menu › Patch.
2. The operator opened Menu › Patch: a pop-up "Already in edit patch! Command line is inside of the edit patch!", no
   Patch window, no Save or Discard. The session had entered the copy from the command line
   (`ChangeDestination "ShowData"."Patch"`), not through the menu.
3. The operator typed `ChangeDestination Root`: no question, the copy was committed (the type was live, 347
   attributes).
4. `gma3_patch_add` of FID 1 at 1.001: the add worked in the copy, then the isolation check failed on
   FixtureTypes. A property diff of copy and live (every property outside the fingerprint's skip list) found exactly
   one difference: the type's `ORIGINALFILENAME`, `Chauvet_DJ@Sentinel_Spot_Q60_ILS@2026-10-21.gdtf` live and empty
   in the copy. The copy was left open again; committing it (`ChangeDestination Root`) emptied the property live too.

So the first patch session after any import that sets `ORIGINALFILENAME` failed, and every failure sent the operator
to a Patch menu that cannot open.

## Fixed in bridge 0.38.1

- The fingerprint leaves out `ORIGINALFILENAME`.
- `inShow` (bridge) and the import claim (server) compare names ignoring case, underscores and repeated spaces.
- A copy left open (and a copy found open before a session) is explained as it is: the command line is inside the
  edit patch, no Patch window is open, `ChangeDestination Root` keeps the copy, and no way to discard it without the
  Patch menu is known. The menu's own Save and Exit / Discard and Exit is named only for when the menu is open.

## Proof on 0.38.1

The bridge was updated in slot 1 with a throwaway macro (stop, delete, import, `ReloadAllPlugins`, start; Lua off
afterwards), then:

| Step | Result |
| --- | --- |
| `gma3_patch_remove` FID 1, `gma3_patch_remove_type` the Q60 | both succeeded, read-back matched |
| `test/live/gdtf-patch.live.ts` with the file: import, `inShow` finds the type, `gma3_patch_add` FID 995 from 3.001, clean-up | 1/1 passed |
| This branch's `gma3_patch_import` of the file | succeeded, claimed, read-back matched; the live type's `ORIGINALFILENAME` is the file name |
| This branch's `gma3_patch_add` FID 1 at 1.001, 15 Channel, right after | succeeded, isolation check passed, read-back matched |

## Still open

- Discarding a copy the command line is in, without the Patch menu (KB-25).
- Whether a copy entered from the command line can be handed to the Patch menu so its exit dialog appears.
