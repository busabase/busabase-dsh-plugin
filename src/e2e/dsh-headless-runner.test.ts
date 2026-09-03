import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killProcessOnPort, killProcessTree, runDshHeadless } from "./dsh-headless-runner.js";

describe("runDshHeadless", () => {
  let workDir: string;
  let fakeDshPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "dsh-headless-"));
    fakeDshPath = join(workDir, "fake-dsh.js");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("runs the fake dsh binary and captures stdout/exit code", async () => {
    await writeFile(
      fakeDshPath,
      "const [, , profileFlag, profileName, patchFlag, patchPath, task] = process.argv;\n" +
        "console.log(JSON.stringify({ profileFlag, profileName, patchFlag, patchPath, task }));\n" +
        "process.exit(0);\n",
    );

    const result = await runDshHeadless({
      dshBinPath: fakeDshPath,
      cwd: workDir,
      dshHome: join(workDir, ".dsh"),
      patchPath: join(workDir, "patch.yml"),
      task: "run the E2E task",
      env: { ...process.env },
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({
      profileFlag: "--profile",
      profileName: "headless",
      patchFlag: "--patch",
      patchPath: join(workDir, "patch.yml"),
      task: "run the E2E task",
    });
  });

  it("sets DSH_HOME from the given option, overriding any ambient value", async () => {
    await writeFile(fakeDshPath, "console.log(process.env.DSH_HOME); process.exit(0);\n");
    const result = await runDshHeadless({
      dshBinPath: fakeDshPath,
      cwd: workDir,
      dshHome: join(workDir, "isolated-home"),
      patchPath: join(workDir, "patch.yml"),
      task: "task",
      env: { ...process.env, DSH_HOME: "/should-be-overridden" },
      timeoutMs: 5_000,
    });
    expect(result.stdout.trim()).toBe(join(workDir, "isolated-home"));
  });

  it("marks timedOut and terminates a hanging process", async () => {
    await writeFile(fakeDshPath, "setInterval(() => {}, 1000);\n");
    const result = await runDshHeadless({
      dshBinPath: fakeDshPath,
      cwd: workDir,
      dshHome: join(workDir, ".dsh"),
      patchPath: join(workDir, "patch.yml"),
      task: "task",
      env: { ...process.env },
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("resolves with a non-zero exit code for a nonexistent script path", async () => {
    const result = await runDshHeadless({
      dshBinPath: join(workDir, "does-not-exist.js"),
      cwd: workDir,
      dshHome: join(workDir, ".dsh"),
      patchPath: join(workDir, "patch.yml"),
      task: "task",
      env: { ...process.env },
      timeoutMs: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/does-not-exist\.js/);
  });
});

describe("killProcessTree", () => {
  it("does nothing for an undefined pid", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
  });

  it("does not throw for an already-dead pid", () => {
    expect(() => killProcessTree(999_999_999)).not.toThrow();
  });
});

describe("killProcessOnPort", () => {
  it("uses the real lsof-backed lookup by default and finds nothing on an unused port", async () => {
    await expect(killProcessOnPort(65_432)).resolves.toBeUndefined();
  });

  it("kills every pid the injected lookup reports, via the injected kill function", async () => {
    const findListenerPids = vi.fn().mockResolvedValue(["111", "222"]);
    const kill = vi.fn();
    await killProcessOnPort(34_567, { findListenerPids, kill });
    expect(findListenerPids).toHaveBeenCalledWith(34_567);
    expect(kill).toHaveBeenCalledWith(111, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(222, "SIGTERM");
  });

  it("swallows a kill failure for a pid that already exited", async () => {
    const findListenerPids = vi.fn().mockResolvedValue(["111"]);
    const kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    await expect(killProcessOnPort(34_567, { findListenerPids, kill })).resolves.toBeUndefined();
  });

  it("does nothing when the injected lookup reports no listeners", async () => {
    const findListenerPids = vi.fn().mockResolvedValue([]);
    const kill = vi.fn();
    await killProcessOnPort(34_567, { findListenerPids, kill });
    expect(kill).not.toHaveBeenCalled();
  });
});
