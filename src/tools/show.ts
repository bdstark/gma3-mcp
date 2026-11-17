/**
 * SU-20: save the show (SETUP.md SU-20, docs/probes/su-20-save-show-macos-2.5.1.md).
 *
 *   gma3_show_files   read-only: the current show, the shows folder and its .show files (size, time)
 *   gma3_save_show    saves under the current name or a new one; refuses to overwrite another show's file unless
 *                     overwrite: true; answers SaveShow's own confirmation; reports the file written (size, time)
 *   gma3_load_show    loads a show from the shows folder, answers the unsaved-changes question as asked, and restarts
 *                     the bridge the load unloaded (OSC); verified by the new bridge naming the show
 *                     (docs/probes/load-show-macos-2.5.1.md)
 *
 * Bridge ops show.files / show.save / show.answer (0.35.0). Console facts (onPC 2.5.1, live 2026-10-16):
 *   - SaveShow is sent with CmdIndirect: a dialog opened from the plugin thread would stall the bridge.
 *   - Under the current name it writes at once, with no dialog.
 *   - Under a new name it asks "Change show file name?" (OK / Cancel); under the name of another existing file it asks
 *     "Change show file name and overwrite existing show file?". OK writes at once and makes that name current.
 *   - DirList reports the local wall-clock time as if it were UTC; the bridge corrects it (time) and keeps the
 *     wall-clock text (localTime).
 */
