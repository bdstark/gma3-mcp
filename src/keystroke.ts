/**
 * Types a command into grandMA3 onPC on this Mac: brings the onPC process (app_gma3) to the front, types the text and
 * presses Return, through System Events (macOS Accessibility). gma3_load_show uses it to start the bridge again after
 * a load unloaded it, without opening OSC command input to the network.
 *
 * Needs: macOS, onPC running on the same machine as this server, and Accessibility permission for the process that
 * runs the server (System Settings > Privacy & Security > Accessibility). The keys go to whatever has the keyboard
 * focus in onPC, normally its command line; a text field or dialog that has the focus receives them instead.
 */
import { execFile } from "node:child_process";

const ONPC_PROCESS = "app_gma3";
const SCRIPT = [
  "on run argv",
  'tell application "System Events"',
  `set frontmost of (first process whose name is "${ONPC_PROCESS}") to true`,
  "delay 0.3",
  "keystroke (item 1 of argv)",
  "key code 36",
  "end tell",
  "end run",
].join("\n");

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      // execFile's error carries the exit status as a number (or a string code when the file could not run).
      const status = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof status === "number" ? status : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) });
    });
  });
}

export class KeystrokeSender {
  readonly description = `keystrokes into ${ONPC_PROCESS} (macOS System Events)`;

  /** True on macOS when an onPC process runs on this machine. */
  async available(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    const r = await run("/usr/bin/pgrep", ["-x", ONPC_PROCESS], 3000);
    return r.code === 0 && r.stdout.trim() !== "";
  }

  /** Type `command` into onPC and press Return. Rejects with osascript's message (e.g. no Accessibility permission). */
  async sendCommand(command: string): Promise<void> {
    if (/[\r\n]/.test(command)) throw new Error("a command typed into onPC must be one line");
    const r = await run("/usr/bin/osascript", ["-e", SCRIPT, command], 10000);
    if (r.code !== 0) throw new Error(`osascript failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
}
