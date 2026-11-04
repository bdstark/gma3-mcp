/**
 * After-save hook: once gma3_save_show has verified a write, start a local program so the saved show can be recorded
 * elsewhere (for example committed to a git repo of show files). The hook never blocks or fails the save: the show is
 * already on disk when it starts, and the tool only reports whether it started.
 *
 *   GMA3_AFTER_SAVE_HOOK   path of the program; "" (empty) turns the hook off.
 *   default                $XDG_CONFIG_HOME/gma3-mcp/after-save (~/.config/gma3-mcp/after-save) when it exists.
 *
 * The program gets the show name as its only argument, and GMA3_SHOW_NAME / GMA3_SHOWS_PATH in its environment
 * (plus this server's own environment, e.g. GMA3_INSTALL_DIR and GMA3_BRIDGE_PORT, which identify the console).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AfterSaveResult {
  hook: string;
  started: boolean;
  error?: string;
}

type Spawn = typeof nodeSpawn;

export function afterSaveHookPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GMA3_AFTER_SAVE_HOOK !== undefined) return env.GMA3_AFTER_SAVE_HOOK.trim() || null;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gma3-mcp", "after-save");
}

/** Start the hook for a verified save. Returns undefined when no hook is configured or the default file is absent. */
export function runAfterSaveHook(
  showName: string,
  showsPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  spawn: Spawn = nodeSpawn,
): AfterSaveResult | undefined {
  const hook = afterSaveHookPath(env);
  if (!hook) return undefined;
  const explicit = env.GMA3_AFTER_SAVE_HOOK !== undefined;
  try {
    if (!statSync(hook).isFile()) throw new Error("not a file");
    accessSync(hook, constants.X_OK);
  } catch (err) {
    // A missing default hook is the normal case; a configured hook that cannot run is worth reporting.
    return explicit ? { hook, started: false, error: `the hook cannot be run (${(err as Error).message})` } : undefined;
  }
  try {
    const child = spawn(hook, [showName], {
      detached: true,
      stdio: "ignore",
      env: { ...env, GMA3_SHOW_NAME: showName, ...(showsPath ? { GMA3_SHOWS_PATH: showsPath } : {}) },
    });
    child.on("error", () => {}); // a spawn failure after this point must not crash the server
    child.unref();
    return { hook, started: true };
  } catch (err) {
    return { hook, started: false, error: (err as Error).message };
  }
}
