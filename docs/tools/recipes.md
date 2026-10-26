# Recipes and cooking (SB-05)

Four tools combine groups, presets and MAtricks into programming that adapts to a changed rig:
- `gma3_recipes` reads the recipe lines of a preset or cue part and what the target holds;
- `gma3_edit_recipe` adds, changes, moves or removes one line;
- `gma3_store_recipe_cues` writes the lines of many cue parts in one call (a recipe-driven show build, #101);
- `gma3_cook_recipes` cooks a preset, a cue part, a cue or a whole sequence with an explicit option, after listing
  every affected target.

Recipe definitions are read and written with the existing object ops (`children`, `objects`, `set`) and `Assign` /
`Move` / `Delete` / `Cook` commands. The cooked state of a target comes from `preset.read`, which bridge **0.24.0**
extends to cue parts (see [the bridge protocol](../reference.md#cue-part-data-plugin-v0240-sb-05)). Evidence:
[the SB-05 probe record](../probes/sb-05-recipes-macos-2.5.1.md).

| Tool | Changes | Programmer |
| --- | --- | --- |
| `gma3_recipes` | nothing (read-only) | untouched |
| `gma3_edit_recipe` | one recipe line of a preset or cue part; **the console cooks the edited line at once** | untouched |
| `gma3_store_recipe_cues` | the recipe lines of up to 100 cue parts of one sequence, their cue names and notes; each written line is cooked at once, as above | untouched |
| `gma3_cook_recipes` | the cooked (and, with merge or overwrite, the uncooked) data of the affected targets | untouched |

## The things to know first

- **A recipe line** is a child of a cue part or a preset (class StandardRecipe; phaser lines are PhaserRecipe). It
  has a selection (usually a group), values (usually a preset), optional MAtricks and filter, Enabled, SelectionMode
  and timing columns. It is addressed as `Sequence S Cue C Part P.L` or `Preset Pool.N.L`.
- **The console cooks by itself.**
  - An `Assign` or property write on a line cooks that line into its target at once (merge low priority).
  - Disabling a line removes its output, and deleting a line re-cooks the rest.
  - **A change of an ingredient (group membership, preset content) is re-cooked into the dependent targets a moment
    later**, in the background: an immediate read still shows the old coverage, and 3 s later it is updated.

  Editing a definition and cooking its output cannot be kept apart on the console. The edit tool therefore reports
  the coverage before and after (`autoCooked`), and the cook tool gives an immediate, verified cook with the option of
  your choice.
- **Cook options and uncooked data** (values stored directly in the same cue or preset):

  | Option | Cooked data | Uncooked data on other fixtures/attributes | Uncooked data on the recipe's own fixture and attribute |
  | --- | --- | --- | --- |
  | `merge_low_priority` | replaced by the recipes' output | kept | **kept** (the recipe does not override it) |
  | `merge` | replaced | kept | **replaced** by the cooked value |
  | `overwrite` | replaced | **deleted** | **deleted** |
  | `remove` | removed | kept | kept |

  A cook without an option opens a pop-up on the console; the tools always send one.
- **Dangling references stay as empty fields.** A deleted group or preset leaves the line with an empty selection or
  values; an empty group cooks nothing. `gma3_recipes` lists these as `problems`.
- The cooked output can include the rest of an activation group: a red preset with R, G, B also cooks W, RY and UV of
  an RGBW fixture.

## First-release capabilities

| Capability | Supported |
| --- | --- |
| Standard lines: group selection, preset values, MAtricks reference, Enabled, Name, SelectionMode | read, add, set, move, remove; coverage predicted and verified |
| Per-line MAtricks columns (XWings, XBlock, XGroup, XWidth, XShift, XShuffle, X, FadeFromX / FadeToX, DelayFromX / DelayToX, PhaseFromX / PhaseToX, SpeedFromX / SpeedToX, and the Y and Z ones) | written by `gma3_store_recipe_cues` and read back there; **not verified on a console** (see below); not edited by `gma3_edit_recipe` |
| Standard lines with a filter or world, SelectionFromValue | read and kept; not edited; coverage not predicted (named in the result; a merge treats what they reach as possibly replaced) |
| Phaser recipe lines (PhaserRecipe), shapes | read and kept; not created or edited; coverage not predicted (likewise) |
| Targets | presets and cue parts (edit, read); a preset, cue part, cue or whole sequence (cook) |
| Nested recipe presets (a line's preset embeds others) | noted; their own recipes are not re-cooked by this cook |

## `gma3_recipes`

`{target: {preset: "N.M"} | {sequence, cue, part?}}` (part 0 by default). Returns:

- every line (standard and phaser) with:
  - `selection` (group and its `members`), `values` (`preset` "N.M" and name), `matricks`, `filter`, `enabled`,
    `selectionMode`;
  - the console's last cooking state (`failedCookedPart`, `emptyLastCooking`);
  - `problems`: missing selection, missing or empty group, missing or empty preset, disabled;
  - `notPredicted` where coverage is not modelled;
- `coverage`: per fixture the attributes the target holds `cooked` (from recipes) and `uncooked` (stored directly);
- `expectedPairs`, the number of fixture/attribute pairs the lines should cook;
- `dependencyNotes`.

## `gma3_edit_recipe`

`{target, action, ...}`:

| action | Parameters | Commands |
| --- | --- | --- |
| `add` | `selection` (group), `values` ("N.M"), `matricks?`, `name?`, `enabled?`, `selection_mode?` (strict/normal) | `Assign Group G At <line n+1>`, (`set Enabled No` when `enabled: false`), `Assign Preset N.M At <line>`, `Assign MAtricks M At <line>`, `set` Name / SelectionMode / Enabled |
| `set` | `line` and any of the fields above; `values: null` clears the values | the same, on that line |
| `move` | `line`, `to` | `Move <line a> At <line b>`; only upward moves, which land where asked (moving down by k is k moves of the lines below it) |
| `remove` | `line` | `Delete <line> /NoConfirmation` |

Before anything is sent:
- the target and the line exist, and the line is a standard line (move and remove also take phaser lines);
- the referenced group, preset and MAtricks exist.

`enabled: false` switches a new line off before it gets values, so it never cooks.

Each `set` reply is compared for its property: Enabled by its truth value, SelectionMode, Name and Values as text (an
unchanged SelectionMode is a failure, not a match). A line list read only in part fails `read_lines` before anything is
sent, and a partial read of the target's data is named in `warnings` (the coverage and `autoCooked` are then partial).
Afterwards the lines are read back and checked:
- add and set: every requested field of the line — selection, values (by the preset's address), MAtricks, Enabled,
  Name, SelectionMode; the other lines unchanged (SelectionMode and filter included);
- move and remove: exactly the expected order.

A failed `Assign` can leave an empty line behind on 2.5.1; the line count catches it. The result carries `linesBefore`,
`linesAfter`, `coverage.before`, `coverage.after` and `autoCooked`.

`values` is the plain string `"4.2"`. A number is refused with that form in the error: as JSON numbers `4.20` and `4.2` are
the same, as presets they are preset 20 and preset 2. A string with quotes inside it (`"\"4.2\""`) is refused the same way.

## `gma3_store_recipe_cues`

`{sequence, mode: "replace" | "append", cues: [{cue, part?, name?, note?, lines: [line, ...]}], cook?, replace_uncooked?,
verify_cook?, preview?, stop_on_failure?, detail?}`. A line is `{selection, values, matricks?, name?, enabled?,
selection_mode?, x?, y?, z?}` with the fields of `gma3_edit_recipe` add. `x`, `y`, `z` are the line's own MAtricks columns:
the axis settings of [`gma3_configure_matricks`](groups.md#gma3_matricks-and-gma3_configure_matricks) (`wings`, `blocks`,
`groups`, `width`, `shift`, `shuffle`, `fade`, `delay`, `phase`, `speed`, with the same values and units) and `select`, the
X / Y / Z column itself (only the n-th element; with blocks, the n-th block). The #101 build's line options map as
`xblock: 3, x: 2, xwings: 2, xgroup: 4, fade: 16` → `x: {blocks: 3, select: 2, wings: 2, groups: 4, fade: {from: 16, to: 16}}`.

Why a new tool and not a batch form of `gma3_edit_recipe` (`edits: [...]`): a batch item of the edit tool is one line
of one target with its own reference checks, a read-back of every line and the coverage before and after, so 4,300 lines
are 4,300 items and as many full reads. A recipe cue is written as a whole (its lines replaced or appended), the same
groups and presets recur across hundreds of lines, and the build needs the per-line columns, the cue's name and note,
and a cook at the end. This tool checks the references once, writes per cue part and reads back per cue part.

1. Validated as a whole before anything is read: at most 100 cue parts (one sequence), 200 lines per part and 500 lines
   per call (each line is a few requests, so a larger build is several calls); a cue part listed twice, an unknown line
   or axis field, a `values` number and a note with a line break are refused.
2. `read_cues`, once: every cue part exists (the cues are created by `gma3_store_cues`, a part by
   `gma3_store_cue_part`) and its lines are read completely. `replace` is refused on a part that holds phaser lines
   (this tool does not write them back).
3. `check_references`, once for the whole call: every group, preset and MAtricks a line names is in the show (each read
   once, the missing ones listed with the first line that uses them). An empty group is a warning.
4. Each cue part is a batch item, in order, inside one span of the mutation lock (see
   [Batch forms](README.md#batch-forms-su-12)):
   - `replace`: `Delete <part>.<L> /NoConfirmation` for every line, from the last;
   - per line, as `gma3_edit_recipe` adds one: `Assign Group G At <line>`, `set Enabled No` (when `enabled: false`, before
     the values), `Assign Preset N.M At <line>`, `Assign MAtricks M At <line>`, `set` SelectionMode, Name, every column
     (`None` for null) and `Enabled Yes`; every `set` reply is checked (a column by the value it reads, as
     `gma3_configure_matricks` checks it);
   - the cue's name on its Part 0, and its `Note` on the cue object;
   - a read-back: the line count, every field written (the preset by its address), the columns in the display role, the
     lines that were there before unchanged (append), the name and the note (exactly). The item's line has the count and
     only the mismatches.

   A part's steps stop at its first failure; what was sent stays (nothing is undone or retried) and its summary says
   which step stopped it. Other parts go on unless `stop_on_failure: true`; a request without a reply stops the rest
   of the call.
5. `cook` (a `gma3_cook_recipes` mode), only when every part was written and matched: each part is cooked with
   `gma3_cook_recipes` (its inspection, its `replace_uncooked` refusal and, unless `verify_cook: false`, its read-back),
   one after the other. A cook that does not succeed leaves the call `partial`; the parts stay written.

`preview: true` runs steps 1–3 and returns the plan per part (lines before, deletions, lines, requests; `detail: true`
every command and write). No `exclusive`: like `gma3_edit_recipe`, nothing goes through the programmer, the selection
or Preview. Phaser recipe lines (`PhaserRecipe`, e.g. in the Show Start's phaser presets) are out of scope.

## `gma3_cook_recipes`

`{target: {preset} | {sequence, cue?, part?}, mode, replace_uncooked?, preview?, verify?}`.

1. `find_targets`: the presets or cue parts the scope reaches that hold recipe lines (a sequence: every cue part with
   lines, at most 200). For each target:
   - the lines with their members and problems;
   - the coverage before;
   - the predicted cooked coverage: each enabled standard line with a group and a preset gives the group's fixtures
     the preset's attributes, through the fixture's own selective row, the global row of its fixture type, or a
     universal row the fixture has the attribute for (the fixture types are read for each group's members);
   - with merge, the uncooked values it would replace (`replacedUncooked`); with overwrite, the uncooked values it
     would delete (`deletedUncooked`).
   - Unknown coverage never counts as safe. A line that is not predicted (filter, phaser line, SelectionFromValue)
     makes every uncooked value on its group's fixtures a possible replacement under merge, marked `(possibly: …)`;
     without a known group (SelectionFromValue, a phaser line without one), every uncooked value of the target.
   - The same holds for a prediction that rests on a failed or incomplete read: a fixture whose attribute list or
     fixture type could not be read, a values preset read only in part (its group's fixtures), and a group with
     unreadable or unread members (every uncooked value of the target). These are named in `warnings`.
2. `check_complete`: the cook is refused, whatever `replace_uncooked` says, when the inspection did not see everything
   the command reaches: more than 200 cue parts with recipes, a sequence or cue whose cues or parts could not all be
   listed, a target whose lines or data were read only in part. The reasons are listed in `incomplete`; cook a smaller
   scope. A preview still returns the plan.
3. `check_uncooked`: merge and overwrite are refused while they would replace or delete uncooked values, unless
   `replace_uncooked: true`. `preview: true` stops before this (it returns the plan either way).
4. `cook`: `Cook <scope> /MergeLowPriority | /Merge | /Overwrite | /Remove`.
5. verify (default): every target is read back; a truncated read-back is a mismatch, never a match.
   - Every predicted fixture and attribute is cooked; under merge low priority, an uncooked value on the same pair is
     accepted.
   - No cooked value is on a fixture no line selects.
   - Uncooked values are unchanged on their full content: value, relative value, steps with their layers, phaser
     speed, phase, measure and speed master, fade and delay, and preset references; a missing row is reported as
     disappeared. This holds always under merge low priority and remove, and under merge everywhere except the
     recipes' own pairs and the acknowledged possible replacements; under overwrite they may be gone.
   - Lines that are not predicted are named, and their fixtures are not reported as stray.

## What is and is not verified

- Verified live (onPC 2.5.1, `test/live/recipes.live.ts`, 1/1, 5.4 s):
  - two lines on a cue part next to an unrelated stored Dimmer value;
  - SelectionMode set to Normal and back to Strict, each verified by its reply and the read-back;
  - a group change cooked to the new members with the unrelated value kept;
  - overwrite refused;
  - lines moved and removed;
  - an empty group and a deleted preset reported;
  - a preset recipe added and cooked.
- Not verified on a console (`gma3_store_recipe_cues`, #101; no live run for this change): writing the per-line
  MAtricks columns with `set` and reading them back in the display role. The #101 build set `FadeFromX`, `FadeToX`,
  `XBlock`, `X`, `XWings` and `XGroup` on new lines from Lua and checked only the line count; the probe record lists
  "the full MAtricks property set" on a line, and MAtricks objects accept these properties and values (SB-02). How a
  column reads while a MAtricks reference supplies it (`<2>`, inherited) and whether `None` clears an override are
  not known. Cue names on Part 0 and `set` on lines are verified (SU-06, SB-05); the cue's `Note` is not.
- Not covered:
  - the background cook's exact timing (observed: not yet on an immediate read, done after 3 s);
  - phaser recipe lines;
  - filters and worlds;
  - recipe templates;
  - the programmer's Edit Recipe mode.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/recipes.live.ts` on a disposable show with an empty programmer and
bridge 0.24.0. It uses Sequence 906, Groups 910–911, Presets 23.931 and 4.931, the fixtures 401–404
(`GMA3_LIVE_RECIPE_FIXTURES`) and the presets 4.4 and 1.11 (`GMA3_LIVE_RECIPE_COLOR`, `_DIMMER`), refuses to run when
those objects exist, and deletes them at the end.
