/**
 * One console undo group per MCP tool call (bridge 0.55.0, `undo.open` / `undo.close`). Off by default: set
 * GMA3_UNDO_GROUPS=1 to turn it on. From silly82/gma3-mcp, reworked to be opt-in.
 *
 * `UndoGroups` supplies the MutationLock hooks: the outermost mutation span opens a group named after the running tool
 * (the tool scope below) and closes it when the span ends. The bridge joins to it only the commands of its `cmd` op
 * from this connection, so one Oops at the console reverts those. Property writes (`set`), commands the bridge queues
 * with CmdIndirect (patch sessions, show load and save, recipe editing, library import) and Lua are not in the group:
 * a tool that uses them is undone only in part, or not at all. While a group is open the console answers an
 * operator's Oops with "Not possible at the moment"; groups last only as long as one tool call.
 *
 * Best effort throughout: an older bridge ("unknown op") switches grouping off for this process, any other failure is
 * logged and ignored, and nothing here ever fails the tool's mutation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { BridgeError, type Gma3Bridge } from "./bridge.js";
import type { MutationHooks } from "./mutations.js";

const toolScope = new AsyncLocalStorage<string>();

/** Run `fn` as tool `name`: everything it awaits sees the name through `currentTool()`. */
export function inToolScope<T>(name: string, fn: () => T): T {
  return toolScope.run(name, fn);
}

/** The running tool's name, if any. */
export function currentTool(): string | undefined {
  return toolScope.getStore();
}

/**
 * Tools whose spans get no group: loading or saving switches or writes the show file, and patch sessions work in the
 * patch copy through ChangeDestination, which the console's undo does not cover.
 */
export const DEFAULT_UNDO_EXCLUDED: ReadonlyArray<string> = ["gma3_load_show", "gma3_save_show", "gma3_patch_*"];

/** Is GMA3_UNDO_GROUPS set to a value that turns grouping on? (Off when unset.) */
export function undoGroupsEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

const isUnknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/i.test(err.message);

export interface UndoGroupOptions {
  /** Default: GMA3_UNDO_GROUPS from `env`. */
  enabled?: boolean;
  /** Tool names, or prefixes ending in `*` (default DEFAULT_UNDO_EXCLUDED plus the comma list in GMA3_UNDO_EXCLUDE). */
  exclude?: Iterable<string>;
  env?: Record<string, string | undefined>;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Diagnostics (default: stderr); repeated messages are logged once. */
  log?: (message: string) => void;
}

export class UndoGroups implements MutationHooks {
  readonly enabled: boolean;
  private readonly exclude: string[];
  private readonly openTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly log: (message: string) => void;
  private lastLog: string | undefined;
  /** The bridge answered "unknown op": it predates 0.55.0, stop asking. */
  unsupported = false;
  private open: string | undefined;

  constructor(
    private readonly bridge: Pick<Gma3Bridge, "request">,
    opts: UndoGroupOptions = {},
  ) {
    const env = opts.env ?? process.env;
    this.enabled = opts.enabled ?? undoGroupsEnabled(env.GMA3_UNDO_GROUPS);
    const extra = (env.GMA3_UNDO_EXCLUDE ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    this.exclude = [...(opts.exclude ?? [...DEFAULT_UNDO_EXCLUDED, ...extra])];
    this.openTimeoutMs = opts.openTimeoutMs ?? 3000;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 5000;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  private excluded(tool: string): boolean {
    return this.exclude.some((e) => (e.endsWith("*") ? tool.startsWith(e.slice(0, -1)) : tool === e));
  }

  private note(message: string): void {
    if (message === this.lastLog) return;
    this.lastLog = message;
    this.log(`gma3-mcp undo groups: ${message}`);
  }

  async enter(): Promise<void> {
    this.open = undefined;
    if (!this.enabled || this.unsupported) return;
    const tool = currentTool();
    // Only spans of a tool call are grouped; a span outside one (startup checks) is left alone.
    if (!tool || this.excluded(tool)) return;
    try {
      await this.bridge.request("undo.open", { name: tool }, this.openTimeoutMs);
      this.open = tool;
      this.lastLog = undefined;
    } catch (err) {
      if (isUnknownOp(err)) {
        this.unsupported = true;
        this.note("the bridge plugin has no undo.open (needs bridge 0.55.0); tool calls are not grouped");
      } else {
        // A reply lost after dispatch may still have opened the group: close it, which is harmless if it did not.
        if (err instanceof BridgeError && err.dispatched) this.open = tool;
        this.note(`undo.open failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async exit(): Promise<void> {
    if (this.open === undefined) return;
    this.open = undefined;
    try {
      await this.bridge.request("undo.close", {}, this.closeTimeoutMs);
    } catch (err) {
      this.note(`undo.close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
