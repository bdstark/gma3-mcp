# Filters, worlds, appearances and views (#148)

Three tools, no bridge change (they use the `objects`, `children`, `set`, `cmd` and `dialog.read` ops):

| Tool | What it does |
|---|---|
| `gma3_pool_details` | Read-only. `kind` filters, worlds, appearances or views; `range` narrows it (`"Filter 1 Thru 20"`). |
| `gma3_store_filter` | Store a new attribute filter, or update one in place (`on_taken: "update"`). Batch form: `filters`. |
| `gma3_set_appearance` | Create or change an appearance and/or assign one to a pool object. Batch form: `assignments`. |

## What the console holds

Read-only probe of onPC 2.5.1.1 (Festoon Demo, 2026-11-17):

- Filters are `DataPool.Filters` and worlds `DataPool.Worlds`. Appearances are `ShowData.Appearances`. Views belong to the current user profile (`ShowData.UserProfiles.Default.Views`). `Filter Thru`, `World Thru`, `Appearance Thru` and `View Thru` resolve to the pool's objects.
- A filter's (and a world's) `Attributes` reads as one character per attribute definition (`ShowData.LivePatch.AttributeDefinitions.Attributes`, 356 in that show). The character is `1` when the attribute passes, and character *i* is the definition with index *i + 1*. "Only Dimmer" sets only character 0 (Dimmer). "Only Color" sets ColorRGB_R, G, B and W. A filter or world that passes every attribute reads `All` (World 1 "All").
- An attribute names its feature (`Feature`, e.g. `RGB`). A feature group (`FeatureGroups`) lists its features, which is how a feature group name resolves to attributes ("Color" → RGB, ...).
- `Absolute`, `Relative`, `Timing` and `Phaser` (Yes/No) are the value layers a filter passes. `HasDynamicFilterRules` reads Yes when the filter has dynamic rules (Changed, Cooked, ...).
- Appearances: `BackR`, `BackG`, `BackB` and `BackAlpha` (0–255) set the background colour. `ImageMode` is Stretch, Bar, Crop, Tile or Center, and `Image` reads the image's name (`[macro_png]`).
- A view's children are its windows (`WindowPresetPool`, ...), with grid `X`, `Y`, `W` and `H`.

## gma3_store_filter

Choose the attributes the filter passes by attribute name (`attributes`), by feature group (`feature_groups`), or both. Use `exclude` to take attributes out again. `layers` picks the value layers. Feature groups fail closed: if any attribute's feature, or any group's list of features, cannot be read, `feature_groups` is refused (name the attributes instead), and `gma3_pool_details` claims no group as fully passed. Unknown names refuse the item before anything is sent, and so do a filter that would pass nothing, a taken number (unless `on_taken: "update"`), a locked filter, a name another filter has (unless `on_name_taken: "allow_suffix"`) and an open dialog.

The steps:

A new filter, including one `on_taken: "update"` lands on because the number is free, always needs `attributes` or `feature_groups`, so its attributes never come from whatever the At Filter holds.

1. **New filter:** `Store Filter <n> "name" /NoConfirmation` (the 2.3 release notes give this form; it stores the At Filter). Then `Attributes` is written as the whole string with the bridge's `set` op, and all four layers are written, Yes unless `layers` says false.
2. **Update:** only what the call gives is written. `name` is applied with `Label`.
3. **Read back:** the filter must pass exactly the attributes asked for, and each layer must read as asked. A form the tool cannot compare is a mismatch, and a field it cannot read makes the result unavailable. Dynamic filter rules the At Filter carried into a new filter are reported as a warning; edit the filter on the console to remove them.

**Not run on a console:** whether `set` takes the whole `Attributes` string. The manual's Index keyword page writes one character at a time (`Set Filter 6 Property "Attributes" Index 0 "0"`). If the console does not take the whole string, the read-back shows it and the item fails. Using a filter in a store (`Store ... /Filter`, a sequence's or preset's input/output filter) is left to a follow-up.

## Property writes

Each `set` is judged by the value the console reads right after the write. A value it did not take fails that step, and nothing after it is sent, so an Assign never runs after an ignored colour. A read-back that failed makes the step `unknown`, which also stops a batch. `Attributes` reading `All` counts as all `1`s.

## gma3_set_appearance

- `appearance` is a number, or the name of an existing appearance.
- `create: {name, color "#RRGGBB", alpha (percent, default 100 with a color), image "Image 3.2", image_mode}` creates the appearance in a free number, or changes an existing one with `on_taken: "update"`.
- `object` (`"Group 3"`, `"Sequence 5"`, `"Preset 4.12"`, ...) gets `Assign Appearance <n> At <object>`. It must name exactly one object: wildcards are refused, and so is a name several objects (or appearances) have.
- Batch form: an item that only assigns an appearance is skipped when an earlier item creating or changing that appearance did not succeed; a failed assignment does not stop other assignments of the same appearance.

The steps:

1. A new appearance is `Store Appearance <n> /NoConfirmation`, plus `Label` for a name.
2. The colour is written with `set` (BackR/G/B/Alpha) and the image mode with `set` (ImageMode).
3. The image is assigned to the appearance itself (`Assign Image 3.2 At Appearance <n>`). Assigning an image straight to a group opens a "Select Appearance" pop-up (Images page).
4. The tool reads the dialog state before sending and after every Store and Assign. If a dialog is open, nothing more is sent; answer it with `gma3_dialog`.
5. **Read back:** the colour, alpha, image mode and image (compared with the image's own name), and the object's appearance compared by handle (two appearances can share a name).

**Not run on a console:** that `Store Appearance <n> /NoConfirmation` creates an empty appearance (the manual says this for images, `Store Image 3.2`), and whether `Assign Image ... At Appearance <n>` opens a pop-up. If it does, the dialog check stops the item.

## Left out

- Storing worlds (`Store World <n>` stores the selected fixtures) and views (`Store View <n> /Screen`).
- A `filter` option on the store tools.
