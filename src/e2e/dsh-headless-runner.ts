import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface DshHeadlessRunOptions {
  dshBinPath: string;
  cwd: string;
  dshHome: string;
  patchPath: string;
  task: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface DshHeadlessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Runs `dsh --profile headless --patch <patchPath> <task>` as a detached
 * child (own process group) so a timeout can terminate the whole subtree —
 * DSH itself plus whatever it forked directly — with one signal to the
 * negated PID. Never `shell: true`; every argument travels as its own array
 * element so the task text can contain spaces/quotes safely.
 */
export async function runDshHeadless(
  options: DshHeadlessRunOptions,
): Promise<DshHeadlessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [options.dshBinPath, "--profile", "headless", "--patch", options.patchPath, options.task],
      {
        cwd: options.cwd,
        env: { ...options.env, DSH_HOME: options.dshHome },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, options.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

/** Sends SIGTERM to a detached child's whole process group; never throws on an already-dead process. */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    /* already exited */
  }
}

/**
 * Last-resort cleanup for a process the harness does not hold a PID for —
 * specifically the managed `busabase` child, which the plugin's own
 * supervisor spawns `detached: true` in its own process group precisely so
 * a normal DSH exit does not kill it by accident. On a harness-level
 * timeout/crash that skips DSH's own disposal path, find whatever is bound
 * to the known loopback port and kill it directly.
 *
 * `kill` and `findListenerPids` are injectable so tests can exercise the
 * decision logic without ever sending a real signal to a real PID — this
 * function's whole job is killing processes, so its own test suite must
 * never do that to whatever happens to be listening on an ephemeral port
 * during a test run (e.g. the test runner's own worker).
 */
export async function killProcessOnPort(
  port: number,
  dependencies: {
    findListenerPids?: (port: number) => Promise<string[]>;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<void> {
  const findListenerPids = dependencies.findListenerPids ?? defaultFindListenerPids;
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const pids = await findListenerPids(port);
  for (const pid of pids) {
    try {
      kill(Number(pid), "SIGTERM");
    } catch {
      /* already exited */
    }
  }
}

async function defaultFindListenerPids(port: number): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec("netstat", ["-ano", "-p", "tcp"]);
      const suffix = `:${String(port)}`;
      return stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(
          (columns) =>
            columns.length >= 5 && columns[1]?.endsWith(suffix) && columns[3] === "LISTENING",
        )
        .flatMap((columns) => (columns[4] ? [columns[4]] : []));
    }
    const { stdout } = await exec("lsof", ["-t", `-i:${String(port)}`, "-sTCP:LISTEN"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing is listening; nothing to clean up
  }
}
