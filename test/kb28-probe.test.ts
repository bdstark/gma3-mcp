import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

/**
 * scripts/kb28-probe.mjs presses REAL console keys through probe Quickeys it creates, so its gate matters more than
 * its checks: it must refuse a show whose name does not look disposable, Lua off, a bridge with holds, a running
 * mtpnxk surface plugin (its keys would interleave), a console that is not idle, and occupied probe slots, all
 * before anything is created or pressed. The console behaviour itself is what the probe records.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "kb28-probe.mjs");

type Handler = (op: string, args: any) => unknown;

function startFakeBridge(handler: Handler): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          try {
            sock.write(JSON.stringify({ id: req.id, ok: true, result: handler(req.op, req.args) }) + "\n");
          } catch (e) {
            sock.write(JSON.stringify({ id: req.id, ok: false, error: String((e as Error).message) }) + "\n");
          }
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const ping = (extra: Record<string, unknown> = {}) => ({ bridgeVersion: "0.36.0", host: "127.0.0.1", port: 9800, showfile: "mcp-test-disposable", lua: { enabled: true }, input: { enabled: false, holds: 0, unresolved: 0, unresolvedFromPreviousRun: 0, busy: null }, ...extra });

/** A console whose reads answer from `state`; every write-shaped Lua chunk is recorded. */
function fakeConsole(p: unknown, state: { surface?: boolean; cmd?: string; ma?: boolean; slot?: unknown; onWrite?: (code: string) => unknown }) {
  const writes: string[] = [];
  const handler: Handler = (op, args) => {
    if (op === "ping") return p;
    if (op !== "lua") throw new Error("unexpected " + op);
    const code: string = args.code;
    if (code.includes("__mtpnxk_surface")) return { values: [state.surface ?? false] };
    if (code.includes("CmdObj().cmdtext") && !code.includes("Cmd(")) return { values: [state.cmd ?? ""] };
    if (code.includes("MAState")) return { values: [state.ma ?? false] };
    if (code.includes("ObjectList('Quickey") && code.includes("ObjectList('Page") && !code.includes("Cmd(")) return { values: [state.slot ?? { quickey: false, exec: false }] };
    writes.push(code);
    if (state.onWrite) return { values: [state.onWrite(code)] };
    throw new Error("write reached the fake console");
  };
  return { handler, writes };
}

async function expectRefusal(p: unknown, state: Parameters<typeof fakeConsole>[1], pattern: RegExp, args = ["run"]) {
  const c = fakeConsole(p, state);
  const b = await startFakeBridge(c.handler);
  try {
    const r = await run(args, { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.deepEqual(c.writes, [], "nothing was created or pressed");
  } finally { b.close(); }
}

test("refuses a show that does not look disposable and Lua off", async () => {
  await expectRefusal(ping({ showfile: "Shehds" }), {}, /disposable/);
  await expectRefusal(ping({ lua: { enabled: false } }), {}, /lua on/);
});

test("refuses a bridge that does not report its input state (review 19)", async () => {
  const { input: _omit, ...noInput } = ping();
  await expectRefusal(noInput, {}, /does not report its input state/);
});

test("refuses bridge holds and a running surface plugin", async () => {
  await expectRefusal(ping({ input: { enabled: true, holds: 1, unresolved: 0, unresolvedFromPreviousRun: 0, busy: null } }), {}, /holds or unresolved/);
  await expectRefusal(ping(), { surface: true }, /mtpnxk_surface" "stop"/);
});

test("refuses a console that is not idle and occupied probe slots", async () => {
  await expectRefusal(ping(), { cmd: "1 Thru" }, /console not idle/);
  await expectRefusal(ping(), { ma: true }, /MASTATE=true/);
  await expectRefusal(ping(), { slot: { quickey: { name: "Operator", code: "NUM1" }, exec: false } }, /not empty/);
});

test("rejects unknown modes and bad slot options before connecting", async () => {
  for (const args of [["probe"], ["run", "--exec", "1.999"], ["run", "--quickey", "x"]]) {
    const r = await run(args, { GMA3_BRIDGE_PORT: "1" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  }
});

test("a refused connection aborts with exit 2 instead of exiting silently", async () => {
  const r = await run(["run"], { GMA3_BRIDGE_PORT: "1" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot connect to the bridge/);
});

test("cleanup leaves a foreign Quickey named like a probe slot (no marker) and its executor in place", async () => {
  const c = fakeConsole(ping(), { slot: { quickey: { name: "KB28 A", code: "NUM1", note: "operator" }, exec: { class: "Quickey", name: "KB28 A", index: 960 } } });
  const b = await startFakeBridge(c.handler);
  try {
    const r = await run(["cleanup"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /left in place/);
    assert.deepEqual(c.writes, [], "nothing was unpressed or deleted");
  } finally { b.close(); }
});

test("refuses enabled bridge input or open input sessions, and popup mode with MA held", async () => {
  const input = { enabled: true, holds: 0, unresolved: 0, unresolvedFromPreviousRun: 0, busy: null, sessions: 0 };
  await expectRefusal(ping({ input }), {}, /without input/);
  await expectRefusal(ping({ input: { ...input, enabled: false, sessions: 1 } }), {}, /1 session/);
  await expectRefusal(ping(), { ma: true }, /MASTATE=true/, ["popup"]);
});

test("setup removes a new Quickey in the same request when the console ignores its ownership Note", async () => {
  const c = fakeConsole(ping(), { onWrite: (code) => (code.includes("Store Quickey") ? "marker not applied; removed" : true) });
  const b = await startFakeBridge(c.handler);
  try {
    const r = await run(["run"], { GMA3_BRIDGE_PORT: String(b.port) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /ignored the ownership Note/);
    assert.equal(c.writes.length, 1, "only the setup request of the first slot was sent");
    const chunk = c.writes[0];
    const check = chunk.indexOf("q:Get('Note')"), del = chunk.indexOf("Delete Quickey"), name = chunk.indexOf("q:Set('Name'"), assign = chunk.indexOf("Assign Quickey");
    assert.ok(check > 0 && del > check && name > del && assign > name, "the marker is verified, and a failed one deleted, before the rename and the Assign");
  } finally { b.close(); }
});
