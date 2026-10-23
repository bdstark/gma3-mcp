---
name: gma3-show-build
description: Build a grandMA3 show on the MA Show Start (onPC) through gma3-mcp, in the order that worked. Covers the preflight (server build, bridge version, universe budget, Art-Net network card), plan files run by subagents, fixture types and the GDTF beam check, patch, Show Start parenting, 3D placement, slot groups, the Position Wizard, a hazed 3D beam check and Art-Net output. Use when asked to build or set up a whole show on grandMA3, especially from the MA Show Start, or to patch and lay out a full rig in a new show. Not for a single import or a one-off patch change.
---

# Build a show on the MA Show Start through gma3-mcp

This is the order and the checks for building a show on the MA Show Start in grandMA3 onPC with the gma3-mcp tools. It
comes from the Halloween 2026 build: onPC 2.5.1 on macOS, 93 fixtures of 13 types on 6 universes, and Art-Net on its own
subnet. Patch, groups and 3D placement went fast once they ran from plan files. Most of the lost time came from things
the agent did not know at the start. Each one is a check below, and the timeline at the end shows where the time went.

Apply the Show Start conventions and the default steps without being asked. During the Halloween build the user had to
ask for 3D placement, for haze in the beam check, for the universe budget and for the Show Start parenting.

## Rules for the whole build

- **Use the structured tools.** Use `gma3_command` and `gma3_lua` only for what no tool covers. Lua is off by default,
  and only the operator turns it on. Before you fall back to Lua, check the server's tool list: newer builds may have
  a tool for the gap, such as a fixture move or a dialog tool.
- **Check the show before every write.** The user may load another show mid-session. Read the show file from
  `gma3_status` before each step. If the bridge restarted, a show may have been loaded.
- **Check the bridge before every step.** onPC can quit without a crash report. In the Halloween build nobody noticed
  for two hours. `gma3_status` gives the restart hint, `Plugin "gma3_mcp_bridge"`.
- **Save after every step.** Use `gma3_save_show {exclusive: true}` under the show's name. The Halloween build saved 12
  times, and each save checked that the file was newer.
- **Keep raw Lua out of the patch copy while the user may be in the Patch menu.** The structured patch tools check
  that no copy is open, but a raw `ChangeDestination` or `Import` lands in the copy the user has open. In the Halloween build an import went into the user's
  unsaved copy, next to a type the agent had not added. Before raw patch work, ask the user to close the Patch menu.
  Then check that the command line's destination is Root and that no modal is open. Leaving the copy with
  `ChangeDestination Root` commits it. There is no discard without the menu.
- **Ask before Art-Net output goes on.** Output drives real fixtures. Configure it with output off, and turn output on
  only when the user says so.
