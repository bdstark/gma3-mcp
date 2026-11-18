# Bitmaps: images mapped onto pixels (#143)

grandMA3's Bitmap generator maps an image (or video) onto a fixture selection: the selection's arrangement in the
selection grid is the canvas, and each Bitmap channel turns a part of the media (red, green, blue, intensity, ...)
into an attribute value. One bitmap can replace a hand-made stack of frames, such as the 72-cue NEWTONHAUS scroll
in Festoon Demo.

| Tool | What it does |
| --- | --- |
| `gma3_image_add` | Uploads a `.png` / `.jpg` over the bridge into `gma3_library/media/images` and imports it into `Image 3.<n>` |
| `gma3_build_bitmap` | Stores `Bitmap <n>`, sets its config (image, canvas size, content mode, ...) and channels, reads it back; optionally applies it to a group and stores the result (unverified) |
| `gma3_bitmaps` | Read-only: every bitmap (configs and channels), and with `images: true` the Images pool |

All three need bridge 0.57.0 (`bitmap.list`, `bitmap.set`, `bitmap.imageName`, and kind `image` on
`patch.libraryStat` / `patch.libraryAdd`).

## What the probe established (onPC 2.5.1.1, 2026-11-17)

Created and deleted again in Festoon Demo; the full notes are on gma3-mcp#143.

- `Import Image 3.<n> /File "<file>"` imports from `gma3_library/media/images`. `Import Image 3.<n> Library "…"`
  answers Failed, and `Import Library "…" At Image 3.<n>` answers Object not found. The result is class `UserImage`
  (`ShowData.MediaPools.Images`), named `[<file>_png]`, with `FILENAME`, `FILESIZE` ("157B") and the bytes embedded
  (`SOURCE` Showfile). `WIDTH` / `HEIGHT` read 0. Each image object holds at most 10 MiB.
- `Store Bitmap <n> /NoConfirmation` creates class `Bitmap` at `DataPool.GeneratorTypes.Bitmaps` with
  `BitmapConfigs` → `BitmapConfig 1` (`CONTENT`, `WIDTH` / `HEIGHT` default 64, `CONTENTMODE` None/Clip/…,
  `INTERPOLATE`, `ALPHA`, `CONTROLX` / `Y` / `ZOOM` / `ASPECT` / `ROTATE`) and `BitmapChannels` with five channels:
  Dimmer←Intensity, Dimmer←Const, ColorRGB_R←Red, ColorRGB_G←Green, ColorRGB_B←Blue. Those defaults suit RGB cells.
- `Set('Content', <UserImage>)`, `Set('Width')`, `Set('Height')` and `Set('ContentMode')` read back as set.
- `Group 1 At Bitmap 1` (the 80 festoon cells) answered OK, but the programmer kept the cells' existing values and
  the output kept the running bar sweep. **Whether and how a bitmap value lands in the programmer is not confirmed.**

## gma3_image_add

