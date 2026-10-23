/**
 * KB-27 (part): read the console's top dialog and press one of its buttons (DIALOG.md "KB-27").
 *
 *   gma3_dialog   action read: the top modal's class, title, message and buttons (read-only)
 *                 action press: one button, named by its text, only while the dialog still shows the title and/or
 *                 message the caller read; then the dialog is read again and the result says whether it closed
 *
 * Bridge ops dialog.read / dialog.press (0.40.0). Console facts (KB-25, live onPC 2.5.1): GetTopModal returns the
 * dialog; a MessageBox names its parts Title and Text and its buttons generically, so a button is known by its text;
 * a Mouse click at the button's centre presses it; afterwards the modal is gone and LastCommand reads OK / User
 * Canceled / Failed, which does not name the button, so the effect is checked on the target object. A Lua Confirm()
 * (Show Start's Position Wizard, macro 5002) is a MessageBox without a title: "Are you sure ...?" with OK and Cancel.
 *
 * Not done (KB-27): binding a dialog by its UI object (a HookDelete token), keys and text input, overlays.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { asRead, buildResult, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator } from "../validate.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";

export interface DialogRow {
  class?: string;
  name?: string;
  title?: string;
  text?: string;
  display?: number;
  buttons: Array<{ text: string; enabled: boolean }>;
  incomplete?: string;
}

export interface DialogRead {
  open: boolean;
  modal: DialogRow | false;
  lastCommand?: string;
}

const POLL_TRIES = 15;
const POLL_MS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readDialog(bridge: Gma3Bridge, t: number): Promise<DialogRead> {
  return (await bridge.request("dialog.read", {}, t)) as DialogRead;
}

/** One line for a summary: the title or the message, and the buttons. */
export function describeDialog(d: DialogRow): string {
  const what = d.title ? `"${d.title}"` : d.text ? `"${d.text.length > 80 ? `${d.text.slice(0, 77)}...` : d.text}"` : `a ${d.class ?? "dialog"}`;
  return `${what} (buttons: ${d.buttons.map((b) => b.text + (b.enabled ? "" : " (disabled)")).join(", ") || "none"})`;
}

const sameDialog = (a: DialogRow, b: DialogRow) => a.class === b.class && (a.title ?? "") === (b.title ?? "") && (a.text ?? "") === (b.text ?? "");

interface PressArgs {
  action?: unknown;
  button?: unknown;
  expect_title?: unknown;
  expect_text?: unknown;
  exclusive?: unknown;
}

