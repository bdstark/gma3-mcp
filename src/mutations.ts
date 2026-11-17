/**
 * Serialises mutations issued by this MCP server (FR-03).
 *
 * Multi-command workflows (select, set attribute, store ...) must not interleave with other
 * mutations from the same server, otherwise a concurrent tool call could change the selection
 * between two commands of a workflow. The lock is a simple FIFO promise chain.
 *
 * It only orders this process's own requests. It does not isolate a workflow from another console
 * operator, another MCP server, or anything else talking to the console at the same time.
 */
export interface MutationHooks {
  /** Called when a span starts (depth 0 -> 1), after the previous holder released the lock. */
  enter?(): Promise<void>;
  /** Called when the span ends (depth 1 -> 0), before the lock is released; also after a failed mutation. */
  exit?(): Promise<void>;
}

export class MutationLock {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  /**
   * `hooks` wrap every outermost span, e.g. one console undo group per span (src/undo.ts, off by default). A hook
   * error never fails the mutation: it is swallowed here. (From silly82/gma3-mcp.)
   */
  constructor(private readonly hooks: MutationHooks = {}) {}

  private async hook(which: "enter" | "exit"): Promise<void> {
    const fn = this.hooks[which];
    if (!fn) return;
    try {
      await fn.call(this.hooks);
    } catch {
      // A hook is best effort by contract.
    }
  }

  /** Run `fn` after every previously queued mutation has finished. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.depth++;
    try {
      if (this.depth === 1) await this.hook("enter");
      try {
        return await fn();
      } finally {
        if (this.depth === 1) await this.hook("exit");
      }
    } finally {
      this.depth--;
      release();
    }
  }

  /** True while a mutation holds the lock. */
  get busy(): boolean {
    return this.depth > 0;
  }
}

/**
 * The lock as seen from inside a span that already holds it (SU-12 review round 1): `run` executes at once. A batch
 * takes the real lock once and gives its items a context with this view, so each item's single form, which takes the
 * lock itself, runs inside the batch's span instead of queueing behind it (the lock is not reentrant) and no other
 * mutation from this server can run between two items.
 */
export class HeldLock extends MutationLock {
  override async run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