Parameters: `image` (slot, `Image 3.<image>`), `content_base64` + `file_name`, or `path` (a file on the MCP
server's host; `file_name` defaults to its name), `name`, `replace_file`, `overwrite`.

Steps:

1. `read_file` (with `path`), `check_content`: at most 10 MiB, and the bytes are the format the name says (PNG
   signature, JPEG SOI marker). The name is `<name>.png`, `.jpg` or `.jpeg` in lower case, with no path characters.
2. `check_slot` (`bitmap.list {image}`): refused when the slot is taken, unless `overwrite: true`.
3. `check_folder` (`patch.libraryStat {file, kind: "image"}`): refused when a file differing only in case is there,
   or the same name holds other bytes (unless `replace_file: true`). The same bytes are not sent again.
4. `write`: `patch.libraryAdd {kind: "image"}` in 48 KiB chunks, moved into place on a matching size and CRC-32
   (the same mechanism as `gma3_patch_library_add`).
5. `delete_old` (only with `overwrite` on a taken slot): `Delete Image 3.<n> /NoConfirmation`. Appearances and
   bitmaps that used the old image lose it.
6. `import`: `Import Image 3.<n> /File "<file>"`.
7. `name` (with `name`): `bitmap.imageName`.
8. `read_back` (`bitmap.list {image}`). **Matched** when the slot is a `UserImage` of that file, its `FILESIZE`
   text is the byte count (exact in bytes, or within rounding in kB/MB of 1000 or 1024), and the name is the one
   asked for.

The images folder is derived from the user fixture library (`gma3_library/fixturetypes` → `gma3_library/media/images`);
`Enums.PathType.UserImages` is used only when that does not work, and which folder that is has not been checked.

## gma3_build_bitmap

Parameters: `bitmap`, `image` (number or `"3.<n>"`), `name`, `width`, `height` (canvas in selection-grid squares;
match the group's grid, e.g. 40 × 2 for the two 40-cell festoon strands), `content_mode` (`None`, `Clip`, ...),
`interpolate`, `alpha`, `control {x, y, zoom, aspect, rotate}`, `channels [{attribute, source, low?, high?}]`
(replaces all channels; sources Intensity, Const, Red, Green, Blue, Alpha, Hue, Saturation, Brightness),
`speed_master`, `overwrite`, `apply {group}`, `store {preset}` or `store {sequence, cue}` (with `overwrite`).

Steps:

1. `check` (`bitmap.list {bitmap, image}`): the image exists and is a `UserImage`; the bitmap slot is free unless
   `overwrite: true`. `check_group` and `check_store` read the apply group and the store target (`objects`).
2. `delete_old` (only with `overwrite` on a taken slot): `Delete Bitmap <n> /NoConfirmation`.
3. `store`: `Store Bitmap <n> /NoConfirmation`. Without a clear answer, `resolve_store` reads the slot: the bitmap
   is there, so the store is taken as done, or nothing is configured.
4. `configure`: `bitmap.set`. The bridge checks every value first (the image, each attribute in the show's
   attribute definitions, each source), then sets each one on its own; a refused set is listed in `setErrors` and
   fails this step, while the others still apply.
5. `read_back` (`bitmap.list {bitmap}`). **Matched** when every asked setting reads back: the content is
   `Image 3.<image>`, sizes and control values within 0.01, words ignoring case, channels in order.
6. Apply and store run only when `configure` succeeded and the read-back **matched**; otherwise both are `skipped`,
   so a misconfigured bitmap never reaches the programmer or a preset or cue.
   `apply` (with `apply`): `Group <g> At Bitmap <n>`, then `read_programmer` (the bridge's `programmer` op on the
   selection). The rows are reported (`verification: "unverified"`), not compared. The selection and programmer
   values stay; clear them with `gma3_clear_programmer`.
7. `store_look` (with `store`): `Store Preset <p> /NoConfirmation` or `Store Sequence <s> Cue <c> /NoConfirmation`
   (`/Overwrite` when the target exists and `store.overwrite` is set), then `read_store`: the target exists. Its
   content is not compared (`verification: "unverified"`).

The result's `verification` covers steps 3 to 5 only; warnings say that apply and store are unverified. The summary
names each of them from its step: "command accepted; … unverified" only when the console accepted it, "FAILED" when
it refused, "got no clear answer" on no reply, and "not stored … (skipped …)" when an earlier step stopped it (a store
is never attempted after an apply that did not succeed).

Unverified on a console: channel replacement (`Acquire("BitmapChannel")` to add, `Delete` to remove), setting
`Attribute` by handle (the bridge falls back to the attribute's name), `SpeedMaster` values, `Interpolate` / `Alpha`
as Yes/No, and everything about apply and store.

## gma3_bitmaps

Read-only. `bitmap` limits the list to one bitmap; `images: true` adds the Images pool (number, name, file, size).

## Live test (disposable show, or Festoon Demo cleaned up afterwards)

1. Clear the programmer (`gma3_clear_programmer {mode: "all"}`), so the apply can be read cleanly.
2. `gma3_image_add {image: 1, path: "<a 40×2 rainbow png>"}`: matched.
3. `gma3_build_bitmap {bitmap: 1, image: 1, width: 40, height: 2, content_mode: "Clip", apply: {group: 1}}`:
   matched; note what `read_programmer` shows and watch the festoon output (`gma3_observe_values` source output).
4. Clean up: `gma3_clear_programmer {mode: "all"}`, `Delete Bitmap 1 /NoConfirmation`,
   `Delete Image 3.1 /NoConfirmation`, and remove the file from `gma3_library/media/images`.