export async function pressDialog(ctx: ToolContext, raw: PressArgs): Promise<OperationResult> {
  const op = "dialog_press";
  const v = new Validator();
  const button = typeof raw.button === "string" && raw.button !== "" ? raw.button : (v.fail("button (the button's text, as action read lists it) is required"), undefined);
  const title = raw.expect_title === undefined ? undefined : typeof raw.expect_title === "string" ? raw.expect_title : (v.fail("expect_title must be text"), undefined);
  const text = raw.expect_text === undefined ? undefined : typeof raw.expect_text === "string" ? raw.expect_text : (v.fail("expect_text must be text"), undefined);
  if (title === undefined && text === undefined) v.fail('expect_title or expect_text is required: what action read reported for the dialog ("" for a dialog without a title), so a different dialog is never answered');
  if (raw.exclusive !== true) v.fail("exclusive must be true: pressing a dialog button acts on the console (nobody else may operate it meanwhile), and what the button does cannot be undone from here");
  const target: Record<string, unknown> = { button: raw.button, ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { text } : {}) };
  if (!v.ok || button === undefined) return validationFailure(op, target, v.errors);
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;

  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    let before: DialogRead;
    try {
      before = await readDialog(bridge, t);
    } catch (err) {
      const s = asRead(stepFromError("read_dialog", err, { op: "dialog.read" }));
      if (err instanceof BridgeError && /unknown op/.test(err.message)) s.error = `${s.error}: the console runs an older bridge plugin without dialog ops (bridge 0.40.0); update the plugin`;
      steps.push(s);
      return buildResult({ operation: op, target, steps, summary: `nothing was pressed: ${s.error}` });
    }
    const d = before.modal;
    const problem = !d
      ? "no dialog is open"
      : d.incomplete
        ? `the dialog could only be read in part (${d.incomplete}), so it cannot be identified`
      : title !== undefined && (d.title ?? "") !== title
        ? `the open dialog's title is ${JSON.stringify(d.title ?? "")}, not ${JSON.stringify(title)}`
        : text !== undefined && (d.text ?? "").replace(/\s+/g, " ").trim() !== text.replace(/\s+/g, " ").trim()
          ? `the open dialog's message is ${JSON.stringify(d.text ?? "")}, not the one expected`
          : !d.buttons.some((b) => b.text === button)
            ? `the dialog has no button ${JSON.stringify(button)} (it has ${d.buttons.map((b) => JSON.stringify(b.text)).join(", ") || "none"})`
            : !d.buttons.some((b) => b.text === button && b.enabled)
              ? `the button ${JSON.stringify(button)} is disabled`
              : null;
    steps.push(asRead({ name: "read_dialog", status: problem ? "failed" : "succeeded", op: "dialog.read", ...(problem ? { error: problem } : {}), detail: before }));
    if (problem || !d) return buildResult({ operation: op, target, steps, summary: `nothing was pressed: ${problem}`, extra: { dialog: before.modal } });

    let press: StepResult;
    try {
      // The bridge checks the whole dialog just read (class, title and message), not only the caller's expectations: a
      // dialog replaced in between by another with the same title is never answered.
      const res = await bridge.request("dialog.press", { button, exclusive: true, ...(d.class !== undefined ? { expectClass: d.class } : {}), expectTitle: d.title ?? "", expectText: d.text ?? "" }, t);
      press = { name: "press", status: "succeeded", op: "dialog.press", detail: res };
    } catch (err) {
      press = stepFromError("press", err, { op: "dialog.press" });
      // A click that failed after the mouse went down may have acted: unknown, and the dialog is read again below.
      if (err instanceof BridgeError && err.code === "press-uncertain") press.status = "unknown";
    }
    steps.push(press);
    if (press.status === "failed") {
      return buildResult({ operation: op, target, steps, summary: `nothing was pressed: ${press.error}`, extra: { dialog: d } });
    }

    // The outcome from a re-read: closed, replaced by another dialog, or still open.
    let after: DialogRead | undefined;
    let readError: string | undefined;
    for (let i = 0; i < POLL_TRIES; i++) {
      await sleep(POLL_MS);
      try {
        after = await readDialog(bridge, t);
        readError = undefined;
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!after.modal || !sameDialog(after.modal, d)) break;
    }
    // Only the last poll counts: an earlier snapshot followed by failed reads is stale (the dialog may have closed since).
    const lastOk = after !== undefined && readError === undefined;
    const state = !lastOk ? "unknown" : !after!.modal ? "closed" : sameDialog(after!.modal, d) ? "still_open" : "replaced";
    steps.push(asRead({ name: "read_after", status: lastOk ? "succeeded" : "unknown", op: "dialog.read", ...(lastOk ? { detail: after } : { error: readError, detail: { staleSnapshot: after ?? null } }) }));
    const checked = `the dialog after pressing ${JSON.stringify(button)}`;
    const verification: Verification =
      state === "closed"
        ? { status: "matched", checked, detail: `the dialog closed; last command: ${after?.lastCommand ?? "unknown"}` }
        : state === "replaced"
          ? { status: "matched", checked, detail: `another dialog is open now: ${describeDialog(after!.modal as DialogRow)}` }
          : state === "still_open"
            ? { status: "mismatched", checked, detail: `the same dialog is still open ${(POLL_TRIES * POLL_MS) / 1000} s after the click` }
            : unavailable(`the dialog could not be read after the click (${readError})`, checked);
    const result = buildResult({
      operation: op,
      target,
      steps,
      verification,
      summary:
        (press.status === "unknown" ? `The click was not confirmed (${press.error}). ` : "") +
        (state === "closed"
          ? `Pressed ${JSON.stringify(button)} on ${describeDialog(d)}; the dialog closed (last command: ${after?.lastCommand ?? "unknown"}). The last command does not name the button: check the effect on the object the dialog was about.`
          : state === "replaced"
            ? `Pressed ${JSON.stringify(button)} on ${describeDialog(d)}; another dialog opened: ${describeDialog(after!.modal as DialogRow)}.`
            : state === "still_open"
              ? `Clicked ${JSON.stringify(button)} on ${describeDialog(d)}, but the dialog is still open.`
              : `Clicked ${JSON.stringify(button)}; the dialog could not be read afterwards.`),
      warnings: ["what a dialog button does has no undo from here"],
      extra: { dialog: d, after: lastOk ? (after?.modal ?? null) : null, state, lastCommand: lastOk ? (after?.lastCommand ?? null) : null },
    });
    return result;
  });
}

export const registerDialogTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_dialog",
    {
      title: "Read or answer the console's open dialog",
      description:
        "For a dialog no structured tool answers, e.g. a macro's Lua Confirm() (gma3_run_macro reports an open dialog). action read (read-only): the top modal's class, title, message and buttons (text, enabled), or open: false. " +
        "action press: clicks one button, named by its exact text, after checking that the open dialog still shows expect_title and/or expect_text as read returned them (\"\" for a dialog without a title) and that the button is there and enabled; a different dialog is never answered. " +
        "Then the dialog is read again: closed, replaced by another dialog, or still open, with the console's last command (which does not name the button: check the effect on the object). Requires exclusive: true for press. " +
        "What a button does has NO UNDO. Buttons that delete, overwrite, load a show or discard changes are pressed only because the call names them: read the message first. Tools that open their own dialogs (gma3_save_show, gma3_patch_move) answer them themselves. Needs bridge 0.40.0.",
      inputSchema: {
        action: z.enum(["read", "press"]),
        button: z.string().optional().describe("press: the button's text exactly as read lists it, e.g. \"OK\"."),
        expect_title: z.string().optional().describe("press: the dialog's title as read returned it (\"\" when it has none)."),
        expect_text: z.string().optional().describe("press: the dialog's message as read returned it (whitespace is compared collapsed)."),
        exclusive: z.boolean().optional().describe("press: required, must be true: nobody else operates the console meanwhile."),
      },
    },
    async (args) => {
      if (args.action === "read") {
        return json(await readDialog(ctx.bridge, ctx.requestTimeoutMs));
      }
      return operation(() => pressDialog(ctx, args));
    },
  );
};
