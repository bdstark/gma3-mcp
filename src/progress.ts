/**
 * MCP progress notifications for long tool calls (#145). A client that sends a `progressToken` with a tools/call gets
 * `notifications/progress` while the call runs, so a client that resets its timeout on progress keeps waiting for a big
 * build instead of giving up while the console is still working (the 72-part gma3_store_recipe_cues of 2026-11-03 timed
 * out in the client but finished on the console).
 *
 * Two sources, one monotonic value per call:
 * - units: a batch item, a cooked cue part, a patch chunk finished (`progressSteps`). The value is the number of
 *   units finished so far; `total` is sent while the running counter knows it and the count has not passed it.
 * - beats: every bridge request the call makes, and every few seconds while one is waiting for its reply
 *   (`progressBeat`, called by Gma3Bridge.request). A beat moves the value by a fraction that stays below the next
 *   unit, so the value always increases (the protocol requires it) and never claims a unit that did not finish.
 *
 * Without a progressToken nothing is sent. Sending is best effort: a failed notification is ignored and never fails
 * the tool.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The part of the SDK's request handler `extra` this module needs. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
}

/** Beats are sent at most this often (ms); units at most every UNIT_MIN_MS unless it is the last one. */
export const BEAT_MIN_MS = 1000;
export const UNIT_MIN_MS = 200;
/** While one bridge request waits for its reply, a beat this often (ms). */
export const PENDING_BEAT_MS = 5000;

interface Scope {
  token: string | number;
  send: NonNullable<ProgressExtra["sendNotification"]>;
  units: number;
  beats: number;
  total?: number;
  last: number;
  lastSentAt: number;
  message?: string;
  /** A progressSteps counter owns the units (see progressSteps). */
  owned?: boolean;
}

const scope = new AsyncLocalStorage<Scope | undefined>();

/** Run `fn` with the progress token of this tools/call, if the client sent one. */
export function withProgress<T>(extra: unknown, fn: () => T): T {
  const e = extra as ProgressExtra | undefined;
  const token = e?._meta?.progressToken;
  if ((typeof token !== "string" && typeof token !== "number") || typeof e?.sendNotification !== "function") return scope.run(undefined, fn);
  return scope.run({ token, send: e.sendNotification.bind(e), units: 0, beats: 0, last: -1, lastSentAt: Number.NEGATIVE_INFINITY }, fn);
}

/** Does the running tool call report progress? */
export function progressActive(): boolean {
  return scope.getStore() !== undefined;
}

function send(s: Scope, value: number, message: string | undefined, force: boolean, minMs: number): void {
  const now = Date.now();
  if (value <= s.last) return;
  if (!force && now - s.lastSentAt < minMs) return;
  s.last = value;
  s.lastSentAt = now;
  const params: Record<string, unknown> = { progressToken: s.token, progress: value };
  // The total goes only with a value that does not pass it: a beat after the last unit (a clean-up request) has none.
  if (s.total !== undefined && value <= s.total) params.total = s.total;
  if (message) params.message = message;
  s.send({ method: "notifications/progress", params }).catch(() => undefined);
}

export interface ProgressSteps {
  /** One step finished: a unit when this counter owns the call's progress, a beat with the message when nested. */
  step(message?: string): void;
  /** The counter is done: a later counter in the same call may own the progress again. */
  end(): void;
}

/**
 * A counter of `total` steps (a batch's items, a cook's targets, a patch edit's chunks). The outermost counter of a
 * call owns the progress: its steps are units, and the total sent is the units already finished plus its own total (a
 * call that writes 72 cue parts and then cooks them reports 0..72 of 72, then 72..144 of 144). A counter started inside
 * another (the cue stores of one item of a gma3_store_cues batch) reports its steps as beats with their message, so
 * the owner's count stays right.
 */
export function progressSteps(total?: number): ProgressSteps {
  const s = scope.getStore();
  if (!s) return { step: () => undefined, end: () => undefined };
  if (s.owned) return { step: (message) => progressBeat(message), end: () => undefined };
  s.owned = true;
  s.total = total !== undefined && Number.isFinite(total) && total > 0 ? s.units + total : undefined;
  let ended = false;
  return {
    step: (message) => {
      if (ended) return progressBeat(message);
      s.units += 1;
      s.beats = 0;
      s.message = message;
      send(s, s.units, message, s.total !== undefined && s.units >= s.total, UNIT_MIN_MS);
    },
    end: () => {
      if (ended) return;
      ended = true;
      s.owned = false;
      // The counter's total is over: what follows (read-backs, clean-up) is reported without one.
      s.total = undefined;
    },
  };
}

/** The call is still working (a bridge request sent, or still waiting for one): a fraction toward the next unit. */
export function progressBeat(message?: string): void {
  const s = scope.getStore();
  if (!s) return;
  s.beats += 1;
  send(s, s.units + 1 - 1 / (s.beats + 1), message ?? s.message, false, BEAT_MIN_MS);
}

/**
 * Beats every PENDING_BEAT_MS until the returned function is called: for one long bridge request (a cook, a patch
 * edit) that would otherwise send nothing until its reply. A no-op without a progress token.
 */
export function beatWhilePending(message: () => string): () => void {
  const s = scope.getStore();
  if (!s) return () => undefined;
  const timer = setInterval(() => scope.run(s, () => progressBeat(message())), PENDING_BEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
