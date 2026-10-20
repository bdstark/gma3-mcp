#!/usr/bin/env node
// KB-28 probe: qualify more VirtualKeyCodes for the executor-held Quickey path (KB-10 tested nine) against a RUNNING
// bridge with Lua on ( Plugin "gma3_mcp_bridge" "lua on" ). It creates its own two probe Quickeys and assigns them to
// two empty executors, exactly the dispatch shape of the owned-Quickey backend (KB-13): Assign, Press / Unpress Page.
// Console keys ARE pressed: run it only on a disposable show, with every other key source stopped (the NX-K surface
// plugin included; its input would interleave with the probe's).
//
//   node scripts/kb28-probe.mjs run    [--codes NUM0,NUM2,...] [--out report.json]   command line: taps, holds, rolling pairs, toggles
//   node scripts/kb28-probe.mjs popup  [--out report.json]                            Edit Command pop-up open and empty (opened by hand)
//   node scripts/kb28-probe.mjs type   NUM1 DOT NUM5                                  one key per request, nothing read (screenshot check)
//   --direct (run, popup, type): KB-29, every key as a direct tap (Press Quickey N): one complete activation, no
//                                                                                    executor, no Unpress; holds and rolled pairs are skipped
//   node scripts/kb28-probe.mjs cleanup [--unpress]                                   removes the probe objects of an aborted run
//                                                                                    (--unpress: Unpress them first, if a key may be down)
//
// Options: --quickey N (probe Quickeys N and N+1, default 960), --exec P.E (probe executors P.E and P.E+1, default
// 1.190). Every slot must be empty at the start; the probe only deletes objects it can identify as its own (name
// "KB28 A"/"KB28 B", and for executors the probe Quickey assigned to them). Nothing is retried or replayed.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const host = process.env.GMA3_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.GMA3_BRIDGE_PORT ?? 9800);
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const outFile = opt("--out", null);
const QK = Number(opt("--quickey", 960));
const [EXP, EXE] = String(opt("--exec", "1.190")).split(".").map(Number);
const FIXTURE = Number(opt("--fixture", 101));
// KB-29: --direct presses every key as a direct tap of its Quickey (Press Quickey N, no executor, no Unpress).
// KB-10 found a directly addressed Quickey is always one complete tap; holds and rolled pairs do not apply.
const DIRECT = argv.includes("--direct");
const SHOW_GUARD = /disposable|mcp-test|scratch/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Codes of the NX-K's keys without KB-10 evidence, as the surface maps them (mtpnxk_surface.lua NXK_KEYS).
// TEXT codes put a token on the command line; TOGGLE codes flip a readable mode. NEXT, PREV and MENU act on a
// selection or open a window and are left to a later probe (no readback here).
export const TEXT_CODES = ["NUM0", "NUM2", "NUM3", "NUM4", "NUM6", "NUM7", "NUM8", "NUM9", "PLUS", "MINUS", "DOT", "SLASH", "AT",
  "UPDATE", "EDIT", "COPY", "MOVE", "DELETE", "CUE", "GROUP", "MACRO", "PREVIEW"];
// FULL acts on a selection (nothing on an empty line, first run): checked against --fixture separately.
export const TOGGLE_CODES = { HIGHLIGHT: "highlight" };
// Rolling pairs: B goes down before A comes up, as fast typing on a keypad does.
export const ROLLING = [["NUM1", "NUM2"], ["NUM2", "NUM3"], ["NUM9", "NUM0"], ["NUM1", "DOT"], ["DOT", "NUM5"], ["NUM4", "PLUS"], ["MINUS", "NUM6"], ["NUM7", "SLASH"], ["NUM1", "THRU"], ["THRU", "NUM8"],
  // keywords rolled with digits both ways (a keypad operator types "1 At 5", "Cue 3"). COPY, MOVE, DELETE and MACRO
  // are left out: in the first run "1" then COPY/MOVE lost the digit even as sequential taps and executed when the
  // rolled pair came up, and "1" DELETE opened the delete confirmation for the sheet's selected cue (a dialog opened
  // from the plugin thread stalls the bridge); "1" MACRO would run a show macro the same way.
  ...["AT", "UPDATE", "EDIT", "CUE", "GROUP", "PREVIEW"].flatMap((k) => [["NUM1", k], [k, "NUM2"]])];
// Pop-up sequences (KB-10 35a: within one chunk, digits land a frame behind keywords in a focused text field).
export const POPUP_SEQUENCES = [["NUM1", "THRU", "NUM5"], ["NUM1", "DOT", "NUM5"], ["NUM2", "PLUS", "NUM3"], ["NUM9", "MINUS", "NUM4"], ["NUM8", "SLASH", "NUM2"], ["AT", "NUM5", "NUM0"]];

