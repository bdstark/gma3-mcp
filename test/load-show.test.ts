/**
 * gma3_load_show against an in-process FakeBridge.
 *
 * `LoadConsole` models LoadShow as seen live on onPC 2.5.1 (docs/probes/load-show-macos-2.5.1.md): the command is queued
 * (CmdIndirect); with unsaved changes the console first asks "Warning" / "Show file '<current>' has changed! Do you
 * want to save the old show file first?" (Save / Do not save / Cancel); the load unloads the bridge, whose socket then
 * stays open without answers; the loaded show's bridge runs only once `Plugin "gma3_mcp_bridge"` arrives, over OSC
 * only when that show has the plugin and OSC input.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LOAD_TIMING, UNSAVED_TITLE, registerShowTools } from "../src/tools/show.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

const squash = (t: string) => t.replace(/\s+/g, " ").trim();
/** The harness's bridge listens on a random port, so the start command names it. */
const startCommand = () => `Plugin "gma3_mcp_bridge" "${h.bridge.port}"`;

interface Show {
  plugin: boolean;
  oscInput: boolean;
  bridgeVersion: string;
}

class LoadConsole {
  current = "Show A";
  shows = new Map<string, Show>([
    ["Show A", { plugin: true, oscInput: true, bridgeVersion: "0.54.0" }],
    ["Other", { plugin: true, oscInput: true, bridgeVersion: "0.54.0" }],
    ["No Bridge", { plugin: false, oscInput: true, bridgeVersion: "0.54.0" }],
    ["Old Bridge", { plugin: true, oscInput: true, bridgeVersion: "0.38.2" }],
  ]);
  running = true;
  /** The running bridge's start identity; every start gets a new one. */
  instance = "start-1";
  starts = 1;
  /** Reads of show.files that get no answer while the bridge is still alive (a busy console). */
  stallReads = 0;
  /** The answered question stays visible for this many more reads. */
  lingerReads = 0;
  /** dialog.press answers Save / Do not save before the load (the live console does not). */
  pressReplies = false;
  /** ping answers without showfile. */
  noShowfile = false;
  unsavedChanges = false;
  modal: { title: string; text: string; buttons: string[] } | null = null;
  answered: { title: string; text: string; buttons: string[] } | null = null;
  foreignModal = false;
  pendingLoad: string | null = null;
  loads: string[] = [];
  saves = 0;
  presses: string[] = [];
  oscSends: string[] = [];
  /** No show.load op (a bridge older than 0.54.0). */
  noLoadOp = false;
  /** The load is queued but never begins. */
  neverLoads = false;

