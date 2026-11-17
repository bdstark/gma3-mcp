# gma3-mcp

An [MCP](https://modelcontextprotocol.io) server for **grandMA3 onPC**. Connect an MCP client to inspect
show data, program fixtures, store and edit cues, control playback and faders, and search the manual
installed with onPC. Arbitrary Lua execution is available as a separate, opt-in capability.

## Examples

The prompts below are what you might ask an MCP client such as Claude once it is connected to gma3-mcp. Most are
paraphrased from a real build: a two-floor Halloween party rig (moving heads, pixel bars, pars, a festoon string and
smart bulbs over Art-Net) programmed on the MA Show Start in onPC 2.5.1. Each example names what ends up on the console
and the structured tools that do the work. Every tool that changes the show checks first, sends each step once
(no retries) and, by default, reads the result back. The [tool pages](docs/tools/README.md) list each tool's
parameters and checks.

### Import fixture types and patch the rig

> Import the two moving-head models from their GDTF files so we get their gobos, then patch the rig from this fixture
> list with consecutive addresses on universe 1.

New fixture types from GDTF files sent to the console's user library (`gma3_patch_library_add`), found in the libraries
(`gma3_patch_library`) and imported into the show (`gma3_patch_import`). Fixtures added with their fixture IDs, names,
modes and DMX addresses (`gma3_patch_add`), with fixture ID and address collisions refused before anything is patched.

### Place the rig in 3D

> Place every fixture in the 3D view from the plot coordinates, in feet. The festoon is strung in a square wave with six
> bulbs per leg, starting at the centre.

Fixture positions and rotations, with line, arc and mirror layouts for symmetric rows (`gma3_place_fixtures`). The
festoon's bulbs placed along a square-wave path in DMX order (`gma3_layout_cells`).

### Build groups and presets on the MA Show Start

> Move the fixtures under the Show Start's slot fixtures and store the groups with the movers mirrored left and right.
> Then run the Position Wizard and fill in the colour, beam and focus presets the rig is missing.

Fixtures moved under the Show Start's grouping fixtures (`gma3_patch_move`). Groups stored with their selection-grid
layout and checked by recalling them (`gma3_store_group`). The wizard macro run (`gma3_run_macro`) and its confirmation
answered by button text (`gma3_dialog`). Presets stored with an explicit mode and content, then read back
(`gma3_store_preset`).

### Check the rig against the 3D view

> Put both beam movers at pan 0, tilt 45 so I can compare where they land with the 3D view. Then clear the programmer.

A look on both fixtures in one call, read back per fixture (`gma3_set_attributes`), and a cleared programmer
(`gma3_clear_programmer`).

### Build a cue list of moods

> Build a Mood cue list from our groups and presets: Ambient, Groove, Build, Peak, Breakdown and Outro, plus a Fill and
> a Riser. Put it on an executor so I can try it in the 3D view.

Effects stored as presets, such as a dimmer chase across the pixel bars, alternating colours and pan/tilt figure-eights
on the movers (`gma3_build_phaser`). A sequence of named cues with looks, fades and triggers (`gma3_store_cues`), short
looping chases for Fill and Riser, observed for one cycle (`gma3_build_chase`), and the sequence assigned to a page
executor (`gma3_assign_to_executor`).

### Add variety with recipes and MAtricks

> Add Halloween and carnival colour palettes with gradients that move while a cue plays, and fast gobo changes on the
> beams for high-energy phrases. Remove the fixed position lines from the verse and chorus cues and re-cook them.

MAtricks with wings, blocks and phase spreads (`gma3_configure_matricks`). Recipe cues that combine groups, presets and
MAtricks, written in batches of cue parts (`gma3_store_recipe_cues`) or line by line (`gma3_edit_recipe`), then cooked
with an explicit option after the affected cues are listed (`gma3_cook_recipes`).

### Operator macros, variables and tags

> Make operator macros that set the current genre and chapter, and tag the looks by phrase type so an external planner
> can choose between them.

Macros whose lines set console variables, stored without being run (`gma3_store_macro`), with starting values for the
variables (`gma3_set_variable`). Tags created and put on the look sequences (`gma3_store_tag`, `gma3_assign_tag`).

### Repack the DMX output

> Put most lights on universe 1, the UV bars and panels on 2, the festoons on 3, and the smart bulbs on universe 4 over
> Art-Net only.

Fixtures readdressed with collisions refused first (`gma3_patch_set`). Local universes mapped to Art-Net universes,
which needs an explicit `network: true` to send onto the network (`gma3_configure_dmx_output`), and the output
checked (`gma3_dmx_output`).

### Run looks from timecode

> Build a timecode show for the opening track: Ambient at 0:00, the Riser at 0:28, Peak at 0:32 and Outro at 3:45.

Not from the Halloween build. A timecode show with a track per sequence and cue events at those times, built without
playing or recording (`gma3_build_timecode`); playing it reports the events it crossed (`gma3_timecode_transport`).

### Save the show

> Save the show file.

The current show saved under its own name, or a new one, refusing to overwrite another show's file unless asked
(`gma3_save_show`).

## Get started

Choose the guide for the computer running grandMA3 onPC and your MCP client:

| Platform | Setup guide |
| --- | --- |
| macOS | [Install and connect on macOS](docs/setup/macos.md) |
| Windows | [Install and connect on Windows](docs/setup/windows.md) |

Both guides cover building the server, copying the plugin, importing it into onPC, configuring your
MCP client (ChatGPT desktop, Claude Code or Claude Desktop), and checking the connection.
Start with the native setup for your platform. For ChatGPT in a browser, see [ChatGPT web](docs/setup/chatgpt-web.md).

Running the MCP client on a different computer? See [remote access over SSH](docs/remote-access.md).
For container deployment, see [Docker](docs/docker.md).

The documented live verification baseline is **grandMA3 onPC 2.5.1.0 on macOS**. Windows instructions
are provided, but this does not establish equivalent live validation on Windows or other onPC versions.
See the [tested platform/version matrix](docs/compatibility.md) for the distinction between live probes,
automated checks and deployments still awaiting qualification.

## What you can do

| Area | Capabilities |
| --- | --- |
| Show inspection | Sequences, cues, executors, fixtures, pools, object properties and children |
| Fixture programming | Select fixtures, set attributes, RGB color and position, clear the programmer |
| Cue workflows | Create, merge, overwrite, label, time, trigger, go to and delete cues and parts |
| Playback | Sequence and executor actions, faders, executor assignment and labeling, executor functions and sequence playback settings (Wrap Around, priority, restart, locks) |
| Groups and MAtricks | Groups from explicit selection-grid cells or row, rectangle and mirror helpers (stored, read back and recall-checked), group and selection grid reads, MAtricks objects with wings, blocks, groups and fade/delay/phase/speed distributions |
| Presets | Store the programmer into presets with explicit mode (selective, global, universal), forced conversion, merge/overwrite, scope, attribute and layer filters, embedding and input filter, refusing unrequested content and verifying the stored rows; read preset content, references and dependencies |
| Phasers | Build effects from structured steps or templates (dimmer chase, alternating colours, pan/tilt circle) with step timing, phase distribution, direction, repetition and speed, in the console's Preview environment, stored as presets and read back step by step; explicit audition and release |
| Recipes | Read, add, change, reorder and remove recipe lines in presets and cue parts; cook a preset, cue part, cue or sequence with an explicit option after listing the affected targets and their predicted coverage, protecting uncooked cue data |
| Structured inspection | Fixture attributes, programmer values, fixture output, DMX and supported cue contents |
| Reference | Local grandMA3 manual, live Lua API descriptions and the `gma3://cheatsheet` resource |
| Advanced control | Command-line commands and optional Lua execution |
| Console input (opt-in) | Logical MA keys, raw PC keys, text and bounded input sequences with explicit ownership, once the operator enables input on the console |

See the [complete tool and configuration reference](docs/reference.md). Workflow tools report command
outcomes and read-back verification separately; an uncertain outcome requires inspecting console state
before trying the command again. Some console data is unavailable through the API and is reported as a
limitation, rather than invented or returned as a misleading zero.

## How it works

```text
MCP client → stdio → Node.js MCP server → local TCP bridge → grandMA3 onPC
```

The [Lua bridge plugin](plugin/gma3_mcp_bridge.lua) runs inside onPC and listens on `127.0.0.1:9800`.
The [MCP server](src/index.ts) translates tool calls into bridge requests. Both parts are required for
show inspection and workflow tools. The plugin also carries three instance-based
[console interaction modules](docs/modules.md) (owned input sessions, read-only feedback, continuous-control
admission) as extra components of the same XML. Input is off by default; the operator enables it per start on the console
keyboard backend (`input=keyboard`, real key presses through `Keyboard()`), the owned-Quickey backend
(`input=quickey`, real key presses through a provisioned Quickey bank on reserved executors), both on one instance
(`input=mixed`, the Quickey default with per-key `Keyboard()` overrides; combinations that are not qualified are refused)
or the fake backend (`input=fake`, events recorded only). The [structured input tools](docs/tools/input.md) (`gma3_hardkey`, `gma3_keyboard`,
`gma3_type`, `gma3_input_sequence`, `gma3_input_interaction`, status and release) expose it; while input is
owned by any client, the bridge refuses commands, property changes, playback, faders and Lua from every client
with an explicit `[busy]` error instead of running them into a changed console state. The read-only
[feedback tool](docs/tools/feedback.md) (`gma3_feedback`) observes command text, masters, Preview, page, selection,
executor assignment, fader levels and sequence activity without Lua, input or a free bridge.

`gma3_command` also supports write-only OSC when OSC input is configured in onPC. Automatic fallback
happens only if the bridge cannot be reached before dispatch; a command with an uncertain result is
never automatically replayed. `gma3_start_bridge` can start an already-imported plugin over OSC.
OSC is optional for the normal bridge setup and is not forwarded by an SSH tunnel. `gma3_osc`, `gma3_configure_osc` and
`gma3_test_osc_input` read, configure and test the console's OSC (see [docs/tools/osc.md](docs/tools/osc.md)).

## Before using it in a show

- Tools operate on the live show and can change the programmer, playback and stored show data. Start
  with a disposable show and read-only queries. Save your show when you want show changes to persist;
  commands and enabled Lua can also perform file operations.
- The bridge has no authentication. It accepts loopback connections only, so local applications can
  access it. Use the documented SSH setup for remote access.
- Arbitrary Lua is disabled on the bridge by default. Its execution budget is best effort and is not
  a sandbox or a cancellation guarantee. Read [Lua execution and hook policy](docs/lua.md) before enabling it.
- Commands that open a blocking dialog can stall the plugin. Use `/NoConfirmation` where appropriate.

## Documentation

- [Bridge import, startup, updates and troubleshooting](docs/setup/bridge.md)
- [Configuration, tools, workflow results and bridge protocol](docs/reference.md)
- Workflow details: [fixtures](docs/tools/fixtures.md), [cues](docs/tools/cues.md),
  [executors](docs/tools/executors.md), [inspection](docs/tools/inspection.md), [console input](docs/tools/input.md),
  [console feedback](docs/tools/feedback.md), [patch](docs/tools/patch.md), [playback configuration](docs/tools/playback.md),
  [groups and MAtricks](docs/tools/groups.md), [presets](docs/tools/presets.md), [phasers](docs/tools/phasers.md),
  [recipes](docs/tools/recipes.md), [speed masters and tempo](docs/tools/speed.md), [macros](docs/tools/macros.md),
  [timecode shows](docs/tools/timecode.md)
- [Show-building features (SB-01 .. SB-08)](SHOWS.md)
- [Show setup from scratch: field-test gaps and fixes (SU-01 .. SU-10)](SETUP.md)
- [Claude Code skill for building a show on the MA Show Start](docs/skills/gma3-show-build/SKILL.md): link it into
  your skills from this checkout with
  `mkdir -p ~/.claude/skills && ln -s "$PWD/docs/skills/gma3-show-build" ~/.claude/skills/`
- [Hardkey, keyboard and feedback feature requests and evidence](KEYBOARD.md), [console interaction modules](docs/modules.md)
- [Dialog control and dialog-free patching: plan and evidence](DIALOG.md)
- [Optional Lua execution](docs/lua.md)
- [Remote access over SSH](docs/remote-access.md) and [Docker](docs/docker.md)
- [Tested platform/version matrix](docs/compatibility.md) and [pinned modules for independent consumers](docs/modules.md#vendoring-into-another-plugin-mtpnxk)
- [Development and automated tests](docs/development.md), [live test procedure](test/live/README.md)

## Contributing and security

Please follow the [code of conduct](CODE_OF_CONDUCT.md).
See [accessibility guidance and reporting](ACCESSIBILITY.md) for interface and documentation barriers.
See [contribution guidance](CONTRIBUTING.md) for bug reports, development checks and pull requests.
Report suspected vulnerabilities privately using the [security policy](SECURITY.md).

## License

[MIT](LICENSE)

grandMA3 and MA Lighting are trademarks of MA Lighting Technology GmbH. This project is independent and is
not affiliated with, endorsed by, or supported by MA Lighting. No MA Lighting documentation, code, or
libraries are redistributed here: the help tool reads the manual from your own onPC installation at runtime,
and the bridge plugin uses the LuaSocket and JSON libraries already shipped inside onPC.