class Conn {
  constructor(name) { this.name = name; this.seq = 0; this.pending = new Map(); this.buf = ""; this.sock = null; }
  connect() {
    return new Promise((resolve, reject) => {
      let connected = false;
      const sock = net.connect(port, host, () => { connected = true; resolve(); });
      sock.setEncoding("utf8");
      sock.setNoDelay(true);
      sock.on("data", (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(m.id);
          if (!p) continue;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve({ ok: true, result: m.result });
          else p.resolve({ ok: false, error: typeof m.error === "string" ? m.error : JSON.stringify(m.error), code: m.code });
        }
      });
      sock.on("error", (e) => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); if (!connected) reject(new Error(`cannot connect to the bridge at ${host}:${port}: ${e.message}`)); });
      sock.on("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("connection closed")); } this.pending.clear(); });
      this.sock = sock;
    });
  }
  request(op, args = {}) {
    const id = `${this.name}-${this.seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${op}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  end() { return new Promise((r) => { this.sock.end(r); }); }
}

const steps = [];
let failed = 0;
function record(name, pass, detail) {
  steps.push({ name, pass: !!pass, detail });
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) {
  steps.push({ name, pass: null, detail });
  console.log(`NOTE  ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function lua(conn, code) {
  const r = await conn.request("lua", { code });
  if (!r.ok) throw new Error(`lua failed: ${r.error}`);
  return r.result?.values?.[0];
}
const readCmd = (conn) => lua(conn, "return CmdObj().cmdtext");
const readMa = (conn) => lua(conn, "return Root():Get('MAState')");
async function fb(conn, reader) {
  const r = await conn.request("feedback.read", { readers: [reader] });
  if (!r.ok) throw new Error(`feedback.read failed: ${r.error}`);
  const it = (r.result.items || []).find((i) => i.name === reader);
  return it?.available ? it.value : undefined;
}

// Probe slots: A = Quickey QK on executor EXP.EXE, B = Quickey QK+1 on EXP.EXE+1.
const SLOTS = { A: { q: QK, e: EXE, name: "KB28 A" }, B: { q: QK + 1, e: EXE + 1, name: "KB28 B" } };
const readSlotLua = (s) => `local q = ObjectList('Quickey ${s.q}')[1]
local h = ObjectList('Page ${EXP}.${s.e}')[1]
local o = h and h:Get('Object')
return { quickey = q and { name = tostring(q.name), code = tostring(q:Get('Code')), note = tostring(q:Get('Note')) } or false,
  exec = h and (o and { class = tostring(o:GetClass()), name = tostring(o.name), index = tonumber(o.index) } or 'noobj') or false }`;
const readSlot = (conn, s) => lua(conn, readSlotLua(s));
const MARKER = "kb28-probe";
// Ownership is the name AND the marker Note setup writes; an executor is ours only while it holds our own Quickey.
// A Quickey this process stored at a verified-empty slot stays ours while its Note is the marker or still empty
// (setup may have failed before the marker write, review 9), so a partial setup can be rolled back.
const createdHere = new Set();
const ours = (s, st) => !!st.quickey && ((st.quickey.name === s.name && st.quickey.note === MARKER)
  || (createdHere.has(s.name) && st.quickey.note === MARKER));  // a partial setup still carries the marker (written first)
const execOurs = (s, st) => ours(s, st) && !!st.exec && st.exec !== "noobj" && st.exec.class === "Quickey" && st.exec.index === s.q;
// The ownership guard every press and release runs in the SAME Lua request as its command (review 9): the slot's
// Quickey (name, marker) and its executor holding exactly that Quickey. Returns a reason string when it fails.
const guardLua = (s) => `local q = ObjectList('Quickey ${s.q}')[1]
if not q or tostring(q.name) ~= '${s.name}' or tostring(q:Get('Note')) ~= '${MARKER}' then return 'not ours' end
local h = ObjectList('Page ${EXP}.${s.e}')[1]
local o = h and h:Get('Object')
if not o or tostring(o:GetClass()) ~= 'Quickey' or tonumber(o.index) ~= ${s.q} then return 'executor not ours' end`;

async function setup(conn) {
  for (const s of Object.values(SLOTS)) {
    const st = await readSlot(conn, s);
    if (st.quickey || st.exec) throw new Error(`Quickey ${s.q} or executor ${EXP}.${s.e} is not empty (${JSON.stringify(st)}); pick other slots with --quickey/--exec, or run "cleanup" after an aborted run`);
  }
  for (const s of Object.values(SLOTS)) {
    createdHere.add(s.name);  // before the request: a Store that went through is ours even if the request fails
    // Both slots are re-checked empty in the same request as the Store and the Assign (review 11).
    const st = await lua(conn, `if ObjectList('Quickey ${s.q}')[1] or ObjectList('Page ${EXP}.${s.e}')[1] then return 'occupied' end
Cmd('Store Quickey ${s.q} /NoConfirmation')
local q = ObjectList('Quickey ${s.q}')[1]
if not q then return 'not created' end
q:Set('Note', '${MARKER}')  -- the marker first: it is the identity cleanup relies on (review 13)
if tostring(q:Get('Note')) ~= '${MARKER}' then
  -- Review 15: an ignored marker write leaves an object cleanup cannot recognise; it is removed in this request,
  -- before it is renamed or assigned.
  Cmd('Delete Quickey ${s.q} /NoConfirmation')
  if ObjectList('Quickey ${s.q}')[1] then return 'marker not applied; removing it failed' end
  return 'marker not applied; removed'
end
q:Set('Name', '${s.name}')
Cmd('Assign Quickey ${s.q} At Page ${EXP}.${s.e}')
return true`);
    if (st === "occupied") { createdHere.delete(s.name); throw new Error(`Quickey ${s.q} or executor ${EXP}.${s.e} became occupied before setup; nothing created`); }
    if (st === "marker not applied; removed") { createdHere.delete(s.name); throw new Error(`Quickey ${s.q}: the console ignored the ownership Note, so the new object was removed again; nothing of this slot is left`); }
    if (st !== true) throw new Error(`creating Quickey ${s.q}: ${st}`);
    const back = await readSlot(conn, s);
    if (!ours(s, back) || !execOurs(s, back)) throw new Error(`probe slot ${s.name} does not read back (${JSON.stringify(back)})`);
  }
}

// Slots this process pressed and has not released. Deleting or reassigning an executor during a hold leaves the
// key down (KB-10), so cleanup releases them first. A separate "cleanup" process cannot know what an aborted run
// left pressed: --unpress makes it issue Unpress on its own executors before deleting (the operator's decision;
// an Unpress of a key that is not down is not qualified).
const pressed = new Set();
// A toggle stage that ended while its slot may be down leaves the mode restoration to cleanup: once the slot is
// released, the mode is tapped back to its baseline before the slot is deleted (review 16).
let pendingRestore = null;
async function restoreToggle(conn, s, r) {
  try {
    const now = await fb(conn, r.reader);
    if (now === undefined) { note(`${r.name}: ${r.reader} unreadable after the release; left for the operator (baseline ${r.v0})`); return; }
    if (now === r.v0) { note(`${r.name}: ${r.reader} already at its baseline ${r.v0}`); return; }
    await code(conn, s, r.name);
    if (accepted(await press(conn, s))) await unpress(conn, s);
    const after = await settle(() => fb(conn, r.reader), now);
    record(`${r.name}: ${r.reader} restored to its baseline after cleanup released the slot`, after === r.v0, { baseline: r.v0, before: now, after });
  } catch (e) {
    record(`${r.name}: restoring ${r.reader} after the release failed; left for the operator (baseline ${r.v0})`, false, String(e && e.message));
  }
}
async function cleanup(conn, unpressAll = false) {
  const out = {};
  // Slots are released in press order (A, then B): after a refused release of an earlier slot, a later slot that
  // may be down is kept too, never released ahead of it (review 13).
  let earlierStuck = false;
  for (const s of Object.values(SLOTS)) {
    const st = await readSlot(conn, s);
    if (earlierStuck && (pressed.has(s.name) || unpressAll)) {
      record(`${s.name}: kept for recovery, an earlier slot's release was refused (released first down, first up)`, false, st);
      out[s.name] = st;
      continue;
    }
    if (execOurs(s, st) && (pressed.has(s.name) || unpressAll)) {
      const fu = await lua(conn, `${guardLua(s)}\nreturn Cmd('Unpress Page ${EXP}.${s.e}')`);
      if (!accepted(fu)) {
        // The key may still be down: deleting its assignment would leave it stuck (KB-10). Keep the slot for recovery.
        record(`${s.name}: Unpress refused (${fu}); Quickey ${s.q} and executor ${EXP}.${s.e} left in place for recovery`, false, fu);
        out[s.name] = st;
        earlierStuck = true;
        continue;
      }
      pressed.delete(s.name);
      note(`${s.name}: released before cleanup`, fu);
      if (pendingRestore && s === SLOTS.A) {
        const r = pendingRestore;
        pendingRestore = null;
        await restoreToggle(conn, s, r);
        if (pressed.has(s.name)) {
          // The restoring tap's release did not go through: the slot is kept for recovery like any other.
          record(`${s.name}: the restoring tap may still be down; Quickey ${s.q} and executor ${EXP}.${s.e} left in place for recovery`, false);
          out[s.name] = await readSlot(conn, s);
          earlierStuck = true;
          continue;
        }
      }
    }
    // Each delete re-checks ownership in the SAME request (review 10): a replacement after readSlot is never deleted.
    const ownQ = `local q = ObjectList('Quickey ${s.q}')[1]
if not q then return 'no quickey' end
local note = tostring(q:Get('Note'))
if not ((tostring(q.name) == '${s.name}' and note == '${MARKER}') or (${createdHere.has(s.name) ? "true" : "false"} and note == '${MARKER}')) then return 'not ours' end`;
    if (execOurs(s, st)) {
      const d = await lua(conn, `${ownQ}
local h = ObjectList('Page ${EXP}.${s.e}')[1]
local o = h and h:Get('Object')
if not o or tostring(o:GetClass()) ~= 'Quickey' or tonumber(o.index) ~= ${s.q} then return 'executor not ours' end
local fb = Cmd('Delete Page ${EXP}.${s.e} /NoConfirmation')
local h2 = ObjectList('Page ${EXP}.${s.e}')[1]
local o2 = h2 and h2:Get('Object')
if o2 then return 'delete ' .. tostring(fb) .. ', executor still holds ' .. tostring(o2.name) end
return true`);
      if (d !== true) {
        // The executor may still reference the Quickey: keep the Quickey too (review 13).
        record(`executor ${EXP}.${s.e} not cleared (${d}); Quickey ${s.q} kept with it`, false, d);
        out[s.name] = await readSlot(conn, s);
        continue;
      }
    }
    else if (st.exec) note(`executor ${EXP}.${s.e} left in place`, st.exec);
    if (ours(s, st) && pressed.has(s.name)) {
      // Its key may still be down and its executor no longer holds it (reassigned): the Quickey is what the operator
      // needs to restore the assignment and recover, so it stays (review 11).
      record(`${s.name}: may still be down and its executor no longer holds Quickey ${s.q}; the Quickey is kept for recovery`, false, st);
    } else if (ours(s, st)) {
      const d = await lua(conn, `${ownQ}
Cmd('Delete Quickey ${s.q} /NoConfirmation')
return true`);
      if (d !== true) note(`Quickey ${s.q} left in place`, d);
    }
    else if (st.quickey) note(`Quickey ${s.q} left in place`, st.quickey);
    out[s.name] = await readSlot(conn, s);
  }
  return out;
}

// Sets the slot's code (verified by readback) without pressing anything.
// Every rewrite (and so every press that follows it) re-verifies ownership: the name, the probe's marker Note and
// the slot's executor still holding this Quickey (review 4). A replaced object is never written or pressed.
async function code(conn, s, name) {
  const back = await lua(conn, `${guardLua(s)}
q:Set('Code', '${name}')
return tostring(q:Get('Code'))`);
  if (back !== name) throw new Error(`Quickey ${s.q} code ${name} reads back ${back}`);
  s.code = name;  // what every later press of this slot must still find on it
}
// Marked pressed BEFORE the request: a request that times out may still have pressed the key.
// A direct tap: one complete activation, nothing left down (KB-10), so nothing is tracked as pressed. It runs the
// same ownership guard and Code check as press() in the same request (review 9 of #74).
const dtapGuard = (s) => `${guardLua(s)}
if tostring(q:Get('Code')) ~= '${s.code}' then return 'code changed: ' .. tostring(q:Get('Code')) end`;
const dtap = async (conn, s) => {
  const r = await lua(conn, `${dtapGuard(s)}
return Cmd('Press Quickey ${s.q}')`);
  if (r === "not ours" || r === "executor not ours" || String(r).startsWith("code changed")) throw new Error(`probe slot ${s.name}: ${r}; nothing tapped, stage stopped`);
  return r;
};
// The press re-runs the ownership guard and checks the Code code() set, in the same request (review 9). A guard
// failure presses nothing: the marker is cleared and the stage stops. A refused Press leaves nothing down either.
const press = async (conn, s) => {
  pressed.add(s.name);
  const r = await lua(conn, `${guardLua(s)}
if tostring(q:Get('Code')) ~= '${s.code}' then return 'code changed: ' .. tostring(q:Get('Code')) end
return Cmd('Press Page ${EXP}.${s.e}')`);
  if (!accepted(r)) {
    // Nothing is down after a guard failure or a refused Press; the stage stops, so no caller ever sends the
    // matching Unpress for a key that is not known to be down (review 11).
    pressed.delete(s.name);
    throw new Error(`probe slot ${s.name}: Press ${r}; nothing pressed, stage stopped`);
  }
  return r;
};
// Only an accepted Unpress clears the marker: after a refused one the key may still be down, so cleanup must try
// again before it deletes anything (review 5).
// A refused Unpress also stops the stage (review 7): nothing may rewrite or press the slot while its key may be
// down; the throw goes to the caller's finally, where cleanup releases the slot before deleting it.
// The release re-runs the guard in the same request: an executor that no longer holds the probe's Quickey is never
// unpressed (that would release whatever replaced it), and the marker stays for recovery (review 9).
const unpress = async (conn, s) => {
  const r = await lua(conn, `${guardLua(s)}
return Cmd('Unpress Page ${EXP}.${s.e}')`);
  if (!accepted(r)) throw new Error(`Unpress Page ${EXP}.${s.e} (${s.name}) was refused (${r}); stage stopped, the slot is kept for recovery`);
  pressed.delete(s.name);
  return r;
};
const accepted = (fbText) => typeof fbText === "string" && fbText.startsWith("OK");

/** Escape through Keyboard() (an ESC Quickey never touches the command line, KB-10), up to three times: a
 *  keyword that opened a pop-up (first run: after UPDATE) takes one Escape for the pop-up and one for the line. */
async function clearLine(conn) {
  for (let n = 0; n < 3; n++) {
    await lua(conn, "Keyboard(1, 'press', 'Escape'); Keyboard(1, 'release', 'Escape'); return true");
    for (let i = 0; i < 8; i++) { if ((await readCmd(conn)) === "") return true; await sleep(60); }
  }
  return false;
}
/** Reads until the value differs from `from` (or the deadline): mode readers lag the press by a frame. */
async function settle(reader, from, ms = 600) {
  let v = await reader();
  for (const t0 = Date.now(); v === from && Date.now() - t0 < ms; v = await reader()) await sleep(50);
  return v;
}

// One tap through the executor: Press, read in the chunk and on the next request, Unpress, read again.
// With --direct: Press Quickey N, read in the chunk, on the next request and once more 300 ms later (a direct
// Unpress would be a second tap, KB-10, so none is issued).
async function tap(conn, s, name) {
  await code(conn, s, name);
  if (DIRECT) {
    const r = await lua(conn, `${dtapGuard(s)}
local before = CmdObj().cmdtext
local fp = Cmd('Press Quickey ${s.q}')
local imm = CmdObj().cmdtext
return { before = before, fp = fp, imm = imm }`);
    if (typeof r === "string") throw new Error(`probe slot ${s.name}: ${r}; nothing tapped, stage stopped`);
    const afterPress = await readCmd(conn);
    await sleep(300);
    const afterRelease = await readCmd(conn);
    return { ...r, afterPress, fu: "OK", afterRelease };
  }
  pressed.add(s.name);
  // The same guard and Code check as press(), in the same request as the Press (review 10).
  const r = await lua(conn, `${guardLua(s)}
if tostring(q:Get('Code')) ~= '${s.code}' then return 'code changed: ' .. tostring(q:Get('Code')) end
local before = CmdObj().cmdtext
local fp = Cmd('Press Page ${EXP}.${s.e}')
local imm = CmdObj().cmdtext
return { before = before, fp = fp, imm = imm }`);
  if (typeof r === "string") { pressed.delete(s.name); throw new Error(`probe slot ${s.name}: ${r}; nothing pressed, stage stopped`); }
  if (!accepted(r.fp)) {
    // Refused: nothing is down, so no Unpress is sent (unpressing a key that is not down is not qualified).
    pressed.delete(s.name);
    const line = await readCmd(conn);
    return { ...r, afterPress: line, fu: "not pressed", afterRelease: line };
  }
  const afterPress = await readCmd(conn);
  const fu = await unpress(conn, s);
  const afterRelease = await readCmd(conn);
  return { ...r, afterPress, fu, afterRelease };
}

async function preflight(A) {
  const pingR = await A.request("ping");
  if (!pingR.ok) throw new Error(`ping failed: ${pingR.error}`);
  const ping = pingR.result;
  console.log(`bridge ${ping.bridgeVersion} on ${ping.host}:${ping.port}; show "${ping.showfile ?? ""}"; input ${ping.input ? (ping.input.enabled ? `enabled (${ping.input.backend})` : "disabled") : "not reported"}; lua ${ping.lua?.enabled ? "on" : "off"}`);
  if (!SHOW_GUARD.test(String(ping.showfile ?? ""))) { console.error(`show "${ping.showfile}" does not look disposable; refusing to press console keys`); process.exit(2); }
  if (!ping.lua?.enabled) { console.error('Lua execution is off on the bridge; the probe creates its objects and verifies through Lua and needs  Plugin "gma3_mcp_bridge" "lua on"'); process.exit(2); }
  if (ping.input && (ping.input.holds > 0 || ping.input.unresolved > 0 || ping.input.unresolvedFromPreviousRun > 0 || ping.input.busy)) { console.error("the bridge has holds or unresolved records; resolve them first (input status / input recover)"); process.exit(2); }
  // Another client with bridge input could press a key between the probe's steps: input must be off, as recorded.
  if (ping.input && (ping.input.enabled || ping.input.sessions > 0)) { console.error(`bridge input is ${ping.input.enabled ? "enabled" : "disabled"} with ${ping.input.sessions ?? 0} session(s); start the bridge without input (Plugin "gma3_mcp_bridge" "lua on") so no other client can press keys during the probe`); process.exit(2); }
  // The NX-K surface plugin keeps its state in this global (mtpnxk_surface.lua); a running surface would interleave keys.
  const surface = await lua(A, "local s = rawget(_G, '__mtpnxk_surface'); return s ~= nil and s.running == true");
  if (surface === true) { console.error('the mtpnxk surface plugin is running; stop it first:  Plugin "mtpnxk_surface" "stop"'); process.exit(2); }
  if (mode !== "cleanup") {
    // popup runs with the pop-up open (its line is checked in runPopup), but never with MA held: every key would
    // be measured as part of an MA chord.
    const cmd = mode === "popup" ? "" : await readCmd(A);
    const ma = await readMa(A);
    if (cmd !== "" || ma !== false) { console.error(`console not idle: cmdtext=${JSON.stringify(cmd)} MASTATE=${ma}`); process.exit(2); }
  }
  return ping;
}

async function runCmdline(A, codes, only) {
  // only: the operator's --codes set (null = the whole default run). Every stage presses only selected codes.
  const pick = (name) => !only || only.has(name);
  // 1. Taps: one token on Press, nothing on Unpress, the same in the chunk and on the next request.
  const tokens = {};
  for (const name of codes) {
    if (!(await clearLine(A))) { record(`${name}: command line cleared before the tap (stage stopped, nothing more pressed)`, false, await readCmd(A)); return; }
    const t = await tap(A, SLOTS.A, name);
    tokens[name] = t.afterPress;
    record(`${name} tap: Press puts a token on the line synchronously, Unpress adds nothing`,
      accepted(t.fp) && accepted(t.fu) && t.imm !== "" && t.afterPress === t.imm && t.afterRelease === t.afterPress, t);
  }
  // 2. Holds: Press kept down across requests for 1.5 s inserts once (no auto-repeat), Unpress adds nothing.
  // A direct tap holds nothing: no hold stage and no rolled pairs in --direct.
  for (const name of DIRECT ? [] : codes) {
    if (!(await clearLine(A))) { record(`${name}: command line cleared before the hold (stage stopped, nothing more pressed)`, false, await readCmd(A)); return; }
    await code(A, SLOTS.A, name);
    const fp = await press(A, SLOTS.A);
    const down = await readCmd(A);
    await sleep(1500);
    const held = await readCmd(A);
    const ma = await readMa(A);
    const fu = await unpress(A, SLOTS.A);
    const up = await readCmd(A);
    record(`${name} hold: one token while held 1.5 s, none on release, MA untouched`, accepted(fp) && accepted(fu) && down === tokens[name] && held === down && up === down && ma === false, { down, held, up, ma });
  }
  // 3. Rolling pairs: B down before A up gives the same line as two sequential taps.
  for (const [a, b] of DIRECT ? [] : ROLLING.filter(([a, b]) => pick(a) && pick(b))) {
    if (!(await clearLine(A))) { record(`${a}+${b}: command line cleared (stage stopped, nothing more pressed)`, false, await readCmd(A)); return; }
    await code(A, SLOTS.A, a); await code(A, SLOTS.B, b);
    await press(A, SLOTS.A); await unpress(A, SLOTS.A); await press(A, SLOTS.B); await unpress(A, SLOTS.B);
    const sequential = await readCmd(A);
    // The rolled pair is only comparable (and only safe) on an empty line.
    if (!(await clearLine(A))) { record(`${a}+${b}: command line cleared after the sequential taps (stage stopped, nothing more pressed)`, false, { sequential, line: await readCmd(A) }); return; }
    const fa = await press(A, SLOTS.A);
    const fb2 = await press(A, SLOTS.B);
    const both = await readCmd(A);
    const ua = await unpress(A, SLOTS.A);
    const ub = await unpress(A, SLOTS.B);
    const rolled = await readCmd(A);
    record(`${a} then ${b} rolled (B down before A up) equals two sequential taps`, [fa, fb2, ua, ub].every(accepted) && rolled === sequential && both === rolled, { sequential, both, rolled });
  }
  // The toggles only mean something on an empty line (review 8).
  if (!(await clearLine(A))) { record("command line cleared after the rolled pairs (stage stopped, nothing more pressed)", false, await readCmd(A)); return; }
  // 4. Toggles: Press flips the mode once, Unpress leaves it, a second tap flips it back.
  for (const [name, reader] of Object.entries(TOGGLE_CODES).filter(([name]) => pick(name))) {
    await code(A, SLOTS.A, name);
    const read = () => fb(A, reader);
    if (DIRECT) {
      // A direct tap flips the mode once (nothing more 400 ms later), a second one restores it. A direct tap leaves
      // nothing down, so the finally can always tap once more to put the mode back at its baseline (review 4 of #75).
      const v0 = await read();
      try {
        const fp = await dtap(A, SLOTS.A);
        const v1 = await settle(read, v0);
        await sleep(400);
        const v2 = await read();
        const fp2 = await dtap(A, SLOTS.A);
        const v3 = await settle(read, v2);
        const line = await readCmd(A);
        record(`${name} direct tap toggles ${reader} once, a second one restores it`, accepted(fp) && accepted(fp2) && v0 !== undefined && v1 !== v0 && v2 === v1 && v3 === v0 && line === "", { v0, v1, v2, v3, line });
      } finally {
        const now = await read().catch(() => undefined);
        if (v0 !== undefined && now !== undefined && now !== v0) {
          await code(A, SLOTS.A, name).catch(() => {});
          await dtap(A, SLOTS.A).catch(() => {});
          note(`${name}: ${reader} restored to ${v0}`, await settle(read, now).catch(() => undefined));
        }
      }
      continue;
    }
    const v0 = await read();
    // Without a readable baseline the mode could not be restored after an abort: nothing is pressed (review 13).
    if (v0 === undefined) { record(`${name}: ${reader} is not readable, stage stopped before any press`, false); return; }
    try {
      const fp = await press(A, SLOTS.A);
      const v1 = await settle(read, v0);
      const fu = await unpress(A, SLOTS.A);
      await sleep(400);
      const v2 = await read();
      await press(A, SLOTS.A); await unpress(A, SLOTS.A);
      const v3 = await settle(read, v2);
      const line = await readCmd(A);
      // Sustained hold: down for 1.5 s, the mode flips once and stays (no repeat), Unpress leaves it.
      const h0 = await read();
      const hp = await press(A, SLOTS.A);
      const h1 = await settle(read, h0);
      await sleep(1500);
      const h2 = await read();
      const hu = await unpress(A, SLOTS.A);
      await sleep(400);
      const h3 = await read();
      await press(A, SLOTS.A); await unpress(A, SLOTS.A);
      const h4 = await settle(read, h3);
      record(`${name} hold: down 1.5 s flips ${reader} once and keeps it, Unpress leaves it`, accepted(hp) && accepted(hu) && h1 !== h0 && h2 === h1 && h3 === h1 && h4 === h0, { h0, h1, h2, h3, h4 });
      record(`${name}: Press toggles ${reader} once, Unpress leaves it, a second tap restores it`, accepted(fp) && accepted(fu) && v0 !== undefined && v1 !== v0 && v2 === v1 && v3 === v0 && line === "", { v0, v1, v2, v3, line });
    } finally {
      // Whatever happened in the stage, the mode goes back to its baseline with one more tap (review 5).
      // Never while the slot may still be down (a refused or aborted release, review 8): cleanup releases it
      // first, and the mode is then left for the operator (reported).
      const now = await read().catch(() => undefined);
      if (pressed.has(SLOTS.A.name)) {
        // Cleanup releases the slot first and then taps the mode back (review 16).
        if (now !== v0) { pendingRestore = { name, reader, v0 }; note(`${name}: ${reader} at ${now} (baseline ${v0}); the slot may be down, cleanup releases it and then restores the mode`, now); }
      } else if (v0 !== undefined && now !== undefined && now !== v0) {
        await code(A, SLOTS.A, name).catch(() => {});
        if (accepted(await press(A, SLOTS.A).catch(() => null))) await unpress(A, SLOTS.A).catch(() => {});
        note(`${name}: ${reader} restored to ${v0}`, await settle(read, now).catch(() => undefined));
      }
    }
  }
}

// FULL on a selection: Fixture N selected through the command line, then FULL executes "At Full" (Dimmer 100 in the
// programmer, line empty); Unpress adds nothing. The programmer is cleared before and after (ClearAll), nothing stored.
async function dimmer(A) {
  const r = await A.request("programmer", { scope: "fixtures", fixtures: `Fixture ${FIXTURE}`, limit: 50 });
  if (!r.ok) throw new Error(`programmer read failed: ${r.error}`);
  const row = (r.result.rows || []).find((x) => x.attribute === "Dimmer");
  return row ? row.value : null;
}
// Set when the FULL stage ends while its slot may still be down: the programmer is cleared only after cleanup has
// released the slot (review 15), never alongside an uncertain held key.
let fullClearPending = false;
async function clearAfterFull(A) {
  const cleared = await lua(A, `local fb = Cmd('ClearAll'); return { fb = tostring(fb), sel = SelectionCount() }`).catch((e) => ({ error: String(e && e.message) }));
  const dLeft = await dimmer(A).catch(() => "unreadable");
  record("FULL: selection and programmer cleared after the stage", cleared && cleared.sel === 0 && dLeft === null, { cleared, dimmer: dLeft });
}
async function runFull(A) {
  try {
    await runFullStage(A);
  } finally {
    // The selection and the programmer value are cleared whatever happened in the stage (review 4), but not while
    // the slot may be down (a throw after the press, a refused Unpress): then main() clears after cleanup.
    if (pressed.has(SLOTS.A.name)) fullClearPending = true;
    else await clearAfterFull(A);
  }
}
async function runFullStage(A) {
  if (!(await clearLine(A))) { record("FULL: command line cleared", false); return; }
  await lua(A, `Cmd('ClearAll'); Cmd('Fixture ${FIXTURE}'); return true`);
  const sel0 = await lua(A, "return SelectionCount()");
  if (DIRECT) {
    const d0 = await dimmer(A);
    await code(A, SLOTS.A, "FULL");
    const fp = await dtap(A, SLOTS.A);
    await sleep(300);
    const d1 = await dimmer(A);
    const line1 = await readCmd(A);
    await sleep(1500);
    const d2 = await dimmer(A);
    record(`FULL direct tap with Fixture ${FIXTURE} selected sets Dimmer 100 once`, sel0 >= 1 && d0 === null && accepted(fp) && d1 === 100 && d2 === 100 && line1 === "", { sel0, d0, d1, line1, d2 });
    await lua(A, "Cmd('ClearAll'); return true");
    return;
  }
  const d0 = await dimmer(A);
  if (sel0 < 1 || d0 !== null) { record(`FULL: Fixture ${FIXTURE} selected with an empty programmer first`, false, { sel0, d0 }); return; }
  await code(A, SLOTS.A, "FULL");
  const fp = await press(A, SLOTS.A);
  await sleep(300);
  const d1 = await dimmer(A);
  const line1 = await readCmd(A);
  const fu = await unpress(A, SLOTS.A);
  await sleep(300);
  const d2 = await dimmer(A);
  const line2 = await readCmd(A);
  record(`FULL with Fixture ${FIXTURE} selected sets Dimmer 100 on Press, nothing more on Unpress`, accepted(fp) && accepted(fu) && d1 === 100 && d2 === 100 && line1 === "" && line2 === "", { sel0, d0, d1, line1, d2, line2 });
  // Sustained hold: FULL down for 1.5 s on a cleared programmer acts once (Dimmer 100, line empty, MA untouched).
  await lua(A, `Cmd('ClearAll'); Cmd('Fixture ${FIXTURE}'); return true`);
  const fp2 = await press(A, SLOTS.A);
  const e1 = await dimmer(A);
  await sleep(1500);
  const e2 = await dimmer(A);
  const lineH = await readCmd(A);
  const maH = await readMa(A);
  const fu2 = await unpress(A, SLOTS.A);
  await sleep(300);
  const e3 = await dimmer(A);
  record(`FULL hold: down 1.5 s with Fixture ${FIXTURE} selected sets Dimmer 100 once, nothing on Unpress`, accepted(fp2) && accepted(fu2) && e1 === 100 && e2 === 100 && e3 === 100 && lineH === "" && maH === false, { e1, e2, lineH, maH, e3 });
  await lua(A, "Cmd('ClearAll'); return true");
}

async function runPopup(A) {
  // The operator opened the Edit Command pop-up (keyboard icon) and left it empty and focused. Its text is the
  // command line buffer (KB-10 32-35), so CmdObj().cmdtext is the readback. Escape would close the pop-up; the
  // line is cleared between sequences with the CLEAR code, which KB-10 qualified.
  const line0 = await readCmd(A);
  // A throw (not process.exit) so the caller's finally still removes the probe objects (review 5).
  if (line0 !== "") throw new Error(`the pop-up's line is not empty (${JSON.stringify(line0)}); empty it and run again`);
  const clr = async () => { await code(A, SLOTS.B, "CLEAR"); await press(A, SLOTS.B); await unpress(A, SLOTS.B); await sleep(100); return (await readCmd(A)) === ""; };
  for (const seq of POPUP_SEQUENCES) {
    // (a) one chunk: every pair inside a single Lua request (KB-10 35a shape). Each step reads its Code back and
    // checks the commands' feedback, and the chunk stops at the first problem (review 6); for executor presses the
    // slot is marked pressed before the request and cleared only when every Unpress was accepted, so an aborted
    // chunk leaves the release to cleanup. --direct: Press Quickey N alone (nothing is left down).
    const E = `${EXP}.${SLOTS.A.e}`;
    // A refused Press returns before any Unpress (review 13): no Unpress for a key not known to be down.
    const stepCmds = (name) => DIRECT ? `local fp = Cmd('Press Quickey ${SLOTS.A.q}'); local fu = 'OK'`
      : `local fp = Cmd('Press Page ${E}')
if tostring(fp):sub(1, 2) ~= 'OK' then res[#res + 1] = { code = '${name}', fp = tostring(fp), fu = 'not sent' }; return { failed = '${name}: Press ' .. tostring(fp), steps = res } end
local fu = Cmd('Unpress Page ${E}')`;
    const parts = seq.map((name) => `q:Set('Code', '${name}')
if tostring(q:Get('Code')) ~= '${name}' then return { failed = 'code ${name} reads back ' .. tostring(q:Get('Code')), steps = res } end
do ${stepCmds(name)}
res[#res + 1] = { code = '${name}', fp = tostring(fp), fu = tostring(fu) }
if tostring(fp):sub(1, 2) ~= 'OK' or tostring(fu):sub(1, 2) ~= 'OK' then return { failed = '${name}: Press ' .. tostring(fp) .. ' / Unpress ' .. tostring(fu), steps = res } end end`);
    if (!DIRECT) pressed.add(SLOTS.A.name);
    // The same ownership checks as code(): name, marker Note and the executor holding this Quickey (review 5).
    const chunk = await lua(A, `local q = ObjectList('Quickey ${SLOTS.A.q}')[1]
if not q or tostring(q.name) ~= '${SLOTS.A.name}' or tostring(q:Get('Note')) ~= '${MARKER}' then return { failed = 'not ours' } end
local h = ObjectList('Page ${E}')[1]
local o = h and h:Get('Object')
if not o or tostring(o:GetClass()) ~= 'Quickey' or tonumber(o.index) ~= ${SLOTS.A.q} then return { failed = 'executor not ours' } end
local res = {}
${parts.join("\n")}
return { ok = true, steps = res }`);
    if (!chunk || chunk.ok !== true) {
      // The marker stays only when a press may still be down: a step whose Press was accepted but whose Unpress
      // was not, or no result at all. A failure before any press, or a refused Press with an accepted Unpress,
      // leaves nothing down, so cleanup does not issue an extra Unpress (review 8).
      // The chunk reports every step it executed (an empty Lua table may arrive as {} or []); no result at all
      // means nothing is known, so the marker stays.
      const raw = chunk ? chunk.steps : undefined;
      const steps = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
      const outstanding = !chunk || steps.some((st) => String(st.fp).startsWith("OK") && !String(st.fu).startsWith("OK"));
      if (!outstanding) pressed.delete(SLOTS.A.name);
      throw new Error(`probe slot ${SLOTS.A.name}, one chunk: ${chunk && chunk.failed}; ${JSON.stringify(chunk && chunk.steps)}`);
    }
    pressed.delete(SLOTS.A.name);
    await sleep(200);
    const oneChunk = await readCmd(A);
    if (!(await clr())) { record(`${seq.join(" ")}: CLEAR empties the pop-up line`, false, await readCmd(A)); return; }
    // (b) one key per request, the shape a surface produces (one event per loop pass).
    for (const name of seq) { await code(A, SLOTS.A, name); if (DIRECT) await dtap(A, SLOTS.A); else { await press(A, SLOTS.A); await unpress(A, SLOTS.A); } }
    await sleep(200);
    const perRequest = await readCmd(A);
    if (!(await clr())) { record(`${seq.join(" ")}: CLEAR empties the pop-up line`, false, await readCmd(A)); return; }
    // (c) reference: the same keys on the plain command line (pop-up untouched: it mirrors the same buffer).
    note(`${seq.join(" ")} in the focused pop-up`, { seq, oneChunk, perRequest });
  }
  // No pass/fail here: the expected text per sequence is the command-line result of the same keys from "run"
  // (tokens), compared in the probe record together with the screenshots.
}

async function runType(A, names) {
  for (const name of names) {
    await code(A, SLOTS.A, name);
    const fp = DIRECT ? await dtap(A, SLOTS.A) : await press(A, SLOTS.A);
    const fu = DIRECT ? "OK" : await unpress(A, SLOTS.A);
    record(`${name} typed (one request per key)`, accepted(fp) && accepted(fu), { fp, fu });
    await sleep(120);
  }
}

async function main() {
  const A = new Conn("A");
  await A.connect();
  const ping = await preflight(A);
  if (mode === "cleanup") {
    note("cleanup", await cleanup(A, argv.includes("--unpress")));
    await A.end();
    return { ping };
  }
  let ready = false;
  try {
    // Inside the protected region: a setup that fails after its first slot still removes what it created
    // (cleanup only touches objects carrying the probe's name and marker).
    await setup(A);
    ready = true;
    if (mode === "run") {
      const explicit = opt("--codes", null);
      const only = explicit === null ? null : new Set(String(explicit).split(",").filter(Boolean));
      // FULL and the toggles have their own stages; the tap/hold loops take the text codes.
      const codes = only ? [...only].filter((c) => c !== "FULL" && !(c in TOGGLE_CODES)) : TEXT_CODES;
      await runCmdline(A, codes, only);
      if (!only || only.has("FULL")) await runFull(A);
    } else if (mode === "popup") {
      await runPopup(A);
    } else if (mode === "type") {
      const end = argv.findIndex((a, i) => i > 0 && a.startsWith("--"));
      await runType(A, argv.slice(1, end < 0 ? undefined : end));
    }
  } finally {
    // Cleanup first (review 9): a slot that may still be down is released (or kept) before anything else is sent,
    // and Escape is never injected while such a slot remains; a failing line clear cannot skip the cleanup.
    const left = await cleanup(A);
    if (mode === "run" && ready && pressed.size === 0) await clearLine(A).catch((e) => note("line clear after cleanup failed", String(e && e.message)));
    if (fullClearPending) {
      if (pressed.size === 0) await clearAfterFull(A);
      else record("FULL: programmer left for the operator (the slot may still be down, so ClearAll was not sent)", false);
    }
    record("probe objects removed, slots empty", Object.values(left).every((st) => !st.quickey && !st.exec), left);
    record("MASTATE false at the end", (await readMa(A)) === false);
  }
  await A.end();
  return { ping };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (!["run", "popup", "type", "cleanup"].includes(mode)) {
    console.error("usage: node scripts/kb28-probe.mjs run|popup|type|cleanup [--codes A,B] [--quickey N] [--exec P.E] [--out report.json]");
    process.exit(2);
  }
  if (!Number.isInteger(QK) || QK < 1 || !Number.isInteger(EXP) || !Number.isInteger(EXE) || EXE < 1 || EXE + 1 > 999) {
    console.error("--quickey must be a pool number and --exec a page.executor with room for two executors");
    process.exit(2);
  }
  main().then(({ ping }) => {
    const report = { probe: `kb-28-${mode}${DIRECT ? "-direct" : ""}`, date: new Date().toISOString(), bridge: { version: ping.bridgeVersion, host: ping.host, port: ping.port, build: ping.build, hostname: ping.hostname, showfile: ping.showfile }, slots: SLOTS, exec: `${EXP}.${EXE}`, passed: steps.filter((s) => s.pass === true).length, failed, steps };
    if (outFile) { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n"); console.log(`report written to ${outFile}`); }
    console.log(`${report.passed}/${steps.filter((s) => s.pass !== null).length} passed`);
    process.exit(failed ? 1 : 0);
  }).catch((e) => { console.error(`probe aborted: ${e.message}`); process.exit(2); });
}
