import { type ChildProcess, spawn } from "node:child_process";

export interface DshWebRunOptions {
  dshBinPath: string;
  cwd: string;
  dshHome: string;
  patchPath: string;
  host: string;
  port: number;
  env: Record<string, string | undefined>;
  /** Max time to wait for the "dsh web: http://…" ready line on stdout. */
  readyTimeoutMs: number;
}

export interface DshWebRunHandle {
  child: ChildProcess;
  url: string;
  stop: () => Promise<void>;
  output: () => string;
}

const READY_LINE = /dsh web: (https?:\/\/\S+)/;

/**
 * Spawns `dsh --profile web --patch <patchPath> --port <port> --no-open` as a
 * long-lived detached child (own process group, mirroring
 * `runDshHeadless`/the managed Busabase child) and resolves once the process
 * prints its "dsh web: http://…" ready line on stdout — the same signal a
 * human reads off their terminal — rather than polling the port, so a
 * misconfigured patch that fails before ever binding still surfaces as a
 * clear rejection instead of a generic connect-refused loop.
 */
export async function runDshWeb(options: DshWebRunOptions): Promise<DshWebRunHandle> {
  const child = spawn(
    process.execPath,
    [
      options.dshBinPath,
      "--profile",
      "web",
      "--patch",
      options.patchPath,
      "--host",
      options.host,
      "--port",
      String(options.port),
      "--no-open",
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, DSH_HOME: options.dshHome },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-32_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-32_000);
  });

  const url = await waitForReadyLine(child, () => output, options.readyTimeoutMs);

  const stop = async (): Promise<void> => {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      child.once("close", () => resolveStop());
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
      } catch {
        resolveStop();
      }
    });
  };

  return { child, url, stop, output: () => output };
}

function waitForReadyLine(
  child: ChildProcess,
  getOutput: () => string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `dsh web did not print a ready line within ${String(timeoutMs)}ms: ${getOutput()}`,
        ),
      );
    }, timeoutMs);

    const onData = (): void => {
      const match = READY_LINE.exec(getOutput());
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`dsh web exited early (code=${String(code)}): ${getOutput()}`));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("close", onExit);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("close", onExit);
  });
}
