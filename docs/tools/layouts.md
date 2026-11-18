# Layout views (#146)

Layouts are the 2D views of the Layout pool (`DataPool.Layouts`): pool objects placed as elements on a canvas for
touch busking. `gma3_store_layout` builds one; `gma3_layouts` reads them.

No bridge change: Assign and Delete go through the `cmd` op, element properties through `set` (both refused while
another client owns input), reads through `objects` and `children` (with `asText: false` an element's `Object` reads
as `{class, name, addr}`).

## What is known, and from where

- onPC 2.5.1.1 (2026-11-17, read-only): Layout 1 "Default" is class `Layout` with layout-level properties
  (PositionX/Y, DimensionW/H, RenderStyle, ...); its elements are its children. The user profile's
  `LayoutElementDefaultsCollect` holds the defaults new elements get per object type.
- MA's system tests shipped with the console (`lib_plugins/systemtests`): `Assign Sequence 1 At <layout>` adds an
  element as the layout's last child; PositionX/Y, Width, Height, Action, Appearance, CustomTextText and
  CustomTextColor are set on it; in Lua, `VISIBILITYOBJECTNAME` / `VISIBILITYBORDER` take `"Visible"` / `"Hidden"`.
- The element editor (`lib_menus/ui/editors/layout_element_editor.uixml`) edits Object, Action, Appearance, PosX,
  PosY, Width, Height, Name, CustomTextText/Size/Color/AlignmentH/AlignmentV and the Visibility* toggles.

**Not verified on a console**: that an Assign onto an empty layout slot creates the layout (the manual says so for
fixtures assigned to an empty pool object); how each Visibility* property reads back (the tool accepts
Visible/On/Yes and Hidden/Off/No); that `Appearance` takes an appearance by name through `set`. The tool reads
everything back and reports a mismatch rather than assuming.

## gma3_store_layout

```json
{
  "layout": 5,
  "name": "Busk",
  "elements": [
    { "object": "Sequence 1", "x": 0, "y": 0, "width": 120, "height": 80, "text": "Intro", "action": "Go+" },
    { "object": "Group 2", "x": 130, "y": 0, "show_name": false, "text_color": "FF0000FF" }
  ],
  "grid": { "objects": "Sequence 10 Thru 21", "columns": 4, "y": -100, "width": 100, "height": 100, "gap": 10, "skip_missing": true }
}
```

- **Objects**: one pool object per element: Group, Sequence, Macro, Preset (`4.12`), MAtricks, Quickey, World, View,
  Plugin, Fixture (`101` or `101.3`), Timecode, Timer. `grid.objects` takes a range (`Sequence 1 Thru 12`,
  `Preset 4.1 Thru 4.8`) or a `+` list, laid out row by row from (x, y); rows go downwards (smaller y), as MA's own
  layout tools do. At most 200 elements per call.
- **Pre-checks** (nothing sent on failure): every object exists (with `grid.skip_missing` a range's empty numbers are
  left out and the grid closes up over them); the layout slot is free unless `overwrite: true` (Delete Layout, read
  back gone, then rebuild: the layout's own settings are lost) or `append: true` (add after its elements); the name
  is free in the Layout pool (`on_name_taken`).
- **Per element**: `Assign <object> At Layout <n>`. The layout must then have exactly one more element, and its last
  element must show that object (compared by address); otherwise the call stops before any property is set, since
  the layout is no longer in the planned state. Then each asked property is set on the element's address.
- **Read-back**: the whole layout: element count, each new element's object and every asked property, and the
  layout's name. A property the console ignored or that could not be read is a mismatch.
- `preview: true` lists the commands and sends nothing. Not retried; an unanswered Assign stops the call.

| Field | Console property | Written as |
|---|---|---|
| `x`, `y`, `width`, `height` | PosX, PosY, Width, Height | number |
| `name` | Name | text |
| `text` | CustomTextText | text |
| `action` | Action | e.g. `Go+`, `Toggle`, `Flash`, `SelectFixtures` |
| `appearance` | Appearance | name |
| `show_name`, `show_id`, `border`, `bar`, `value` | VisibilityObjectName, VisibilityID, VisibilityBorder, VisibilityBar, VisibilityValue | `Visible` / `Hidden` |
| `text_size` | CustomTextSize | Default, 10, 12, 14, 16, 18, 20, 24, 28, 32 |
| `text_color` | CustomTextColor | RRGGBBAA |
| `align_h`, `align_v` | CustomTextAlignmentH / V | Left, Center, Right, OutsideLeft, OutsideRight / Top, Center, Bottom, Above, Below |

## gma3_layouts

Read-only. Without `layout`: the pool (number, name, element count). With `layout`: its elements in order, each with
the object it shows (`{class, name, addr}`), PosX/PosY/Width/Height and the text and visibility properties as
display text; `complete: false` with an error when the listing could not be read whole.

## Live test (throwaway show)

1. `gma3_store_layout {layout: <free>, name: "MCP test", elements: [{object: "Group 1", x: 0, y: 0, width: 100, height: 60, text: "G1", show_name: false}], grid: {objects: "Sequence 1 Thru 4", columns: 2, y: -100, skip_missing: true}}`
   - expect matched; open the layout on screen and check positions, label, hidden name.
2. Run it again with `append: true` and one more element; then with `overwrite: true`.
3. `gma3_layouts {layout: <n>}`: check how the Visibility* properties read (Visible/Hidden or On/Off).
4. Delete the layout (`gma3_pool_objects {action: "delete", object: "Layout <n>"}`).
