# Recipes and cooking (SB-05)

Four tools combine groups, presets and MAtricks into programming that adapts to a changed rig:
- `gma3_recipes` reads the recipe lines of a preset or cue part and what the target holds;
- `gma3_edit_recipe` adds, changes, moves or removes one line;
- `gma3_store_recipe_cues` writes the lines of many cue parts in one call (a recipe-driven show build, #101);
- `gma3_cook_recipes` cooks a preset, a cue part, a cue or a whole sequence with an explicit option, after listing
  every affected target;
- `gma3_edit_phaser_recipe` builds phaser recipe lines (one family per line, several families in one preset) in a
  free preset slot, through the programmer's Edit Recipe mode, and edits an existing phaser preset (a line's
  settings, add or remove a line) without the programmer (bridge **0.52.1**).

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
| `gma3_edit_phaser_recipe` | create: one preset with 1-8 PhaserRecipe lines, cooked; set / add_line / remove_line: one line of an existing phaser preset | create: **used** (must be empty first, cleared with ClearAll at the end); edits: untouched |

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
| Per-line MAtricks columns (XWings, XBlock, XGroup, XWidth, XShift, XShuffle, X, FadeFromX / FadeToX, DelayFromX / DelayToX, PhaseFromX / PhaseToX, SpeedFromX / SpeedToX, and the Y and Z ones) | written by `gma3_store_recipe_cues` and read back there; **not verified on a console** (see below); not edited by `gma3_edit_recipe`. A line whose X, Y or Z column is set (also inherited, `<2>`) gives values to only part of its group: it is read (`axisSelect`) and its coverage is not predicted by `gma3_recipes` and `gma3_cook_recipes` |
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
  - `axisSelect` when its X / Y / Z column selects part of the group ("X 1");
  - `notPredicted` where coverage is not modelled (phaser lines, filters, an axis selection);
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
   `compare_existing` (`replace` only, #145): a cue part whose lines already read as asked (group, values, MAtricks or
   none, Enabled, the name and selection mode as given or a new line's (no name, Strict), no Filter, SelectionFromValue
   No, the given columns, and every column the request leaves out
   as a new line has it: the MAtricks settings None, X / Y / Z None, the other MAtricks properties at their reset
   values) and whose cue name and note match is **already done**: its item says so, is `matched`, and nothing is sent for it.
   Sending the same call again after a lost answer (a client timeout while the console finished) therefore rewrites
   only what differs. A field or column that could not be read, or a list read in part, is never taken for a new line's
   default: that part is written. Parts of one cue that ask for different names or notes (shared by the cue) are never
   skipped, so the last part's value is the one left. `append` always writes (a repeat cannot be told from a wanted second copy). A `cook` still cooks
   every part.
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

