# Ports from forks

Work from forks of this repository that is being brought upstream, reviewed 2026-11-17 against `main` 082dc57
(bridge 0.50.0). Each row lands as its own pull request, in this order, because most of them change the bridge
and its version. Commits are cherry-picked with their author when they apply cleanly; otherwise they are
re-implemented on `main` and credit the author with `Co-Authored-By`.

| # | Change | From | How | Bridge |
|---|---|---|---|---|
| 1 | Results serialised answer-first with `failure`; `gma3_place_fixtures` inside a grouping fixture at the origin; `gma3_patch_set` timeouts, multi-break fixtures, GDTF file name in the isolation check; `gma3_edit_recipe` `values` as a string | ndavi (a05cc0d, 35b071a, 2cecc81, eb778b8) | cherry-pick | 0.51.0 |
| 2 | Cue stored values in `gma3_cue_contents`, stored-value verification of cue stores, `gma3_preset_usage`, `gma3_cue_diff`, `gma3_tracking_leaks` | ndavi (ccaa864) | cherry-pick | — |
| 3 | `gma3_edit_phaser_recipe` (create, set, add_line, remove_line) | ndavi (911aeca..8dec1b9) | cherry-pick | 0.52.x |
| 4 | Fixture selections bounded at 4,096 characters (compact, then split looks into parts); phaser read-back on a reversed physical range | RoyX4 (2cf0936, 48a230d, 9e12118) | re-implement | — |
| 5 | Stale-socket close no longer drops the new connection; show state and instance id in the ping; patch fingerprint ignores a neighbour's Display text (RoyX4 9e12118) | silly82 (feat/status-undo), RoyX4 | re-implement | 0.53.0 |
| 6 | `gma3_load_show`: unsaved-changes decision before loading, OSC restart through `gma3_start_bridge`, new-instance check | silly82 (feat/load-show) | re-implement | next |
| 7 | `gma3_save_show` after-save hook (opt-in through `GMA3_AFTER_SAVE_HOOK` only, no default path) | RoyX4 (b0f367e, 97d83c4) | cherry-pick, then the default path removed | — |
| 8 | `gma3_network_output`: passive sACN / Art-Net listener | silly82 (432b9cb) | cherry-pick | — |
| 9 | Undo groups, one per tool call, off by default (`GMA3_UNDO_GROUPS=1`); only `cmd`-op commands join | silly82 (feat/status-undo) | re-implement | 0.55.0 |

## Not taken

- silly82's HTTP API and change hooks: every mutating tool over HTTP by default, token accepted in the query
  string, no consumer yet.
- RoyX4's programming jobs, checkpoints, tracking compiler, MVR, workspace/UI and multi-instance tools: a separate
  product line (about 21,000 lines, 45 tools) tied to its own lab setup. Individual tools can be proposed again
  one at a time.
- jakuba74-beep/gma3-mcp_local has no commits of its own.