  load(name: string) {
    this.loads.push(name);
    this.pendingLoad = null;
    this.current = name;
    this.running = false; // the load unloads the plugin; its socket stays open and silent
  }
  start() {
    this.running = true;
    this.instance = `start-${++this.starts}`;
  }
  get osc() {
    return {
      description: "udp://fake:8000",
      sendCommand: async (command: string) => {
        this.oscSends.push(command);
        const show = this.shows.get(this.current);
        if (!this.running && command.startsWith('Plugin "gma3_mcp_bridge"') && show?.plugin && show.oscInput) this.start();
      },
    };
  }
  /** The port the console's bridge listens on, as its ping reports it (behind a tunnel it differs from the client's). */
  consolePort: number | undefined = undefined;
  /** The ping reports show.saveNeeded (bridge 0.53.0); older bridges leave it out. */
  reportsSaveNeeded = false;
  keystrokes: string[] = [];
  keystrokeAvailable = false;
  get keystroke() {
    return {
      description: "keystrokes (fake)",
      available: async () => this.keystrokeAvailable,
      sendCommand: async (command: string) => {
        this.keystrokes.push(command);
        if (!this.running && this.shows.get(this.current)?.plugin) this.start();
      },
    };
  }
  install(h: Harness) {
    h.ctx.oscCommand = this.osc;
    h.ctx.keystroke = this.keystroke;
    h.fake.on("ping", () => (this.running ? { bridgeVersion: this.shows.get(this.current)?.bridgeVersion, instance: this.instance, ...(this.noShowfile ? {} : { showfile: this.current }), ...(this.reportsSaveNeeded ? { show: { saveNeeded: this.unsavedChanges, fileStatus: "ShowLoaded" } } : {}), ...(this.consolePort !== undefined ? { port: this.consolePort } : {}) } : SILENT));
    h.fake.on("show.files", () => {
      if (!this.running) return SILENT;
      if (this.stallReads > 0) {
        this.stallReads--;
        return SILENT;
      }
      if (this.lingerReads > 0 && this.answered) {
        this.lingerReads--;
        return { current: this.current, path: "/shows", listed: true, files: [...this.shows.keys()].map((name) => ({ name })), modal: { class: "MessageBox", ...this.answered }, modalKnown: true };
      }
      if (this.pendingLoad && !this.modal && !this.neverLoads) {
        this.load(this.pendingLoad);
        return SILENT;
      }
      const modal = this.foreignModal ? { class: "MessageBox", title: "Leaving the patch", text: "Discard changes?", buttons: ["Yes", "No"] } : this.modal ? { class: "MessageBox", ...this.modal, display: 1 } : false;
      return { current: this.current, path: "/shows", listed: true, files: [...this.shows.keys()].map((name) => ({ name, file: `${name}.show`, size: 1000, time: 1792140000, localTime: "wall" })), now: 1792146000, modal, modalKnown: true };
    });
    h.fake.on("show.load", (args) => {
      if (!this.running) return SILENT;
      if (this.noLoadOp) throw new Error("unknown op 'show.load'");
      assert.equal(args.exclusive, true);
      if (this.modal) throw new Error("[modal-open] a dialog is open on the console; LoadShow was not sent");
      const name = String(args.name);
      if (!this.shows.has(name)) throw new Error(`[no-file] ${name}.show is not in the shows folder; LoadShow was not sent`);
      this.pendingLoad = name;
      if (this.unsavedChanges) this.modal = { title: "Warning", text: `Show file '${this.current}' has changed!\nDo you want to save the old show file first?`, buttons: ["Save", "Do not save", "Cancel"] };
      return { queued: true, command: `LoadShow "${name}"`, from: this.current };
    });
    h.fake.on("dialog.press", (args) => {
      if (!this.running) return SILENT;
      if (!this.modal) throw new Error("[no-modal] no dialog is open; nothing was clicked");
      if (args.expectTitle !== this.modal.title || squash(String(args.expectText)) !== squash(this.modal.text)) throw new Error("[wrong-modal] nothing was clicked");
      const button = String(args.button);
      this.presses.push(button);
      this.answered = this.modal;
      this.modal = null;
      if (button === "Cancel") {
        this.pendingLoad = null;
        return { clicked: button, title: "Warning" };
      }
      if (button === "Save") this.saves++;
      // Live: Save / Do not save starts the load at once; the bridge is unloaded before it replies.
      if (!this.pressReplies) {
        this.load(this.pendingLoad!);
        return SILENT;
      }
      return { clicked: button, title: "Warning" };
    });
  }
}

let h: Harness;
let con: LoadConsole;
const saved = { ...LOAD_TIMING };
before(async () => {
  Object.assign(LOAD_TIMING, { pollMs: 10, probeMs: 150, dialogPhaseMs: 1200, settleMs: 20, retryMs: 30 });
  h = await startHarness(registerShowTools, { requestTimeoutMs: 2000 });
});
after(async () => {
  Object.assign(LOAD_TIMING, saved);
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  h.bridge.close();
  con = new LoadConsole();
  con.install(h);
});