import { z } from "zod";
import { BridgeError, BridgeUnreachableError, type Gma3Bridge } from "../bridge.js";
import { asRead, buildResult, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { runAfterSaveHook } from "../afterSave.js";

export interface ShowFile {
  name: string;
  file?: string;
  size?: number | null;
  time?: number | null;
  localTime?: string | null;
}
export interface Modal {
  class?: string;
  name?: string;
  title?: string;
  text?: string;
  buttons?: string[];
  display?: number;
}
export interface ShowFiles {
  current?: string | null;
  path?: string;
  listed?: boolean;
  files: ShowFile[];
  now?: number;
  localNow?: string;
  modal?: Modal | false;
  /** false when the bridge could not read whether a dialog is open (never taken for "no dialog"). */
  modalKnown?: boolean;
  modalError?: string;
}

export const RENAME_TITLE = "Change show file name?";
export const OVERWRITE_TITLE = "Change show file name and overwrite existing show file?";
/**
 * Each SaveShow dialog's message around the show name (live). The framing is compared with whitespace collapsed (it
 * wraps); the name between the first and the last quote exactly, apostrophes and every space kept: "Joe's Show" is not
 * "s Show" and "Show  B" is not "Show B" (reviews of PR #66). The framing has no quote of its own.
 */
export const DIALOG_FRAME: Record<string, [string, string]> = {
  [RENAME_TITLE]: ["Do you intend to change the show file name to", "?"],
  [OVERWRITE_TITLE]: ["You are going to change the show file name and overwrite the file with the name", "that already exists. Do you want to continue ?"],
};
const squash = (t: string) => t.replace(/\s+/g, " ").trim();
/** The show name a dialog's message names, or null when the message is not the expected one. */
export function dialogTarget(title: string, text: unknown): string | null {
  const frame = DIALOG_FRAME[title];
  if (!frame || typeof text !== "string") return null;
  const first = text.indexOf("'");
  const last = text.lastIndexOf("'");
  if (first < 0 || last <= first) return null;
  if (squash(text.slice(0, first)) !== frame[0] || squash(text.slice(last + 1)) !== frame[1]) return null;
  return text.slice(first + 1, last);
}
const NEEDS_BRIDGE = "the console runs an older bridge plugin without the show ops (bridge 0.35.0); update the plugin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 150;

export async function readShowFiles(bridge: Gma3Bridge, t: number): Promise<ShowFiles> {
  try {
    const r = (await bridge.request("show.files", {}, t)) as ShowFiles;
    return { ...r, files: Array.isArray(r.files) ? r.files : [] };
  } catch (err) {
    if (err instanceof Error && /unknown op/i.test(err.message)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
}

/** Show names compare like the file system on macOS and Windows: case-insensitively. */
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const iso = (epoch: number | null | undefined) => (typeof epoch === "number" ? new Date(epoch * 1000).toISOString() : null);
const fileView = (f: ShowFile | undefined) => (f ? { name: f.name, file: f.file, size: f.size ?? null, time: iso(f.time), localTime: f.localTime ?? null } : null);

/**
 * The longest show name SaveShow keeps. Live (onPC 2.5.1, 2026-10-29): `SaveShow "Halloween 2026 Creative pre-slots"`
 * (33) asked to change the name to "Halloween 2026 Creative pre-slot" (32), so the dialog never named the requested show
 * and was left open. The 2.5.1 help says 31; the console kept 32. Only ASCII was seen, so a name with other characters
 * is counted in UTF-8 bytes: a refusal is better than a cut name.
 */
export const SHOW_NAME_MAX = 32;
/** A show name as SaveShow takes it; ".show" is dropped. Throws a readable reason. */
export function showName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("name must be text");
  const n = raw.replace(/\.show$/i, "");
  if (!n || /[\u0000-\u001f"/\\:*?<>|]/.test(n) || n !== n.trim()) {
    throw new Error('name must be 1-32 characters without quotes, slashes, \\ : * ? < > | or control characters, and without leading or trailing spaces');
  }
  const bytes = Buffer.byteLength(n, "utf8");
  if (bytes > SHOW_NAME_MAX) {
    const ascii = bytes === n.length;
    const size = ascii ? `${n.length} characters` : `${n.length} characters, ${bytes} bytes in UTF-8 (outside ASCII the tool counts bytes)`;
    const cut = ascii ? ` (SaveShow would ask about "${n.slice(0, SHOW_NAME_MAX)}" instead)` : "";
    throw new Error(`name "${n}" is ${size}; the console keeps at most ${SHOW_NAME_MAX} and cuts the rest${cut}, so choose a shorter name`);
  }
  return n;
}

export async function saveShow(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "save_show";
  const errors: string[] = [];
  let name: string | undefined;
  if (raw.name !== undefined) {
    try {
      name = showName(raw.name);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (raw.overwrite !== undefined && typeof raw.overwrite !== "boolean") errors.push("overwrite must be true or false");
  const timeoutMs = raw.timeout_ms === undefined ? 20000 : typeof raw.timeout_ms === "number" && raw.timeout_ms >= 2000 && raw.timeout_ms <= 120000 ? raw.timeout_ms : (errors.push("timeout_ms must be 2000-120000"), 20000);
  if (raw.exclusive !== true) errors.push("exclusive must be true: the show file is written (an existing file is replaced) and the console's current show name may change; nobody else may load or save shows while it runs");
  const target = { name: name ?? "current show", overwrite: raw.overwrite === true };
  if (errors.length) return validationFailure(op, target, errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let before: ShowFiles;
    try {
      before = await readShowFiles(ctx.bridge, t);
      steps.push(asRead({ name: "read_show_files", status: "succeeded", op: "show.files", detail: { current: before.current, files: before.files.length } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_show_files", err, { op: "show.files" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
    }
    const refuse = (why: string, extra: Record<string, unknown> = {}) => {
      steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was saved` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was saved"), extra: { current: before.current ?? null, ...extra } });
    };
    if (before.modalKnown === false) return refuse(`whether a dialog is open cannot be read (${before.modalError ?? "unknown"})`);
    if (before.modal) return refuse(`a dialog is open on the console (${before.modal.title ?? before.modal.name ?? before.modal.class}); close it first`, { modal: before.modal });
    if (!before.current) return refuse("the console's current show name cannot be read");
    if (!before.listed) return refuse("the shows folder cannot be listed, so an existing file cannot be ruled out");
    const to = name ?? before.current;
    const existing = before.files.find((f) => same(f.name, to));
    const isCurrent = same(to, before.current);
    // The dialog SaveShow will open: none (current name), rename (new file), overwrite (another existing file).
    const expect = isCurrent ? null : existing ? OVERWRITE_TITLE : RENAME_TITLE;
    if (existing && !isCurrent && raw.overwrite !== true) {
      return refuse(`"${existing.name}" is another show's file (${existing.size ?? "?"} bytes, saved ${existing.localTime ?? "?"}); saving would replace it and make it the current show. Pass overwrite: true to replace it, or choose a new name`, { existing: fileView(existing) });
    }

    // A write is proven only by a file this save produced: a new file, or one with a later time than before. File times
    // have whole seconds, so when the existing file is from the console's current second, wait until the clock has
    // passed it (review of PR #66: an unchanged recent file is never proof).
    if (existing && typeof existing.time === "number" && typeof before.now === "number" && existing.time >= before.now - 1) {
      await sleep(Math.min(2500, (existing.time - before.now + 1) * 1000 + 300));
    }
    const proves = (f: ShowFile | undefined) => !!f && typeof f.time === "number" && (!existing || f.time > (existing.time ?? Number.POSITIVE_INFINITY) || (typeof f.size === "number" && f.size !== existing.size && f.time >= (existing.time ?? 0)));

    let queueUncertain = false;
    try {
      const sent = (await ctx.bridge.request("show.save", { ...(isCurrent ? {} : { name: to }), exclusive: true }, t)) as { command?: string };
      steps.push({ name: "save", status: "succeeded", op: "show.save", command: sent.command, detail: { queued: true } });
    } catch (err) {
      const step = stepFromError("save", err, { op: "show.save" });
      steps.push(step);
      if (step.status !== "unknown") return buildResult({ operation: op, target, steps, verification: unavailable("the bridge refused SaveShow: it was not queued") });
      // The request went out and its answer was lost: the save may still run. It is not resent; it is watched.
      queueUncertain = true;
    }

    // Poll: answer only SaveShow's own dialog naming this show, stop at any other dialog, finish when a file this save
    // produced is there and current. Only the latest read counts: a failed read is a gap, never the old snapshot.
    const t0 = Date.now();
    let answered = false;
    let last: ShowFiles | undefined;
    let lastOk = false;
    let foreign: Modal | undefined;
    let unknownModal: string | undefined;
    let unread = 0;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(POLL_MS);
      let now: ShowFiles;
      try {
        now = await readShowFiles(ctx.bridge, t);
      } catch {
        unread++;
        lastOk = false;
        continue;
      }
      last = now;
      lastOk = true;
      if (now.modalKnown === false) {
        unknownModal = now.modalError ?? "unknown";
        continue;
      }
      unknownModal = undefined;
      if (now.modal) {
        const ours = !answered && expect && now.modal.title === expect && dialogTarget(expect, now.modal.text) === to;
        if (ours) {
          try {
            await ctx.bridge.request("show.answer", { expectTitle: expect, expectTarget: to, button: "OK", exclusive: true }, t);
            answered = true;
            steps.push({ name: "confirm", status: "succeeded", op: "show.answer", detail: { title: expect, text: now.modal.text ?? null, clicked: "OK" } });
          } catch (err) {
            steps.push(stepFromError("confirm", err, { op: "show.answer", detail: { title: expect, target: to } }));
            break;
          }
          continue;
        }
        foreign = now.modal;
        break;
      }
      const f = now.files.find((x) => same(x.name, to));
      if (proves(f) && same(now.current, to)) break;
    }
    // A final read when the last attempt failed: completion is judged from a current observation or not at all.
    if (!foreign && !lastOk && last) {
      try {
        last = await readShowFiles(ctx.bridge, t);
        lastOk = true;
      } catch {
        unread++;
      }
    }

    const after = lastOk ? last : undefined;
    const written = after?.files.find((x) => same(x.name, to));
    const fresh = proves(written);
    const checked = `${to}.show written by this save (new, or a later time than ${existing?.localTime ?? "before"}) and current`;
    let verification: Verification;
    if (foreign) {
      const otherTarget = foreign.title === expect;
      steps.push({ name: "wait", status: "unknown", error: `${otherTarget ? `a "${foreign.title}" dialog for another show` : `an unexpected dialog (${foreign.title ?? foreign.name ?? foreign.class})`} is open; it was not answered: answer it at the console`, detail: { modal: foreign } });
      verification = unavailable(`an unexpected dialog is open on the console: ${foreign.title ?? foreign.name}${foreign.text ? ` (${foreign.text})` : ""}`, checked);
    } else if (!after) {
      steps.push({ name: "wait", status: "unknown", error: `the shows folder could not be read at the end${last ? ` (last read: ${same(last.current, to) ? "current" : `current ${last.current}`})` : ""}; whether the save completed is unknown` });
      verification = unavailable("the save's completion could not be observed (the shows folder could not be read)", checked);
    } else if (fresh && same(after.current, to)) {
      verification = { status: "matched", checked, expected: { file: `${to}.show`, current: to }, actual: { ...fileView(written), current: after.current } };
    } else if (unknownModal) {
      steps.push({ name: "wait", status: "unknown", error: `whether a dialog is open cannot be read (${unknownModal}); nothing was answered` });
      verification = unavailable(`the dialog state could not be read (${unknownModal})`, checked);
    } else if (queueUncertain || (expect && !answered)) {
      steps.push({ name: "wait", status: "unknown", error: queueUncertain ? `the reply to SaveShow was lost and no write was seen within ${timeoutMs} ms; SaveShow was not resent and may still run (check gma3_show_files)` : `the expected dialog "${expect}" did not appear within ${timeoutMs} ms` });
      verification = unavailable(queueUncertain ? "SaveShow may have been queued (its reply was lost); no write was seen" : `no confirmation dialog appeared and no write was seen within ${timeoutMs} ms`, checked);
    } else {
      verification = {
        status: "mismatched",
        checked,
        expected: { file: `${to}.show`, current: to, writtenAfter: existing?.localTime ?? null },
        actual: { file: fileView(written), current: after.current ?? null },
        detail: !written ? `${to}.show is not in the shows folder after ${timeoutMs} ms` : !fresh ? `${to}.show still carries its earlier time (${written.localTime}) and size` : `the console's current show is ${after.current}, not ${to}`,
      };
    }
    const renamed = !isCurrent && same(after?.current, to);
    // Only a verified write starts the after-save hook (e.g. a git checkpoint of the show file); it never blocks the save.
    // The file the console wrote (names compare case-insensitively, so it can differ from the requested spelling).
    const afterSave = verification.status === "matched" ? await runAfterSaveHook(written?.name ?? after?.current ?? to, before.path) : undefined;
    return buildResult({
      operation: op,
      target: { ...target, name: to },
      steps,
      verification,
      summary:
        verification.status === "matched"
          ? `Saved ${to}.show (${written?.size ?? "?"} bytes, ${written?.localTime ?? "?"} console time)${renamed ? `; the current show is now ${to} (was ${before.current})` : ""}${existing && !isCurrent ? `; it replaced the earlier ${to}.show` : ""}.`
          : undefined,
      warnings: [
        ...(renamed ? [`the console's current show is now ${to}: later saves without a name write ${to}.show, not ${before.current}.show`] : []),
        ...(unread ? [`${unread} read(s) of the shows folder failed while waiting`] : []),
        ...(queueUncertain ? ["the reply to SaveShow was lost: it was not resent"] : []),
        ...(afterSave && !afterSave.started ? [`the after-save hook ${afterSave.hook} did not start: ${afterSave.error}`] : []),
      ],
      extra: {
        file: fileView(written),
        previous: { current: before.current, file: fileView(existing) },
        current: after?.current ?? null,
        ...(!after && last ? { lastObserved: { current: last.current ?? null, file: fileView(last.files.find((x) => same(x.name, to))), note: "an earlier read, not the final state" } } : {}),
        ...(expect ? { dialog: { expected: expect, answered } } : { dialog: "none (the current name saves without a dialog)" }),
        path: before.path,
        ...(afterSave ? { afterSave } : {}),
      },
    });
  });
}

/**
 * LoadShow with unsaved changes asks this first (live, onPC 2.5.1): "Warning" / "Show file '<current>' has changed!
 * Do you want to save the old show file first?" with Save / Do not save / Cancel.
 */
export const UNSAVED_TITLE = "Warning";
export const unsavedText = (current: string) => `Show file '${current}' has changed! Do you want to save the old show file first?`;
const UNSAVED_BUTTON = { refuse: "Cancel", save: "Save", discard: "Do not save" } as const;
type Unsaved = keyof typeof UNSAVED_BUTTON;
const BRIDGE_COMMAND = 'Plugin "gma3_mcp_bridge"';

/**
 * Pacing of gma3_load_show (tests shorten it). The bridge answers until the load unloads it; afterwards the old socket
 * stays open without answers (live: timeouts, later "connection refused"), so every probe after the load is a fresh
 * connection with a short timeout.
 */
export const LOAD_TIMING = { pollMs: 150, probeMs: 1500, dialogPhaseMs: 15000, settleMs: 3000, retryMs: 2000 };

/** "0.45.0" -> [0, 45, 0]; anything else -> null. */
const semver = (v: unknown) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
const older = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A failure that says nothing reached or came back from the bridge (as opposed to an error reply from a live bridge). */
const silent = (err: unknown) => err instanceof BridgeUnreachableError || (err instanceof BridgeError && err.dispatched);
const DEFAULT_BRIDGE_PORT = 9800;
type Restart = "auto" | "keystroke" | "osc" | "none";

export async function loadShow(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "load_show";
  const errors: string[] = [];
  let name: string | undefined;
  try {
    name = showName(raw.name);
  } catch (err) {
    errors.push((err as Error).message);
  }
  const unsaved = (raw.unsaved ?? "refuse") as Unsaved;
  if (!(unsaved in UNSAVED_BUTTON)) errors.push("unsaved must be refuse, save or discard");
  const restart = (raw.restart ?? "auto") as Restart;
  if (!["auto", "keystroke", "osc", "none"].includes(restart)) errors.push("restart must be auto, keystroke, osc or none");
  const timeoutMs = raw.timeout_ms === undefined ? 120000 : typeof raw.timeout_ms === "number" && raw.timeout_ms >= 5000 && raw.timeout_ms <= 300000 ? raw.timeout_ms : (errors.push("timeout_ms must be 5000-300000"), 120000);
  if (raw.exclusive !== true) errors.push("exclusive must be true: the console's show is replaced (with unsaved: discard its changes are lost) and the bridge is stopped and restarted; nobody else may use the console while it runs");
  const target = { name: name ?? String(raw.name ?? ""), unsaved, restart };
  if (errors.length) return validationFailure(op, target, errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const probe = Math.min(t, LOAD_TIMING.probeMs);
    const steps: StepResult[] = [];
    const warnings: string[] = [];

    // How the bridge is started after the load; decided before anything is sent.
    let sender: { sendCommand(command: string): Promise<void>; readonly description: string } | undefined;
    let via: "keystroke" | "osc" | "none" = "none";
    // Keystrokes go to whatever has onPC's keyboard focus (live: once a filter field), so they are used only when asked
    // for by name; auto means OSC when this server has an OSC sender, otherwise an operator starts the bridge.
    if (restart === "keystroke") {
      const ok = ctx.keystroke ? await ctx.keystroke.available().catch(() => false) : false;
      if (ok) [sender, via] = [ctx.keystroke, "keystroke"];
      else return validationFailure(op, target, ["restart keystroke needs macOS with onPC running on this machine (process app_gma3); use osc or none"]);
    }
    if (!sender && (restart === "osc" || restart === "auto")) {
      if (ctx.oscCommand) [sender, via] = [ctx.oscCommand, "osc"];
      else if (restart === "osc") return validationFailure(op, target, ["this server has no OSC sender; use keystroke or none"]);
    }
    let before: ShowFiles;
    let instance: unknown;
    let saveNeeded: boolean | undefined;
    // The port the console's bridge listens on (ping), not this client's: through a tunnel (GMA3_BRIDGE_PORT=19800
    // forwarded to 9800, docs/remote-access.md) the restart must reopen 9800 (review of #133).
    let consolePort = ctx.bridge.port;
    try {
      before = await readShowFiles(ctx.bridge, t);
      const ping = (await ctx.bridge.request("ping", {}, t)) as { instance?: unknown; port?: unknown; show?: { saveNeeded?: unknown } };
      instance = ping.instance;
      if (typeof ping.port === "number" && Number.isInteger(ping.port) && ping.port > 0) consolePort = ping.port;
      if (typeof ping.show?.saveNeeded === "boolean") saveNeeded = ping.show.saveNeeded;
      steps.push(asRead({ name: "read_show_files", status: "succeeded", op: "show.files", detail: { current: before.current, files: before.files.length, instance: instance ?? null, saveNeeded: saveNeeded ?? null } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_show_files", err, { op: "show.files" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
    }
    const startCommand = consolePort && consolePort !== DEFAULT_BRIDGE_PORT ? `${BRIDGE_COMMAND} "${consolePort}"` : BRIDGE_COMMAND;
    const refuse = (why: string, extra: Record<string, unknown> = {}) => {
      steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was loaded` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was loaded"), extra: { current: before.current ?? null, ...extra } });
    };
    if (before.modalKnown === false) return refuse(`whether a dialog is open cannot be read (${before.modalError ?? "unknown"})`);
    if (before.modal) return refuse(`a dialog is open on the console (${before.modal.title ?? before.modal.name ?? before.modal.class}); close it first`, { modal: before.modal });
    if (!before.current) return refuse("the console's current show name cannot be read, so its unsaved-changes question could not be recognised");
    if (!before.listed) return refuse("the shows folder cannot be listed");
    if (typeof instance !== "string") return refuse("the running bridge does not name its instance (bridge 0.54.0), so its restart could not be told apart from it; update the plugin");
    // NeedShowSave (bridge 0.53.0) answers before anything is sent; the question is still handled below when it is unknown.
    if (saveNeeded === true && unsaved === "refuse") return refuse(`${before.current} has unsaved changes (NeedShowSave); pass unsaved: save or discard`, { saveNeeded: true });
    const file = before.files.find((f) => same(f.name, name));
    if (!file) return refuse(`${name}.show is not in the shows folder (${before.path ?? "?"}); gma3_show_files lists the shows`);
    const to = file.name;
    const current = before.current;
    const question = squash(unsavedText(current));
    const isQuestion = (m: Modal | false | undefined) => !!m && m.title === UNSAVED_TITLE && typeof m.text === "string" && squash(m.text) === question;
    const done = (verification: Verification, extra: Record<string, unknown> = {}) =>
      buildResult({ operation: op, target: { ...target, name: to }, steps, verification, warnings, extra: { current: before.current ?? null, ...extra } });

    let queueUncertain = false;
    try {
      const sent = (await ctx.bridge.request("show.load", { name: to, exclusive: true }, t)) as { command?: string };
      steps.push({ name: "load", status: "succeeded", op: "show.load", command: sent.command, detail: { queued: true } });
    } catch (err) {
      const step = stepFromError("load", err, { op: "show.load" });
      if (err instanceof Error && /unknown op/i.test(err.message)) step.error = "the console runs an older bridge plugin without show.load (bridge 0.54.0); update the plugin";
      steps.push(step);
      if (step.status !== "unknown") return done(unavailable("the bridge refused LoadShow: it was not queued"));
      queueUncertain = true;
      warnings.push("the reply to LoadShow was lost: it was not resent");
    }

    // Until the load unloads the bridge it still answers. Answer the unsaved-changes question as asked; stop at any
    // other dialog. The bridge counts as gone only after two probes in a row get no answer at all (the second over a
    // fresh connection): an error reply is a live bridge, and one slow frame is not a load.
    let gone = false;
    let answered: string | undefined;
    let answeredAt = 0;
    let foreign: Modal | undefined;
    let misses = 0;
    let phaseStart = Date.now();
    while (Date.now() - phaseStart < LOAD_TIMING.dialogPhaseMs) {
      await sleep(LOAD_TIMING.pollMs);
      let now: ShowFiles;
      try {
        now = await readShowFiles(ctx.bridge, probe);
        misses = 0;
      } catch (err) {
        if (!silent(err)) continue;
        ctx.bridge.close();
        if (++misses >= 2) {
          gone = true;
          break;
        }
        continue;
      }
      if (now.modalKnown === false || !now.modal) continue;
      const m = now.modal;
      if (isQuestion(m) && answered) {
        // The pressed dialog closes on a later frame: the same question stays visible for a moment.
        if (Date.now() - answeredAt < LOAD_TIMING.dialogPhaseMs) continue;
      }
      if (!isQuestion(m) || answered) {
        foreign = m;
        break;
      }
      const button = UNSAVED_BUTTON[unsaved];
      try {
        await ctx.bridge.request("dialog.press", { button, exclusive: true, expectTitle: UNSAVED_TITLE, expectText: m.text, ...(m.class !== undefined ? { expectClass: m.class } : {}) }, t);
        steps.push({ name: "unsaved_changes", status: "succeeded", op: "dialog.press", detail: { title: m.title, text: m.text, clicked: button } });
      } catch (err) {
        const step = stepFromError("unsaved_changes", err, { op: "dialog.press", detail: { title: m.title, text: m.text, button } });
        steps.push(step);
        if (step.status !== "unknown" || unsaved === "refuse") return done(unavailable(`the unsaved-changes question was not answered (${step.error}); answer it at the console`));
        // The press may have gone through and the load begun: watch for the bridge going away.
      }
      answered = button;
      answeredAt = Date.now();
      if (unsaved === "refuse") break;
      phaseStart = Date.now(); // a save before the load takes its own time
    }

    if (answered === UNSAVED_BUTTON.refuse) {
      // Read back that nothing was loaded: the question closed, the same show and the same bridge.
      let after: ShowFiles | undefined;
      let still: unknown;
      const t1 = Date.now();
      while (Date.now() - t1 < LOAD_TIMING.dialogPhaseMs) {
        await sleep(LOAD_TIMING.pollMs);
        try {
          after = await readShowFiles(ctx.bridge, probe);
          still = ((await ctx.bridge.request("ping", {}, probe)) as { instance?: unknown }).instance;
        } catch {
          after = undefined;
          continue;
        }
        if (!isQuestion(after.modal)) break;
      }
      const unchanged = !!after && !after.modal && same(after.current, current) && still === instance;
      steps.push(unchanged
        ? asRead({ name: "read_back", status: "failed", error: `${current} has unsaved changes: Cancel was pressed and nothing was loaded (the same show and bridge answer); pass unsaved: save or discard` })
        : asRead({ name: "read_back", status: "unknown", error: `Cancel was pressed, but ${after ? (after.modal ? `a dialog is still open (${after.modal.title})` : `the console's show is ${after.current} and the bridge ${still === instance ? "is the same" : "is another"}`) : "the bridge does not answer"}: check the console` }));
      const result = done(unchanged ? { status: "matched", checked: "nothing was loaded: the question closed, the same show and bridge answer", expected: { current }, actual: { current: after!.current } } : unavailable("whether the load was cancelled could not be confirmed"), { unsavedAnswer: answered });
      if (unchanged) result.summary = `Not loaded: ${current} has unsaved changes, so Cancel was pressed; read back: ${current} and the same bridge still answer. Pass unsaved: save or discard to load ${to}.`;
      return result;
    }
    if (foreign) {
      steps.push({ name: "wait", status: "unknown", error: `an unexpected dialog (${foreign.title ?? foreign.name ?? foreign.class}) is open; it was not answered: answer it at the console`, detail: { modal: foreign } });
      return done(unavailable(`an unexpected dialog is open on the console: ${foreign.title ?? foreign.name}${foreign.text ? ` (${foreign.text})` : ""}`));
    }
    if (!gone) {
      steps.push({ name: "wait", status: "unknown", error: `the bridge still answers ${LOAD_TIMING.dialogPhaseMs} ms after LoadShow${queueUncertain ? " (its reply was lost)" : ""}${answered ? ` and the answer ${answered}` : ""}; the load has not begun. It was not resent` });
      return done(unavailable("the load was not seen to begin"));
    }
    steps.push({ name: "bridge_stopped", status: "succeeded", detail: { note: "two probes in a row got no answer: the load unloaded the bridge, as expected" } });

    // The new show's bridge: fresh connections only, the start command between probes. An answer from the instance
    // that was running before is not the new show's bridge: keep waiting.
    const t0 = Date.now();
    let ping: Record<string, unknown> | undefined;
    let sends = 0;
    let sendErrors = 0;
    let sendError: string | undefined;
    let oldAnswers = 0;
    // Whether the latest probe was answered by the bridge that was running before. The start command is sent only while
    // that one is silent: once it stops answering (a slow load unloads it late), sending resumes (review of #133).
    let oldAnsweredLast = false;
    ctx.bridge.close();
    await sleep(LOAD_TIMING.settleMs);
    while (Date.now() - t0 < timeoutMs) {
      try {
        const p = (await ctx.bridge.request("ping", {}, probe)) as Record<string, unknown>;
        if (p.instance !== instance) {
          ping = p;
          break;
        }
        oldAnswers++;
        oldAnsweredLast = true;
      } catch {
        ctx.bridge.close();
        oldAnsweredLast = false;
      }
      if (sender && !oldAnsweredLast) {
        try {
          await sender.sendCommand(startCommand);
          sends++;
        } catch (err) {
          sendErrors++;
          sendError = err instanceof Error ? err.message : String(err);
        }
      }
      await sleep(LOAD_TIMING.retryMs);
    }
    const waitedMs = Date.now() - t0;
    const restartDetail = { via: via === "none" ? "none" : `${via} (${sender!.description})`, command: sender ? startCommand : null, sends, sendErrors, ...(sendError ? { sendError } : {}), ...(oldAnswers ? { oldBridgeAnswers: oldAnswers } : {}), waitedMs };
    const checked = `a new bridge answers and the console's show is ${to}`;
    let verification: Verification;
    if (!ping) {
      steps.push({ name: "bridge_restart", status: "unknown", error: `no new bridge answered within ${timeoutMs} ms`, detail: restartDetail });
      const why =
        oldAnsweredLast
          ? "the bridge that was running before still answers: the load may not have happened"
          : via === "none"
            ? "nothing was sent to start it (restart: none)"
            : sends === 0
              ? `every ${via} send failed (${sendError ?? "unknown"})`
              : `${startCommand} was sent ${sends} time(s) by ${via}${sendErrors ? ` (${sendErrors} failed)` : ""}: the loaded show may not contain the bridge plugin${via === "osc" ? ", or may have OSC input with Receive Command off" : ", or onPC's keyboard focus may be in a text field or dialog"}`;
      verification = unavailable(`the loaded show could not be confirmed: ${why}. Start it at the console with ${startCommand}, then check with gma3_status`, checked);
    } else {
      steps.push({ name: "bridge_restart", status: "succeeded", detail: { ...restartDetail, bridgeVersion: ping.bridgeVersion ?? null, instance: ping.instance ?? null } });
      const v = semver(ping.bridgeVersion);
      if (v && older(v, [0, 54, 0]) < 0) warnings.push(`the loaded show carries bridge ${ping.bridgeVersion}: gma3_load_show and the newest tools need 0.54.0; re-import the plugin into this show and save it`);
      if (sends > 0) warnings.push(`the bridge was started with default policies (${startCommand}): Lua, input and control are off; start it with arguments at the console if you need them`);
      const loaded = ping.showfile;
      // Live: Save / Do not save starts the load at once, which unloads the bridge before it replies to dialog.press.
      // A new bridge naming the requested show proves that the press acted.
      const press = steps.find((s) => s.name === "unsaved_changes");
      if (press?.status === "unknown" && same(loaded as string | undefined, to)) {
        press.status = "succeeded";
        press.error = undefined;
        press.detail = { ...(press.detail as object), note: "the reply was lost because the press started the load (it unloaded the bridge); the load that followed proves the press acted" };
      }
      // A LoadShow whose reply was lost (never resent) is proven by the new bridge naming the requested show (review of #133).
      const queued = steps.find((s) => s.name === "load");
      if (queued?.status === "unknown" && same(loaded as string | undefined, to)) {
        queued.status = "succeeded";
        queued.error = undefined;
        queued.detail = { ...((queued.detail as object) ?? {}), note: "the reply was lost; a new bridge naming the requested show proves LoadShow ran (it was not resent)" };
        const i = warnings.indexOf("the reply to LoadShow was lost: it was not resent");
        if (i >= 0) warnings[i] = "the reply to LoadShow was lost (not resent); the load is confirmed by the new bridge";
      }
      if (typeof loaded !== "string") steps.push({ name: "confirm_show", status: "unknown", error: "the new bridge does not name the console's show: check it with gma3_show_files" });
      verification =
        typeof loaded !== "string"
          ? unavailable("the new bridge does not name the console's show", checked)
          : same(loaded, to)
            ? { status: "matched", checked, expected: { current: to }, actual: { current: loaded, bridgeVersion: ping.bridgeVersion ?? null } }
            : { status: "mismatched", checked, expected: { current: to }, actual: { current: loaded }, detail: `the console's show is ${loaded}, not ${to}` };
    }
    const loaded = typeof ping?.showfile === "string" ? (ping.showfile as string) : null;
    return buildResult({
      operation: op,
      target: { ...target, name: to },
      steps,
      verification,
      summary: verification.status === "matched" ? `Loaded ${to} (was ${current}); the bridge is back (${ping?.bridgeVersion ?? "?"}, started by ${via}) after ${Math.round(waitedMs / 1000)} s${answered ? `; the unsaved-changes question was answered with ${answered}` : ""}.` : undefined,
      warnings,
      extra: { previous: current, current: loaded, file: fileView(file), restart: restartDetail, ...(answered ? { unsavedAnswer: answered } : {}) },
    });
  });
}

export const registerShowTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_show_files",
    {
      title: "List the show files",
      description:
        "Read-only. The console's current show, the shows folder and every .show file in it (name, size, time as ISO and as the console's local wall-clock time), newest first, and a dialog when one is open. Use it before gma3_save_show to choose a name that does not replace another show. Needs bridge 0.35.0.",
      inputSchema: {},
    },
    async () => {
      try {
        const s = await readShowFiles(ctx.bridge, ctx.requestTimeoutMs);
        const files = [...s.files].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).map(fileView);
        return json({ tool: "gma3_show_files", current: s.current ?? null, currentFile: fileView(s.files.find((f) => same(f.name, s.current))), path: s.path, listed: s.listed ?? null, count: files.length, files, consoleTime: s.localNow ?? null, ...(s.modal ? { modal: s.modal } : {}) });
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_save_show",
    {
      title: "Save the show file",
      description:
        "Save the show: under the current name (default) or a new name (which becomes the console's current show). A new name is at most 32 characters (the console cuts longer names; non-ASCII counts in UTF-8 bytes) and is refused before anything is sent. Refuses to replace another show's existing file unless overwrite: true, and refuses while a dialog is open. SaveShow is sent so that it cannot stall the bridge; the tool answers SaveShow's own confirmation (\"Change show file name?\", or \"... and overwrite existing show file?\" with overwrite: true) and nothing else. " +
        "Verification: matched when the file carries a time from this save and the console names it current; the result reports the file (size, time). Requires exclusive: true. Use gma3_show_files to see the files first. Needs bridge 0.35.0.",
      inputSchema: {
        name: z.string().optional().describe("Show name (without .show), at most 32 characters. Default: the current show."),
        overwrite: z.boolean().optional().describe("Replace an existing file of another show with this name (default false: refuse)."),
        timeout_ms: z.number().optional().describe("How long to wait for the save (2000-120000, default 20000)."),
        exclusive: z.boolean().optional(),
      },
    },
    async (args) => operation(() => saveShow(ctx, args)),
  );

  server.registerTool(
    "gma3_load_show",
    {
      title: "Load a show file",
      description:
        "Load another show from the shows folder (LoadShow) and bring the bridge back: loading unloads the show's plugins, this bridge included. Refuses while a dialog is open and for a file that is not in the shows folder. " +
        'When the current show has unsaved changes the console asks first; unsaved decides the answer: refuse (default: Cancel, nothing is loaded), save (Save, then load) or discard (Do not save: the changes are lost). ' +
        'After the load the start command  Plugin "gma3_mcp_bridge"  (with the bridge port when it is not 9800) is sent between probes until a new bridge answers. restart: auto (default) sends it over OSC when this server has an OSC sender (the loaded show needs OSC input with Receive Command on, gma3_osc), otherwise waits for an operator to start it; osc requires OSC; keystroke types it into onPC on this Mac (opt-in: macOS, onPC on the same machine, Accessibility permission for the server; the keys go to whatever has onPC\'s focus); none only waits. It works only when the loaded show contains the bridge plugin; the restarted bridge runs with default policies (Lua, input, control off). ' +
        "Verification: matched when a new bridge instance answers and names the requested show (an answer from the bridge that was running before is not counted); when the bridge does not come back within timeout_ms the result says how to start it. When the current bridge reports unsaved changes (bridge 0.53.0+) and unsaved is refuse, nothing is sent. Requires exclusive: true. No undo. Needs bridge 0.54.0 in the current show.",
      inputSchema: {
        name: z.string().describe("Show name (without .show), as gma3_show_files lists it."),
        unsaved: z.enum(["refuse", "save", "discard"]).optional().describe("Answer when the current show has unsaved changes (default refuse)."),
        restart: z.enum(["auto", "keystroke", "osc", "none"]).optional().describe("How the bridge is started after the load (default auto: OSC when configured, else an operator; keystroke is opt-in)."),
        timeout_ms: z.number().optional().describe("How long to wait for the bridge after the load (5000-300000, default 120000)."),
        exclusive: z.boolean().optional(),
      },
    },
    async (args) => operation(() => loadShow(ctx, args)),
  );
};
