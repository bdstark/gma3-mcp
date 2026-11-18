# MVR import (#149)

`gma3_patch_import_mvr` patches and places the fixtures of an MVR file (My Virtual Rig, the GDTF project's scene
format exported by Vectorworks, Capture, other visualisers and grandMA3 itself). The file is read by the MCP server,
not by the console: grandMA3 2.5.1 imports MVR only through Partial Show Read in the Show Creator, a dialog-driven
menu (preparation, a grid of choices, Finish), and RoyX4's fork qualified that path in a lab and found it changed the
show's DmxCurves collection (its `docs/probes/g25-mvr-positions-native-2.5.1.1.md`). The import here runs the
structured tools instead, which each check, commit and read back on their own.

## What is read

The MVR is a zip with `GeneralSceneDescription.xml` and the GDTF files the fixtures name (parsing: `src/mvr.ts`).
Every `Fixture` under `Scene/Layers` is read, also inside a `GroupObject`, `Truss` or another object's `ChildList`:

| MVR | Used as |
|---|---|
| `FixtureIDNumeric`, else `FixtureID` when it is a whole number | the FID; a fixture without one, or with one above the console's 99,999,999, cannot be imported |
| `name` | the fixture's name (characters the console strips, `\"$&*?,.;^{}|~`, are removed and it is cut to the bridge's 128 bytes of UTF-8; a warning lists the changes) |
| `GDTFSpec`, `GDTFMode` | the GDTF in the zip and its DMX mode |
| `Addresses/Address` (`break` attribute) | the DMX address of break 0: an integer is the absolute 1-based address (513 = 2.001), `U.A` text is taken as it is, 0 means unpatched. More than one break is refused (gma3_patch_add takes single-break modes) |
| `Matrix` of the fixture and of every parent (layer, group, truss) | position in metres and rotation in degrees. A Matrix is `{u}{v}{w}{o}`: the object's axes and offset (mm) in its parent's frame. The rotation is given as the console's angles: grandMA3 builds a rotation as q = qZ·qY·qX ([positions.md](positions.md)), so R = Rz·Ry·Rx and the angles come from R. A scaled, sheared or mirrored matrix is refused for that fixture |

Other scene objects (trusses, scenery, focus points, video screens) are counted in a warning and not imported. MVR
layers are not stages: `stage` puts every fixture on one stage, `layer_stages` chooses per layer, and without either
`gma3_patch_add` uses its default stage. Positions are written as they are in the file, relative to the stage.

## Steps

| Step | Kind | What |
|---|---|---|
| `read_file`, `parse_mvr` | read | The file (at most 64 MiB, at most 1,024 fixtures per call: choose `layers`), the scene and each GDTF (at most 8 MiB, the limit of `gma3_patch_library_add`) |
| `check_console` | read | `patch.state`: a patch session can start (the patch copy closed, the command line at Root, no modal: the patch tools' own `check_state`, before anything is uploaded; preview fails too), the stages named exist ( a name that differs only in case, spaces or underscores is sent as the show spells it, and refused when it matches more than one), `patch.types`: each GDTF is matched to the show's fixture type by manufacturer and name; one match is used, none means the GDTF is imported, more than one is refused unless `types` names the type. Two GDTFs of the file for one type share one import when their bytes are the same, and are refused when they differ (after the first import the second would be a duplicate). Different types whose names clean to the same library file get the GDTF's CRC-32 as their revision part |
| `check_patch` | read | `patch.check { ranges }` (bridge 0.58.0), for the fixtures not already found unusable: every FID free, every DMX range free of the live patch and of the other fixtures, inside one universe. A patched fixture whose occupancy cannot be read stops the import only when a fixture of it has an address. For a type in the show the console's footprint is used; for a GDTF to import the footprint is counted from its DMX channels (`null` when GeometryReferences repeat channels, then checked after the import only) |
| `check_library` | read | `patch.libraryStat` for each GDTF to import, as `manufacturer@name[@revision].gdtf` from its own FixtureType: the same bytes already there are not sent again; different bytes, the name in another library, or a file whose name differs only in case, are refused |
| `check_mvr` | read | The verdict: every fixture with a problem is listed (no number, duplicate number, taken FID, DMX overlap, missing GDTF or mode, multi-break). With any, nothing is changed, unless `skip_unusable: true`, which leaves those out with a warning |
| `library_add`, `import_type` | mutation | `gma3_patch_library_add` and `gma3_patch_import` for each GDTF the show lacks |
| `recheck_patch` | read | The imported types' modes and footprints from the console, then every planned fixture's range checked again (a new footprint can overlap a fixture of a type the show already had) before anything is added |
| `add` | mutation | `gma3_patch_add` per block: same type, mode and stage, consecutive FIDs, consecutive addresses in one universe (or all unpatched) |
| `name` | mutation | `gma3_patch_set` with the names (unless `names: false`) |
| `place` | mutation | `gma3_place_fixtures` with positions and rotations in metres and degrees (unless `place: false`) |

Every change needs `exclusive: true`, as the patch tools do. `preview: true` runs the reads and returns the plan
(fixtures with FID, name, layer, stage, GDTF, mode, address, position, rotation; types used or imported; counts per
layer) and sends nothing. The import stops at the first sub-call that does not succeed or whose read-back mismatches;
the steps not attempted are listed as skipped, and the result's verification is the sub-calls' read-backs together.
Each sub-call is a committed change of its own: a patch has no undo, and an import stopped half way stays as it is.

## Not verified on a console

Written and tested against a fake bridge (`test/mvr.test.ts`, `test/lua/patch_ops_test.lua` for `patch.check
ranges`); not yet run on onPC:

- an MVR exported by grandMA3, Vectorworks or Capture: their Matrix, Address and FixtureID conventions (the absolute
  address is read 1-based, per the MVR specification);
- the rotation angles against the console's own MVR import (the q = qZ·qY·qX order is the probe of 2026-10-15);
- GDTF footprints counted from the file against the console's after import (the recheck catches a difference).

## Credit

Reading the matrix as the three axis columns plus offset follows RoyX4's fork (`scripts/mvr-inspect.py`), which also
documented why Partial Show Read is not used.