test("load_show: LoadShow under the file's spelling, the bridge restarted over OSC, the new show confirmed", async () => {
  const r = await h.callJson("gma3_load_show", { name: "other.show", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(con.loads, ["Other"]);
  assert.equal(r.result.previous, "Show A");
  assert.equal(r.result.current, "Other");
  assert.ok(con.oscSends.length >= 1 && con.oscSends.every((c) => c === startCommand()), JSON.stringify(con.oscSends));
  assert.deepEqual(r.result.steps.map((s: { name: string }) => s.name), ["read_show_files", "load", "bridge_stopped", "bridge_restart"]);
  assert.match(r.result.summary, /Loaded Other \(was Show A\)/);
});

test("load_show: a show that is not in the shows folder is refused before anything is sent", async () => {
  const r = await h.callJson("gma3_load_show", { name: "Missing", exclusive: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /Missing\.show is not in the shows folder/);
  assert.equal(h.fake.requests.filter((q) => q.op === "show.load").length, 0);
});

test("load_show: an open dialog is refused; nothing is loaded", async () => {
  con.foreignModal = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /a dialog is open/);
  assert.deepEqual(con.loads, []);
});

test("load_show: unsaved changes with unsaved refuse press Cancel and load nothing", async () => {
  con.unsavedChanges = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, true);
  assert.deepEqual(con.presses, ["Cancel"]);
  assert.deepEqual(con.loads, []);
  assert.equal(con.current, "Show A");
  assert.match(r.text, /unsaved changes: Cancel was pressed and nothing was loaded/);
});

test("load_show: unsaved save presses Save, then the load and the restart go on", async () => {
  con.unsavedChanges = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", unsaved: "save", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(con.presses, ["Save"]);
  assert.equal(con.saves, 1);
  // The press got no reply (the load unloaded the bridge); the confirmed load proves it acted.
  const press = r.result.steps.find((s: { name: string }) => s.name === "unsaved_changes");
  assert.equal(press.status, "succeeded");
  assert.match(press.detail.note, /proves the press acted/);
  assert.equal(r.result.outcome, "succeeded");
  assert.equal(r.result.unsavedAnswer, "Save");
  assert.equal(r.result.verification.status, "matched");
});

test("load_show: unsaved discard presses Do not save", async () => {
  con.unsavedChanges = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", unsaved: "discard", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(con.presses, ["Do not save"]);
  assert.equal(con.saves, 0);
});

test("load_show: a show without the bridge plugin is loaded but not confirmed; the result says how to start it", async () => {
  const r = await h.callJson("gma3_load_show", { name: "No Bridge", exclusive: true, timeout_ms: 5000 });
  assert.equal(r.isError, true);
  assert.deepEqual(con.loads, ["No Bridge"]);
  assert.equal(r.result.verification.status, "unavailable");
  assert.match(r.result.verification.detail, /Plugin "gma3_mcp_bridge"/);
  assert.match(r.result.verification.detail, /may not contain the bridge plugin/);
  assert.ok(con.oscSends.length > 1);
});

test("load_show: restart none sends no OSC and waits for the operator to start the plugin", async () => {
  setTimeout(() => con.start(), 400);
  const r = await h.callJson("gma3_load_show", { name: "Other", restart: "none", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(con.oscSends, []);
  assert.equal(r.result.restart.via, "none");
});

test("load_show: a loaded show with an older bridge is confirmed and warned about", async () => {
  const r = await h.callJson("gma3_load_show", { name: "Old Bridge", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.result.warnings.some((w: string) => /bridge 0\.38\.2: gma3_load_show and the newest tools need 0\.54\.0/.test(w)), r.text);
});

test("load_show: a dialog that is not the unsaved-changes question is not answered", async () => {
  con.unsavedChanges = true;
  // The question names another show: not ours.
  h.fake.on("show.files", () => ({ current: "Show A", path: "/shows", listed: true, files: [{ name: "Show A" }, { name: "Other" }], modal: con.pendingLoad ? { class: "MessageBox", title: UNSAVED_TITLE, text: "Show file 'Elsewhere' has changed!\nDo you want to save the old show file first?" } : false, modalKnown: true }));
  const r = await h.callJson("gma3_load_show", { name: "Other", unsaved: "discard", exclusive: true });
  assert.equal(r.isError, true);
  assert.deepEqual(con.presses, []);
  assert.match(r.text, /unexpected dialog/);
});

test("load_show: a load that never begins is reported, not resent", async () => {
  con.neverLoads = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /the load has not begun/);
  assert.equal(h.fake.requests.filter((q) => q.op === "show.load").length, 1);
});

test("load_show: validation (exclusive, unsaved, restart, timeout) and an old bridge without show.load", async () => {
  for (const args of [{ name: "Other" }, { name: "Other", exclusive: true, timeout_ms: 100 }, { name: 'a"b', exclusive: true }]) {
    const r = await h.callJson("gma3_load_show", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.ok(r.result.validationErrors?.length, r.text);
  }
  const bad = await h.callJson("gma3_load_show", { name: "Other", unsaved: "maybe", exclusive: true });
  assert.equal(bad.isError, true);
  con.noLoadOp = true;
  const old = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(old.isError, true);
  assert.match(old.text, /without show\.load \(bridge 0\.54\.0\)/);
  assert.deepEqual(con.loads, []);
});

test("load_show: restart auto never types keystrokes, even on a Mac running onPC; keystroke is opt-in", async () => {
  con.keystrokeAvailable = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(con.keystrokes, [], "auto uses OSC, not keystrokes");
  assert.ok(con.oscSends.length >= 1, JSON.stringify(con.oscSends));
  assert.match(r.result.restart.via, /^osc/);
  const forced = await h.callJson("gma3_load_show", { name: "Show A", restart: "keystroke", exclusive: true });
  assert.equal(forced.isError, false, forced.text);
  assert.ok(con.keystrokes.length >= 1 && con.keystrokes.every((c) => c === startCommand()), JSON.stringify(con.keystrokes));
  assert.match(forced.result.restart.via, /^keystroke/);
  con.keystrokeAvailable = false;
  const none = await h.callJson("gma3_load_show", { name: "Other", restart: "keystroke", exclusive: true });
  assert.equal(none.isError, true);
  assert.match(none.text, /restart keystroke needs macOS/);
});

test("load_show: unsaved changes reported by the ping (bridge 0.53.0) with unsaved refuse: nothing is sent", async () => {
  con.reportsSaveNeeded = true;
  con.unsavedChanges = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /has unsaved changes \(NeedShowSave\); pass unsaved: save or discard/);
  assert.equal(h.fake.requests.filter((q) => q.op === "show.load" || q.op === "dialog.press").length, 0, "neither LoadShow nor a dialog press was sent");
  assert.deepEqual(con.presses, []);
  // With save, the load goes on and the question is answered as before.
  const saved = await h.callJson("gma3_load_show", { name: "Other", unsaved: "save", exclusive: true });
  assert.equal(saved.isError, false, saved.text);
  assert.deepEqual(con.presses, ["Save"]);
});

test("review: one silent read while the old bridge lives is not a load; reloading the current show is not confirmed by the old bridge", async () => {
  con.neverLoads = true;
  const queue = h.fake.handlerFor("show.load")!;
  h.fake.on("show.load", (args, req) => {
    con.stallReads = 1; // one read after the load gets no answer; the bridge goes on answering
    return queue(args, req);
  });
  const r = await h.callJson("gma3_load_show", { name: "Show A", exclusive: true });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /the load has not begun/);
  // Gone for real but the old instance answers the ping: never matched.
  con.neverLoads = false;
  con.pendingLoad = null;
  h.fake.on("show.load", (args) => {
    con.pendingLoad = null;
    con.stallReads = 5; // the console stops answering show.files, the same bridge still answers ping
    return { queued: true, command: `LoadShow "${args.name}"`, from: con.current };
  });
  const same = await h.callJson("gma3_load_show", { name: "Show A", exclusive: true, timeout_ms: 5000 });
  assert.equal(same.isError, true, same.text);
  assert.notEqual(same.result.verification.status, "matched");
  assert.match(same.result.verification.detail, /the bridge that was running before still answers/);
});

test("review of #133: an old-bridge answer during a slow load does not stop the restart once the load unloads it", async () => {
  const queue = h.fake.handlerFor("show.load")!;
  h.fake.on("show.load", (args, req) => {
    const r = queue(args, req);
    con.stallReads = 2; // two silent reads: the tool sees the bridge as gone, but the load has not run yet
    return r;
  });
  const ping = h.fake.handlerFor("ping")!;
  h.fake.on("ping", (args, req) => {
    const r = ping(args, req);
    // The old bridge answers once more after it looked gone, then the slow load unloads it.
    if (con.pendingLoad && con.stallReads === 0 && con.running) con.load(con.pendingLoad);
    return r;
  });
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true, timeout_ms: 5000 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
  assert.ok(r.result.restart.oldBridgeAnswers >= 1, JSON.stringify(r.result.restart));
  assert.ok(r.result.restart.sends >= 1, "the start command was sent once the old bridge was silent");
  assert.deepEqual(con.loads, ["Other"]);
});

test("review of #133: behind a tunnel the restart command names the console's port from the ping, not the client's", async () => {
  con.consolePort = 9800;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.ok(con.oscSends.length >= 1 && con.oscSends.every((c) => c === 'Plugin "gma3_mcp_bridge"'), JSON.stringify(con.oscSends));
  con.consolePort = 9801;
  const other = await h.callJson("gma3_load_show", { name: "Show A", exclusive: true });
  assert.equal(other.isError, false, other.text);
  assert.ok(con.oscSends.includes('Plugin "gma3_mcp_bridge" "9801"'), JSON.stringify(con.oscSends));
});

test("review of #133: a LoadShow whose reply was lost is confirmed by the new bridge, not left unknown", async () => {
  const queue = h.fake.handlerFor("show.load")!;
  h.fake.on("show.load", (args, req) => {
    queue(args, req);
    return SILENT; // the load is queued, its reply never comes
  });
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true, timeout_ms: 5000 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.outcome, "succeeded", r.text);
  assert.equal(r.result.verification.status, "matched");
  const load = r.result.steps.find((s: { name: string }) => s.name === "load");
  assert.equal(load.status, "succeeded");
  assert.match(load.detail.note, /not resent/);
  assert.equal(h.fake.requests.filter((q) => q.op === "show.load").length, 1, "LoadShow was sent once");
});

test("review: the answered question still visible for a moment is not a foreign dialog", async () => {
  con.unsavedChanges = true;
  con.pressReplies = true;
  con.lingerReads = 2;
  const r = await h.callJson("gma3_load_show", { name: "Other", unsaved: "discard", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(con.presses, ["Do not save"]);
});

test("review: refuse reads back that the same show and bridge answer", async () => {
  con.unsavedChanges = true;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, true);
  const back = r.result.steps.find((s: { name: string }) => s.name === "read_back");
  assert.equal(back.status, "failed");
  assert.equal(r.result.verification.status, "matched");
});

test("review: a new bridge that does not name the show is unavailable, not mismatched", async () => {
  h.fake.on("show.load", (args) => {
    con.load(String(args.name));
    con.noShowfile = true;
    return { queued: true, command: `LoadShow "${args.name}"`, from: "Show A" };
  });
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, true);
  assert.equal(r.result.verification.status, "unavailable");
});

test("review: a bridge on another port is started with that port", async () => {
  const port = h.bridge.port;
  const r = await h.callJson("gma3_load_show", { name: "Other", exclusive: true });
  assert.equal(r.isError, false, r.text);
  assert.ok(con.oscSends.every((c) => c === `Plugin "gma3_mcp_bridge" "${port}"`), JSON.stringify(con.oscSends));
  assert.ok(r.result.warnings.some((w: string) => /default policies/.test(w)));
});
