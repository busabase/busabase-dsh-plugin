import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandFailedError, runCommand } from "./run-command.js";

describe("runCommand", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "run-command-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("runs a real process with an argument array and returns stdout", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log('hello-e2e')"], {
      cwd: workDir,
    });
    expect(result.stdout.trim()).toBe("hello-e2e");
  });

  it("passes cwd through to the child process", async () => {
    await mkdir(join(workDir, "sub"), { recursive: true });
    await writeFile(join(workDir, "sub", "marker.txt"), "present");
    const result = await runCommand(
      process.execPath,
      ["-e", "console.log(require('node:fs').existsSync('marker.txt'))"],
      { cwd: join(workDir, "sub") },
    );
    expect(result.stdout.trim()).toBe("true");
  });

  it("throws CommandFailedError with captured stdout/stderr on non-zero exit", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "console.error('boom'); process.exit(1)"], {
        cwd: workDir,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandFailedError);
      const failure = error as CommandFailedError;
      expect(failure.stderr).toContain("boom");
      expect(failure.command).toBe(process.execPath);
      return true;
    });
  });

  it("respects an injected env without mutating process.env", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "console.log(process.env.E2E_PROBE)"],
      {
        cwd: workDir,
        env: { ...process.env, E2E_PROBE: "probe-value" },
      },
    );
    expect(result.stdout.trim()).toBe("probe-value");
    expect(process.env.E2E_PROBE).toBeUndefined();
  });
});
