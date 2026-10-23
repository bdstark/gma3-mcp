import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.js";
import { BridgeReplyError } from "./helpers/fake-bridge.js";
import { registerDialogTools } from "../src/tools/dialog.js";

/** gma3_dialog against a fake bridge with one open dialog (the bridge ops are covered by test/lua/patch_ops_test.lua). */

const CONFIRM = { class: "MessageBox", name: "MsgBox", text: "Are you sure you want to overwrite positions?", display: 1, buttons: [{ text: "OK", enabled: true }, { text: "Cancel", enabled: true }, { text: "Later", enabled: false }] };

async function setup(after: "close" | "stay" | "replace" = "close") {
  const h = await startHarness(registerDialogTools);
  let modal: unknown = CONFIRM;
  const pressed: Array<Record<string, unknown>> = [];
  h.fake.on("dialog.read", () => ({ open: modal !== false, modal, lastCommand: modal === false ? "OK: Lua" : "OK: Go+ Macro 5002" }));
  h.fake.on("dialog.press", (args) => {
    if (args.exclusive !== true) throw new BridgeReplyError("[not-exclusive] needs exclusive", "not-exclusive");
    pressed.push(args);
    if (after === "close") modal = false;
    else if (after === "replace") modal = { class: "MessageBox", title: "Done", text: "Positions stored", buttons: [{ text: "OK", enabled: true }] };
    return { clicked: args.button };
  });
  return { h, pressed };
}

test("gma3_dialog read: the top modal as the bridge reads it", async () => {
  const { h } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_dialog", { action: "read" });
    assert.equal(isError, false);
    assert.equal(result.open, true);
    assert.equal(result.modal.text, CONFIRM.text);
  } finally {
    await h.close();
  }
});

test("gma3_dialog press: checks the dialog, presses by text, reports it closed", async () => {
  const { h, pressed } = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_dialog", { action: "press", button: "OK", expect_title: "", expect_text: "Are you sure you want to   overwrite positions?", exclusive: true });
    assert.equal(isError, false, JSON.stringify(result, null, 2));
    assert.equal(result.state, "closed");
    assert.equal(result.verification.status, "matched");
    // The bridge gets the whole dialog the server read, not only the caller's expectations (PR #89 review).
    assert.deepEqual(pressed, [{ button: "OK", exclusive: true, expectClass: "MessageBox", expectTitle: "", expectText: CONFIRM.text }]);
    assert.match(result.summary, /Pressed "OK" on "Are you sure/);
  } finally {
    await h.close();
  }
});

test("gma3_dialog press: refused before the click (no exclusive, no expectation, another dialog, a missing or disabled button)", async () => {
  const { h, pressed } = await setup();
  try {
    for (const [args, re] of [
      [{ button: "OK", expect_title: "" }, /exclusive must be true/],
      [{ button: "OK", exclusive: true }, /expect_title or expect_text is required/],
      [{ button: "OK", expect_title: "Store", exclusive: true }, /title is "", not "Store"/],
      [{ button: "OK", expect_text: "Delete all?", exclusive: true }, /message is .* not the one expected/],
      [{ button: "Yes", expect_title: "", exclusive: true }, /has no button "Yes"/],
      [{ button: "Later", expect_title: "", exclusive: true }, /"Later" is disabled/],
    ] as const) {
      const { result, isError } = await h.callJson("gma3_dialog", { action: "press", ...args });
      assert.equal(isError, true);
      assert.match(result.summary, re);
    }
    assert.equal(pressed.length, 0);
  } finally {
    await h.close();
  }
});

test("gma3_dialog press: a dialog that stays open is a mismatch; one that is replaced is reported", async () => {
  for (const [after, state, status] of [["stay", "still_open", "mismatched"], ["replace", "replaced", "matched"]] as const) {
    const { h } = await setup(after);
    try {
      const { result } = await h.callJson("gma3_dialog", { action: "press", button: "Cancel", expect_title: "", exclusive: true });
      assert.equal(result.state, state);
      assert.equal(result.verification.status, status);
    } finally {
      await h.close();
    }
  }
});

test("gma3_dialog press: a dialog read only in part is refused; failed reads after the click make the state unknown (PR #89 review)", async () => {
  const h = await startHarness(registerDialogTools);
  try {
    h.fake.on("dialog.read", () => ({ open: true, modal: { ...CONFIRM, incomplete: "UI tree not readable" } }));
    let pressed = 0;
    h.fake.on("dialog.press", () => {
      pressed += 1;
      return { clicked: "OK" };
    });
    const part = await h.callJson("gma3_dialog", { action: "press", button: "OK", expect_title: "", exclusive: true });
    assert.match(part.result.summary, /could only be read in part/);
    assert.equal(pressed, 0);
    let reads = 0;
    h.fake.on("dialog.read", () => {
      reads += 1;
      if (reads <= 2) return { open: true, modal: CONFIRM };
      throw new Error("bridge busy");
    });
    const stale = await h.callJson("gma3_dialog", { action: "press", button: "OK", expect_title: "", exclusive: true });
    assert.equal(stale.result.state, "unknown");
    assert.equal(stale.result.verification.status, "unavailable");
    assert.equal(stale.result.after, null);
  } finally {
    await h.close();
  }
});

test("gma3_dialog press: a click that failed after the mouse went down is unknown and the dialog is read again (PR #89 review)", async () => {
  const h = await startHarness(registerDialogTools);
  try {
    let modal: unknown = CONFIRM;
    h.fake.on("dialog.read", () => ({ open: modal !== false, modal, lastCommand: "OK" }));
    h.fake.on("dialog.press", () => {
      modal = false;
      throw new BridgeReplyError("[press-uncertain] the click on OK failed part-way", "press-uncertain");
    });
    const { result } = await h.callJson("gma3_dialog", { action: "press", button: "OK", expect_title: "", exclusive: true });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.state, "closed");
    assert.match(result.summary, /^The click was not confirmed/);
  } finally {
    await h.close();
  }
});

test("gma3_dialog press on an older bridge says so", async () => {
  const h = await startHarness(registerDialogTools);
  try {
    const { result } = await h.callJson("gma3_dialog", { action: "press", button: "OK", expect_title: "", exclusive: true });
    assert.match(result.summary, /older bridge plugin without dialog ops \(bridge 0\.40\.0\)/);
  } finally {
    await h.close();
  }
});
