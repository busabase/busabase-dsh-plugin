import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Thin wrapper over `execFile` (never `shell: true`) so every process this
 * E2E harness starts takes an argument array instead of an interpolated
 * command string. Failures include stdout/stderr so a caller can redact and
 * report them without re-running the command.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  try {
    const { stdout, stderr } = await exec(command, args as string[], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message: string };
    throw new CommandFailedError(
      command,
      args,
      execError.stdout ?? "",
      execError.stderr ?? "",
      execError.message,
    );
  }
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly stdout: string,
    readonly stderr: string,
    reason: string,
  ) {
    super(`command failed: ${command} ${args.join(" ")} — ${reason}`);
    this.name = "CommandFailedError";
  }
}