`preview: true` runs steps 1–3 and returns the plan per part (lines before, deletions, lines, requests, `alreadyDone`;
`detail: true` every command and write). The call sends progress notifications when the client asks for them: one
unit per part written, then one per part cooked ([reference](../reference.md#long-calls-progress-and-client-timeouts)). No `exclusive`: like `gma3_edit_recipe`, nothing goes through the programmer, the selection
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

## `gma3_edit_phaser_recipe`

No command or property creates a PhaserRecipe line outside the programmer (onPC 2.5.1: `Assign Shape … At <line>` is
an illegal object, `Store … Part P.L` makes a StandardRecipe). The console builds one in **Edit Recipe mode**: the
line is made in the programmer's Part Zero and stored into the target. This tool runs that sequence for a **free
preset slot** (a cue then calls the preset with a standard line, `gma3_store_recipe_cues`).

`action: "create"`, `preset: "P.N"`, `name?`, `exclusive: true`, and one line's fields at the top level or
`lines: [...]` (1-8). A line has `selection` (group), `shape` (default 1), `steps: [{preset, curve?}, {preset, curve?}]`
(exactly 2, from one preset pool: the line's family, whose attributes come from the step presets), `matricks?`,
`speed_bpm?`, `phase?: {from, to}`. The target may be in **any pool**: the preset's pool does not filter its recipe
lines (verified: a Dimmer + RGBW preset in the Dimmer pool and an RGBW phaser in the Position pool cooked completely).
One family per line is preferred (a cue reads more clearly). A line whose steps come from an All pool (21-25), whose presets may mix families, is allowed with a warning. `preview: true` runs the checks and returns the plan.

**Several lines.** A step holds one value source: a second `At Preset` on the same step replaces the first, and a
second `At Shape` on the same group re-shapes the line instead of adding one. Line 1 is therefore built in Edit Recipe
mode, and lines 2+ are copies of it: `Copy Preset P.N.1 At Preset P.N.k /NoConfirmation`, then `Assign Group / Shape /
MAtricks n At Preset P.N.k` where they differ and `Assign Preset X At Preset P.N.k.1.<step>.1` for the steps. What a
copied line does not set (speed, phase, curves) is line 1's. A cue calls the preset with one standard line, and every
line cooks into it at its own speed. A Speed X on that cue line replaces the speed of every line.

**Curves.** `curve` is one of `linear`, `ease_in`, `ease_out`, `ease_in_out`, `swing`, `snap`, or `reset` (back to
the shape's curve). It is sent from the command line,
`Set Preset P.N.L.1.<step>.1 Property "Curve" "<Linear|Ease In|Ease Out|Ease In and Out|Swing|Snap|Reset>"`.
The Lua `set` of CURVE is ignored, and CURVE reads back as an opaque id. With Link Steps (the default), a step's curve
writes its own DECEL and the next step's ACCEL:

| Curve | Own DECEL | Next step's ACCEL |
| --- | --- | --- |
| Linear | 0 | 0 |
| Ease In | +100 | −100 |
| Ease Out | −100 | +100 |
| Ease In and Out | −100 | −100 |
| Swing | +100 | +100 |
| Snap | 0 (and TRANS 0) | 0 |

The read-back checks those values in the cooked steps.

1. Checks, nothing sent otherwise: the slot is free; group, shape, step presets and MAtricks exist; the mode is off,
   Part Zero empty, no dialog open (`recipe.editState`); the programmer read completely and empty; the store
   preferences RecipeStoreMode Normal, StoreSource Programmer, ChannelFilter not All / All For Selected and StoreLook
   off. With StoreSource Output, ChannelFilter All or StoreLook on, the empty store and the `/Merge` store would take
   playback output, inactive values or open dimmers as uncooked data (probe SB-03).
2. `Store Preset P.N /NoConfirmation` with the empty programmer: creates the preset and **clears the pending Edit
   Recipe target**. A store made in Edit Recipe mode leaves its target pending, and the next `EditRecipe <other
   target>` opens "Update last object?" (OK overwrites that pending target with the programmer; an empty programmer
   wipes its recipe lines). A normal store just before prevents the dialog (verified live).
3. `recipe.editBegin` queues `EditRecipe Preset P.N` with CmdIndirect: sent with Cmd() from the plugin thread, the
   dialog would stall the bridge. The server polls `recipe.editState` until the mode reads on. If "Update last
   object?" opens anyway, it is answered **Cancel** (never OK) with `dialog.press` and the call stops.
4. Line 1: `Group`, `At Shape` (the line appears in Part Zero, checked), `Step 1`, `At Preset`, `Step 2`, `At Preset`,
   `MAtricks`, one command at a time; Part Zero is checked again (exactly one PhaserRecipe line), then
   `Store Preset P.N /Merge /NoConfirmation` (Part Zero empties).
5. `recipe.editEnd` queues the `EditRecipe` toggle (only while the mode reads on); the mode is read back off.
6. `ClearAll`: after the mode is off the programmer still holds the phaser's values, **output on stage from
   `At Shape` until here**. The programmer and Part Zero are read back empty.
7. The name; lines 2+ (copy and assigns, the line count checked after each copy); `SPEEDX` / `PHASEFROMX` /
   `PHASETOX` per line (replies compared as numbers); the curves of every line, **after all the copies** (a copy
   keeps line 1's custom curves); `Cook Preset P.N /MergeLowPriority`.
8. Read back:
   - the line count, and each line a PhaserRecipe with its group and MAtricks and no failed cook;
   - every value cooked and integrating, in order, the 2 step presets of one line, each line with at least one value,
     and nothing uncooked;
   - the cooked speed of each line's values is its `speed_bpm` / 60 Hz (the phase is spread per fixture by the
     MAtricks: only its set reply is compared), and each curve's DECEL / ACCEL / TRANS in the cooked steps (a layer
     `preset.read` leaves out is at its default: ACCEL and DECEL 0, TRANS 100);
   - the mode off, Part Zero and the programmer empty.

A failure before the store switches the mode off, clears the programmer and deletes the preset the call created (its
slot was free). After the store the preset is kept and the failure reported.

Two console facts for whoever works next to this tool (verified live):
- **After a successful build the preset stays the pending Edit Recipe target.** A manual `EditRecipe <other target>`
  at the console then opens "Update last object?". OK would overwrite that preset with the programmer. The tool's
  own next call is safe, because its empty store comes first.
- **An empty `Store Preset P.N /NoConfirmation` on an existing phaser preset wipes its recipe line.** That is why
  the tool only stores into a free slot, and refuses an existing one.

Speed: a cue line's Speed X **replaces** the preset's (RELATIVESPEED No); an empty column (`SPEEDFROMX` None) follows
the preset. 60 BPM = 1 Hz.

### Editing an existing phaser preset: `set`, `add_line`, `remove_line`

No programmer and no Edit Recipe mode (no `exclusive`): every change is an `Assign`, `Set`, `Copy` or `Delete` on the
preset's lines, then `Cook Preset P.N /MergeLowPriority`.

- `set` changes line `line` (default 1): `selection`, `shape`, `matricks`, `speed_bpm`, `phase`, `name`, and
  `steps: [{preset?, curve?}, {preset?, curve?}]` (`{}` keeps a step). The line must be a PhaserRecipe of 2 steps,
  each from a preset.
- `add_line` appends a copy of line 1 (`Copy Preset P.N.1 At Preset P.N.k`), retargeted with the given fields:
  `selection` and both step presets are required; shape, MAtricks, speed and phase are line 1's unless given. Every
  step is reset to the shape's curve, then given its `curve` if any (a copy keeps line 1's custom curves).
- `remove_line` deletes line `line` (`Delete Preset P.N.L /NoConfirmation`). The later lines move up (3 lines,
  delete line 2: line 3 becomes line 2). The only line is never removed: delete the preset instead.

Sent in this order: `Assign Group | Shape | MAtricks n At Preset P.N.L` (only what changes),
`Assign Preset X At Preset P.N.L.1.<step>.1` (the step keeps its curve), the curves (a step given a curve is reset to
the shape's first, then the named curve, so a Linear over a Snap gets TRANS 100 back), `SPEEDX` / `PHASEFROMX` /
`PHASETOX`, the name, then the Cook. **A new shape recomputes the curves of the steps that have no custom curve; a
custom curve stays** (`curve: "reset"` takes it back to the shape's).

Checked first, nothing sent otherwise: the preset and the line exist; the 2 steps come from one preset pool and are
not the preset itself; no other line has the same 2 step presets; group, shape, MAtricks and step presets exist; no
dialog is open; the Edit Recipe mode is off.

Read back:
- every line as expected: group, MAtricks, shape, speed (SPEEDX raw, in Hz), phase, step presets, and each step's
  ACCEL / DECEL / TRANS where they are known. After a new shape or a reset they are the shape's and are not compared;
- the edited line's cooked values come from its 2 step presets at its speed, and no value is left from its old step
  presets. When the edited line has no cooked value, a later line on the same group masks it only if that line has
  cooked values covering every value the edited line output before the edit, and its 2 step presets hold every
  fixture, cell and attribute the edited line's step presets hold (read with `preset.read`; a pool proves nothing,
  since pool 4 holds RGB and ColorWheel presets alike). Both lines' preset coverage counts only the fixtures and
  cells the edited line's group holds (`group.read`; a group that can't be read completely cuts nothing), each row by
  its mode: a selective row covers its own fixture or cell, a global row every selected fixture of its fixture type
  (the members' types read with `preset.read`'s `typesFor`, in the same form as the rows' type, e.g. "6 Mega Hex
  Par"), a universal row every selected fixture that has its attribute (`fixtureAttributes`). A row whose type or
  attributes can't be read is kept as it is. Then no
  cooked value is expected from the edited line (a note
  says so) and its definition is still checked. A step preset that is missing, empty or read in part proves no
  coverage: the edit is then a mismatch;
- every other cooked value unchanged, and nothing uncooked added. Each value is matched by fixture, cell, attribute
  and step presets, and compared field by field: value and relative value, every step's absolute, relative, accel,
  decel, transition, width and preset, speed, phase, measure, speed master, fade, delay and preset references
  (percent layers within 0.5, speed within 0.001 Hz, phase within 0.01°). The first changed value and field are
  named in the mismatch. A fixture and attribute that the edited line
  outputs, before or after, is left out of that comparison: where two lines act on the same attribute of the same
  fixture, the later line's value wins, so another line's value may rightly appear or go.

**A cue that calls the preset with a standard line follows the change without being re-cooked**: verified live with
Sequence 9000 Cue 11 on 21.9005 for a speed change, a new family, a step retarget and a removed line. That cue line
had no Speed X of its own: a cue line's Speed X replaces the preset's speed, so a `speed_bpm` edit does not show in
such a cue. `add_line` and `remove_line` also need the line (line 1 for `add_line`) to be 2 steps from presets: the
read-back tells cooked values apart by their step presets.

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
  - phaser recipe lines other than `gma3_edit_phaser_recipe`'s (more than 2 steps, a cue part as the target, steps of
    different pools in one line, steps with absolute values instead of presets);
  - filters and worlds;
  - recipe templates;
  - the Edit Recipe mode outside `gma3_edit_phaser_recipe`.
- Verified live for `gma3_edit_phaser_recipe` (onPC 2.5.1, bridge 0.52.0, 2026-11-14): a Dimmer phaser (8 fixtures,
  8/8 cooked, 2 Hz) and a colour phaser (4 fixtures, RGBW, 16/16 cooked, 0.5 Hz), built back to back, without a
  dialog; then a Dimmer line (Snap) and an RGBW line (Ease In) in the All preset 21.9002 (20/20 cooked, 2 Hz and
  0.5 Hz, curves read back), called by one standard line of a cue (20 cooked values). The tool's Cancel and abort branches ran only against the fake bridge (`test/phaser-recipes.test.ts`).
  The console facts behind them were probed by hand through the same bridge ops and `gma3_dialog`:
  - The bridge stays responsive while "Update last object?" is open, and Cancel leaves the pending preset intact.
  - An aborted build (mode off after `At Shape`, then ClearAll) leaves the target and the programmer empty.
- Verified live for the edit actions (bridge 0.52.1, 2026-11-14, scratch preset 21.9005 called by Sequence 9000
  Cue 11), each read back matched:
  - `set` of step presets, Swing and 45 BPM;
  - a new shape with a reset;
  - Snap, then Linear (TRANS back to 100);
  - phase and name;
  - `add_line` twice (Ease In at 90 BPM, Swing at 30 BPM);
  - `remove_line` of a middle line;
  - a duplicate step pair and a missing line, refused.

  The cue's own values followed every change. The new order of `create` (curves after the copies) was verified live
  too: 21.9006, a Dimmer line with Snap on step 1 and an RGBW line without a curve, matched; line 2 kept the Sine
  curve (TRANS 100) instead of line 1's Snap. A copy keeps line 1's Snap, and `Assign Preset` keeps it too.

## Live test

`GMA3_LIVE=1 node --import tsx --test test/live/recipes.live.ts` on a disposable show with an empty programmer and
bridge 0.24.0. It uses Sequence 906, Groups 910–911, Presets 23.931 and 4.931, the fixtures 401–404
(`GMA3_LIVE_RECIPE_FIXTURES`) and the presets 4.4 and 1.11 (`GMA3_LIVE_RECIPE_COLOR`, `_DIMMER`), refuses to run when
those objects exist, and deletes them at the end.
