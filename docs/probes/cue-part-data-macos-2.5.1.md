# Cue part data probe: stored values, preset references, phasers and deleted presets (macOS, onPC 2.5.1)

Evidence for `gma3_cue_contents` `storedValues`, `gma3_preset_usage` and `gma3_cue_diff`
(`src/tools/storedvalues.ts`, `src/tools/analysis.ts`).

- **Date:** 2026-11-14
- **Platform:** macOS, grandMA3 onPC 2.5.1.1, bridge 0.51.0 (Lua off), server built from `forked-main` (uncommitted)
- **Show:** a production show (fixtures already patched), user profile "NEON - LIGHT MAIN DESK". Test objects on free
  numbers, checked free first with `gma3_pool_usage` and deleted afterwards; the show was not saved. Pool counts
  after cleanup equal the counts before (418 sequences, 13 presets in pool 4, 6 in pool 21).
- **Objects:** Preset 4.9701 "MCPTEST Red" (R 100 G 0 B 0, selective, 101 + 102), Preset 21.9701 "MCPTEST Chase"
  (Dimmer phaser 100 / 20 on 102, 60 BPM), Sequence 9701 Cue 1 "MCPTEST". Fixtures 101 and 102 (Robin Painte).

## Reading a production cue (read-only)

`gma3_cue_contents` on Sequence 1 Cue 1 (a recipe cue: Group "DIM EXEC SPOT" x Preset 1.1 "FULL") returned 12 rows
`Dimmer 100, preset "Preset 1.1 FULL", cooked: true`, one per member: cooked output carries the preset reference.

## Programmer, store, read-back

Programmer before the store (`gma3_programmer`): 101 Dimmer 70 and Zoom 40 (hard), 101 + 102 R/G/B linked to
4.9701, 102 Dimmer two steps 100 / 20 linked to 21.9701.

1. `Store Sequence 9701 Cue 1 /NoConfirmation` with **only 102 selected** (the last tool call had selected it):
   the cue held only 102's 4 values. Afterwards 102's programmer values read `activeValue 0` (stored, deactivated)
   and 101's still `activeValue 2`. That is the profile's store preference, as intended by the operator:
   `preset.context` reads `ChannelFilter: "Active For Selected"` (also `CueOnly: "On"`, `StoreMode: "Ask"`), and
   `gma3_store_cue` sends no `/Active` or channel-filter option, so the preference decides. At the time the store
   tool reported success without saying what was stored. It now reads the part back and compares it with what the
   preference takes (`src/tools/storeverify.ts`; its result's `storedValues` names the preference).
2. With 101 selected, `Store ... /Merge`: the cue then held all 9 values (102 from the first store, 101 from this one) and they match the programmer exactly:
   101 Dimmer 70 and Zoom 40 with no preset, R/G/B 100/0/0 with `Preset 4.9701`, 102 Dimmer `steps 2, [100, 20]`
   with `Preset 21.9701`.

So `preset.read` on a cue part (GetPresetData) returns hard values, preset references and phaser steps as stored.
Side finding: `gma3_programmer` showed 101 Zoom (set hard, `Attribute "Zoom" At Absolute Percent 40`) with
`absPreset` "ROOTS RAID" (a preset of the show); the stored cue value has no reference. The programmer read's
`absPreset` is not reliable for a hard value.

## Deleting a referenced preset

`Delete Preset 4.9701 /NoConfirmation`, then `gma3_cue_contents` with `fixtures: "101"`: the R/G/B rows are still
there (100 / 0 / 0) **without any preset reference**. The console turns the values into plain values; no invalid
handle remains in the cue data, and `gma3_preset_usage {dangling: true}` correctly found none. A deleted preset
therefore does not leave a dangling reference in cue data (unlike a preset embedded in a preset, SB-03).

## Not covered

Relative values, fade/delay per value, cue parts other than 0, a part over 5000 values, tracking and Break/Release
texts (only `break: "#FFFFFFFFFFFFFFFF"` was seen, on cues without a Break set).