- **Ask before running a Show Start macro that overwrites,** such as the Position Wizard.
- **Keep queries narrow.** Broad `gma3_patch_library` queries such as `"adj"` returned 95 to 145 KB. Query by the
  file name or the type name, and use `compact: true` where the server has it (gma3-mcp #87).

## 0. Preflight

Do this before any change. It takes about five minutes.

1. **Server build and bridge version.** From `gma3_status`, read `server.build.state`, the commit in
   `server.build.stamp.commit` and `bridge.version`. The state `current` only means that the build matches the checkout it was built from. It does not
   mean that the checkout is up to date. Compare both with gma3-mcp main:

   ```bash
   git ls-remote https://github.com/bdstark/gma3-mcp.git refs/heads/main
   ```

   For the bridge, compare with `VERSION` in `plugin/gma3_mcp_bridge.lua` on main. If either one is behind, tell the
   user what is missing and ask before updating. To update, pull and run `npm run build` in the server's checkout and
   restart the MCP client. Then reinstall the bridge as described in
   [docs/setup/bridge.md](../../setup/bridge.md#update-an-existing-plugin). After a bridge update, Lua is off again.

   *Halloween:* the server ran a926d9c, which showed as `current`. It was seven commits behind main and missed three
   merged fixes: `gma3_patch_library_add` (#84), the import claim for underscored names (#85) and the stale import
   `/Path` (#86). GDTF import stretched over about 70 minutes of wall clock, including other work and waiting for
   the user. It needed raw Lua in the patch copy and an import by hand.
2. **The show.** Confirm that the loaded show is the Show Start show meant for this rig. Save it under the new name
   before the first change.
3. **The universe budget.** Count the channels from the plan, and fit the universes to the onPC limit before
   patching. In the Halloween build the user gave the limit as 4096 channels, which is 8 universes. Confirm the figure
   for the user's licence and hardware. The Show Start show began with 6 universes granted. `gma3_dmx_output` shows
   used, wanting output and granted universes. On onPC the grant comes from connected MA hardware, such as the dongle.

   *Halloween:* the first patch used one universe per data line. That made 11 universes for about 1,050 channels, so
   84 fixtures had to be re-addressed into 6 universes afterwards.
4. **The Art-Net network.** Ask how many data lines and nodes there are, and which node ports carry which universe.
   Then find the network card for the lighting subnet with `ifconfig`. The Art-Net `PreferredIP` must match that
   subnet. Read it with `gma3_get_object` on `Root.DeviceConfigurations.DMXProtocols.ArtNet`, and set it with
   `gma3_set_property` on the same object. `Root.DMXProtocols.ArtNet` does not exist. `gma3_configure_dmx_output`
   cannot set the interface. The interface it reports, such as `"5.1"`, does not name the card.

   *Halloween:* `PreferredIP` was the default `10.0.0.0/8`, and the Mac had no address on the show's /24. The user
   added a VLAN on the wired card with an address in that subnet, and `PreferredIP` was set to the subnet.
5. **The fixture types.** List every type the rig needs. For each one, note whether it is in the MA library (`.pxml`)
   or is a GDTF for the user library. Run the GDTF beam check from section 2 on every GDTF now, before anything is
   imported.

## 1. Plan files first

Write the plan as files in the show's project folder, have the user review them, and then let subagents run each file
through the structured tools. This was the fastest part of the Halloween build. Subagents patched 89 fixtures in 7
minutes, stored 68 groups in 5 and placed 93 fixtures in 76 seconds.

| File | Shape | Runs through |
| --- | --- | --- |
| Fixture schedule (CSV) | unit, floor, position, maker, fixture, x and y from a datum, height, mount, focus, data line, notes | the source for the other files; a published plot helps the review |
| Patch plan (CSV) | `fid,name,unit,fixture_type,mode,footprint,ma_universe,artnet_universe,address,patch,line,note` | `gma3_patch_add` in blocks (FID, count, type, mode, address), then one `gma3_patch_set` for the names |
| Groups plan (JSON) | `[{group, name, items: [{fixture, x, y}], overwrite: true}]` | `gma3_store_group` in batches of about 8, with `detail: false` |
| 3D placements (JSON) | `[{fid, position: {x, y, z}, rotation: {x, y, z}}]` | one `gma3_place_fixtures` call; save the returned `restore` list next to the plan |

- **FIDs.** Show Start owns FIDs 1 to 8. Start the rig at 101. Use the hundreds for areas and the tens for fixture
  kinds. In the Halloween build, 1xx was the main floor, 2xx the basement, 3xx the Hue lights (300 plus the unit number, so H04
  was 304) and 4xx the deck.
- **Universes.** Put the patch inside the budget from the preflight. Lines may share a universe. In the Halloween
  build, lines L1, L3 and L4 shared one universe, and so did L5 with L7 and L6 with L8.
- **The subagent brief.** One subagent per file, using only the named structured tools, with `exclusive: true`. Make
  one call at a time, use no `gma3_lua` or `gma3_command`, skip rows marked as waiting for a type, and report briefly.
  Large results land in saved files, so tell the subagent to read the counts from those files. The main thread then
  checks the counts with `gma3_patch_list`, `gma3_objects` or `gma3_fixture_positions`.

## 2. Fixture types

- **MA library types.** Import with `gma3_patch_import {exclusive: true, verify: true}`. A subagent imported 11
  types in 3 minutes.
- **GDTF files.** Copy each file into the user library with `gma3_patch_library_add`, then import it with
  `gma3_patch_import` from source `user`.
- **The beam check, before import.** The 3D view draws the beam from the physical value. A shutter or dimmer "Open"
  set at physical 0 draws as closed, so the fixture shows no beam even though real output is fine. Run
  `check_gdtf_open.py` from this skill's folder on each file:

  ```bash
  python3 -I <skill folder>/check_gdtf_open.py FILE.gdtf
  ```

  It flags `NO BEAM` for an open set at physical 0. It flags `FAINT` for a closed set above physical 0. Fix the GDTF
  at its source and rebuild it before the first import. In a gma3-fixtures `fixture.json`, give the "Open" function
  `"physical": [1, 1]`, which becomes its `PhysicalFrom` and `PhysicalTo`. The console's tools do not show physical
  ranges.

  *Halloween:* the SHEHDS 180W Beam had `Shutter1` "Open" at DMX 0 to 1, which is physical 0 at DMX 0. Its beams
  never showed in 3D. The check also flags the Sentinel Spot Q60. Its default, DMX 4, is open, so its beam showed.
  Its second "Open" function at DMX 216 would draw closed.
- **A fixed GDTF after the first import costs time.** Re-import it with `allow_duplicate`, then move the fixtures
  across with `gma3_assign_cell_layout {fixtures, type}`, used as a retype. It keeps FIDs, groups and presets. On
  builds before gma3-mcp #87, the import read-back can pick the older type because both share a GUID, and
  `gma3_patch_remove_type` refuses to remove the unused old type. The Halloween build had to delete it in the Patch
  menu. The beam check avoids all of this.
- **Removing a type renumbers the types after it.** After a re-import both types have the same name, so use the
  type number and list the types again after each removal.

## 3. Patch

1. Run the patch plan through a subagent, as in section 1. Read back with `gma3_patch_list`.
2. Rename the grouping fixtures at FIDs 1 to 8 to the slot names with `gma3_patch_set`. Leave the rig at the top level
   for now: section 8 moves it under them, after the 3D work.
3. Save.

## 4. 3D placement, right after the patch

Place fixtures without being asked. A patched show with every fixture at the origin is not finished. Place them while
they are still at the top level of the patch: `gma3_place_fixtures` refuses a fixture inside a grouping fixture.

- Run the placements file through `gma3_place_fixtures` and keep its `restore` list, because positions have no undo.
  Test-place one fixture with an unusual rotation first.
- Rotations confirmed on onPC 2.5.1: rotation 0 hangs the fixture with the beam along −Z. A floor uplight is X 180.
  Facing downstage is X −90. A vertical bar facing downstage is X −90 with Y 90. See
  [positions.md](../../tools/positions.md) for the axes.
- For strings and pixel strands, lay out the cells with `gma3_layout_cells` before the groups use them.
- The Show Start helper "Moving Head" has no FID, CID 1. It holds the universal LOS presets 2.19 and 2.20 and sits at
  the origin, below the floor. `gma3_place_fixtures` needs an FID, so leave the helper where it is. The eight
  grouping fixtures also sit at the origin, where their labels overlap. Tell the user rather than working around it.
- Save.

## 5. Slot groups

Each Show Start slot N has a group in each of these ranges. Fill them for every slot in use, with `overwrite: true`
(without it the tool refuses existing groups):

| Kind | Groups |
| --- | --- |
| Grid | 1–8 |
| Linear | 19–26 |
| Even | 37–44 |
| Odd | 55–62 |
| 1/3 | 73–80 |
| 2/3 | 91–98 |
| 3/3 | 109–116 |

- Renaming them is safe, because Show Start macros hold groups by handle.
- Area groups go elsewhere. In the Halloween build, 201 was all Hue lights, 211 Main Floor All and 212 Basement All.
- Builds before gma3-mcp #87 report every one-fixture group as a recall mismatch ("read 0/0/0"), because the
  console recalls a lone fixture at the grid cursor. Check the stored cells with `gma3_selection_grid` instead.
- Save.

## 6. Position Wizard (macro 5002)

Run it after placement and the slot groups, and ask the user first. It overwrites Position presets 2.2 to 2.10, merging
Straight, Fan In and Fan Out, Cross, the four Up versions and Blind for every slot with pan and tilt.

- `gma3_run_macro 5002` stops at a Lua `Confirm()`, "Are you sure you want to overwrite positions?", and reports
  `paused_at_go`. Use a dialog tool if the server has one. Otherwise ask the user to press OK. The Halloween build
  pressed it from Lua by walking `GetTopModal()`.
- Audit the result with `gma3_preset`. In the Halloween build, 2.1 Center was empty, the scanners' tilt was clamped to
  0%, Up Cross was a copy of Up Fan In, and Blind was uneven.
- Fix the presets with `gma3_store_preset` looks. Pan and Tilt activate together, so restate Pan when you fix Tilt.
- Save.

## 7. 3D beam check with haze

Do this without being asked. The narrow beams (2.5°) of the Halloween build's movers did not show without haze.

1. **Turn haze on.** Show Start keeps its render qualities in `ShowData.UserProfiles.Default.RenderQualities`. They
   are locked, with haze off. The 3D window uses one of them by handle (`View3DSettings.RenderQuality`). In the
   Halloween build it was "Gobo Animated". On builds before gma3-mcp #87, `gma3_set_property` on a locked object
   returns the unchanged value with no error. Use three command lines:
   `Unlock RenderQuality "Gobo Animated"`, then
   `Set RenderQuality "Gobo Animated" Property "HazeEnabled" "Yes"`, then
   `Lock RenderQuality "Gobo Animated"`.
2. **Bring up each slot.** Bring each slot up open and white with `gma3_set_attributes`, and ask the user to look at
   the 3D view.
3. **If one type shows no beam,** run the beam check on its GDTF. To test on the console, set its shutter to a DMX
   value inside its "Open" range above the start (DMX 1 for the SHEHDS beam) with `unit: "decimal8"`. If the beam
   appears, it is the
   physical-0 problem from section 2.
4. **Clear the programmer afterwards.** The Halloween build left test values in the programmer.

## 8. Show Start parenting

Do this after the 3D work. `gma3_place_fixtures` refuses a fixture inside a grouping fixture, so place every fixture,
and fix any pose the beam check showed, before the move. The Halloween build moved the rig last, and the poses
survived.

Show Start has eight grouping fixtures at FIDs 1 to 8, named "MA StartShow 1" to "MA StartShow 8" until section 3
renames them. Each slot's rig fixtures belong under the slot's grouping fixture. Show Start's cues and layouts reach
the rig through the slot groups, so this orders the patch sheet rather than making the show work, but the user
expects it. In the Halloween build the grouping fixtures were named Movers, Scanners, Main Wash, Bsmt Wash, Pixel
Bars, Specials, Nanoleaf and Deck. Fixtures outside any slot stay at the top level.

- If the server has a fixture-move tool, do this without being asked.
- Without one, it takes Lua inside the patch copy. Put the move in the plan the user reviews, and run it once the
  user has turned Lua on and closed the Patch menu. The Halloween build moved the fixtures one slot at a time:
  `Cut <indices>`, `ChangeDestination <grouping index>`, `Paste 1`. Paste opens a "Move Fixtures" dialog
  (Absolute, Relative, Cancel), which was answered with Absolute. Then `ChangeDestination Root`. Groups, presets,
  addresses and 3D positions survived. Try it on one scratch fixture first, and only with the Patch menu closed.
- Read a few poses with `gma3_fixture_positions` before and after the move, and compare them.
- Save.

## 9. Universes and Art-Net

1. If the patch went over the budget, re-address it in one `gma3_patch_set` batch. 84 edits took 82 seconds. It is
   better to plan inside the budget.
2. Configure the output with output off, previewing first:

   ```json
   {"protocol": "artnet", "entries": [{"entry": 1, "local_universe": 1, "amount": 6, "universe": 0,
     "mode": "Auto", "enabled": true}], "output": false, "exclusive": true, "preview": true}
   ```

   Then run it again without `preview`. MA universe 1 is Art-Net universe 0.
3. Check the grants with `gma3_dmx_output`. All universes that want output must be granted.
4. **Only when the user says so,** turn output on with
   `{"protocol": "artnet", "output": true, "network": true, "exclusive": true}`. If a host on the subnet can capture,
   confirm the packets on the wire.
5. Save.

## 10. Hand-over

Clear the programmer and save. Then write a note in the show's project folder with:
- what is still open on the show and on the rig, such as node ports, fixture modes and addresses to set;
- every place a tool fell short, with the evidence and a suggested fix, for gma3-mcp.

## Halloween 2026 timeline

Durations on 2026-10-22/23, from the first `gma3_status` to Art-Net output. The GDTF import span overlaps other work
and about half an hour of waiting for the user.

| Phase | Time | Notes |
| --- | --- | --- |
| Preflight | 1.5 min | missed the stale build, the budget and the network card |
| MA library imports (subagent) | 3 min | 11 types |
| GDTF import | about 70 min wall clock | stale server; Lua in the patch copy; the user's open Patch menu; import by hand |
| Patch (subagent) | 7.6 min | 89 fixtures from the patch plan |
| Cell layouts and groups (subagent) | 8 min | 68 groups; 4 false mismatches on one-fixture groups |
| Position Wizard and preset fixes | 8 min | Confirm pressed from Lua; four presets fixed |
| 3D placement (subagent) | 3 min | 93 fixtures; done only after the user asked |
| 3D check, haze, GDTF fix | 18 min | locked render quality; shutter at physical 0; re-import and retype |
| Re-address to 6 universes, Art-Net set up | 4 min | after the user raised the onPC limit |
| Move rig under grouping fixtures | 6 min | after the user asked; Lua Cut and Paste |
| Bridge down after onPC quit | 2 h unnoticed | |
| Rename grouping fixtures, Art-Net on | 11 min | output on after the user attached the dongle |
