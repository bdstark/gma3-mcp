import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterSaveHookPath, runAfterSaveHook } from "../src/afterSave.ts";

const waitFor = async (path: string, ms = 5000) => {
  const t0 = Date.now();
  while (!existsSync(path) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return existsSync(path);
};

test("afterSaveHookPath: default under XDG_CONFIG_HOME, override by env, empty turns it off", () => {
  assert.equal(afterSaveHookPath({ XDG_CONFIG_HOME: "/x" }), "/x/gma3-mcp/after-save");
  assert.equal(afterSaveHookPath({ GMA3_AFTER_SAVE_HOOK: "/bin/hook" }), "/bin/hook");
  assert.equal(afterSaveHookPath({ GMA3_AFTER_SAVE_HOOK: "" }), null);
});

test("runAfterSaveHook: runs the hook with the show name and the shows folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "after-save-"));
  try {
    const out = join(dir, "out.txt");
    const hook = join(dir, "after-save");
    writeFileSync(hook, `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$GMA3_SHOW_NAME" "$GMA3_SHOWS_PATH" > "${out}"\n`);
    chmodSync(hook, 0o755);
    const r = runAfterSaveHook("Rock-Club-27", "C:/shows", { PATH: process.env.PATH, GMA3_AFTER_SAVE_HOOK: hook });
    assert.deepEqual(r, { hook, started: true });
    assert.ok(await waitFor(out), "the hook did not run");
    assert.equal(readFileSync(out, "utf8"), "Rock-Club-27|Rock-Club-27|C:/shows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAfterSaveHook: an absent default hook is silent; a configured broken hook is reported, never thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "after-save-"));
  try {
    assert.equal(runAfterSaveHook("S", undefined, { XDG_CONFIG_HOME: dir }), undefined);
    assert.equal(runAfterSaveHook("S", undefined, { GMA3_AFTER_SAVE_HOOK: "" }), undefined);
    const notExec = join(dir, "hook");
    writeFileSync(notExec, "#!/bin/sh\n");
    chmodSync(notExec, 0o644);
    const r = runAfterSaveHook("S", undefined, { GMA3_AFTER_SAVE_HOOK: notExec });
    assert.equal(r?.started, false);
    assert.match(r?.error ?? "", /cannot be run/);
    const missing = runAfterSaveHook("S", undefined, { GMA3_AFTER_SAVE_HOOK: join(dir, "nope") });
    assert.equal(missing?.started, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAfterSaveHook: a spawn that throws is reported as not started", () => {
  const dir = mkdtempSync(join(tmpdir(), "after-save-"));
  try {
    const hook = join(dir, "after-save");
    writeFileSync(hook, "#!/bin/sh\n");
    chmodSync(hook, 0o755);
    const boom = (() => {
      throw new Error("EAGAIN");
    }) as unknown as Parameters<typeof runAfterSaveHook>[3];
    assert.deepEqual(runAfterSaveHook("S", undefined, { GMA3_AFTER_SAVE_HOOK: hook }, boom), { hook, started: false, error: "EAGAIN" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
