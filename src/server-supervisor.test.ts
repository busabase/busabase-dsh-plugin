import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import {
  BusabaseServerSupervisor,
  buildWindowsShellCommand,
  needsWindowsShell,
} from "./server-supervisor.js";

function response(body: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: 32123,
    kill: vi.fn(),
  });
  return child;
}

describe("BusabaseServerSupervisor", () => {
  it("reuses a healthy external Busabase instance", async () => {
    const spawn = vi.fn();
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      fetch: vi.fn().mockResolvedValue(response({ service: "busabase", status: "ok" })),
      spawn: spawn as never,
    });
    await expect(supervisor.ensure()).resolves.toEqual({
      ok: true,
      baseUrl: "http://localhost:15419",
      owned: false,
      reused: true,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a foreign service on the configured port", async () => {
    const spawn = vi.fn();
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      fetch: vi.fn().mockResolvedValue(response({ service: "other", status: "ok" })),
      spawn: spawn as never,
    });
    await expect(supervisor.ensure()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/non-Busabase/),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent startup and marks the child as owned", async () => {
    let running = false;
    const child = childProcess();
    const spawn = vi.fn(() => {
      running = true;
      return child;
    });
    const fetch = vi.fn(async () => {
      if (!running) throw new Error("offline");
      return response({ service: "busabase", status: "ok" });
    });
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      fetch: fetch as never,
      spawn: spawn as never,
    });
    const [first, second] = await Promise.all([supervisor.ensure(), supervisor.ensure()]);
    expect(first).toEqual({
      ok: true,
      baseUrl: "http://localhost:15419",
      owned: true,
      reused: false,
    });
    expect(second).toEqual(first);
    expect(spawn).toHaveBeenCalledOnce();
    await expect(supervisor.status()).resolves.toMatchObject({ phase: "running", owned: true });
  });

  it("reports early child failure and permits a later retry", async () => {
    const firstChild = childProcess();
    firstChild.exitCode = 1;
    const secondChild = childProcess();
    let running = false;
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => firstChild)
      .mockImplementationOnce(() => {
        running = true;
        return secondChild;
      });
    const fetch = vi.fn(async () => {
      if (!running) throw new Error("offline");
      return response({ service: "busabase", status: "ok" });
    });
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      fetch: fetch as never,
      spawn: spawn as never,
    });
    await expect(supervisor.ensure()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/exited/),
    });
    await expect(supervisor.ensure()).resolves.toMatchObject({
      ok: true,
      owned: true,
      reused: false,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("includes bounded stderr when the child exits before readiness", async () => {
    const child = childProcess();
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
      spawn: vi.fn(() => {
        queueMicrotask(() => {
          child.stderr?.emit("data", "npm could not resolve busabase");
          child.exitCode = 1;
        });
        return child;
      }) as never,
      delay: vi.fn().mockResolvedValue(undefined),
    });
    await expect(supervisor.ensure()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("npm could not resolve busabase"),
    });
  });

  it("times out, stops the startup child, and remains retryable", async () => {
    vi.useFakeTimers();
    try {
      const child = childProcess();
      const killWindowsTree = vi.fn().mockResolvedValue(undefined);
      const supervisor = new BusabaseServerSupervisor(
        resolveConfig({ server: { startupTimeoutMs: 1_000 } }),
        {
          platform: "win32",
          killWindowsTree,
          fetch: vi.fn().mockRejectedValue(new Error("offline")),
          spawn: vi.fn(() => child) as never,
        },
      );
      const startup = supervisor.ensure();
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(startup).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/1000ms/),
      });
      expect(killWindowsTree).toHaveBeenCalledWith(32123);
      await expect(supervisor.status()).resolves.toMatchObject({ phase: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops only an owned process on disposal", async () => {
    let running = false;
    const child = childProcess();
    const killWindowsTree = vi.fn().mockResolvedValue(undefined);
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      platform: "win32",
      killWindowsTree,
      spawn: vi.fn(() => {
        running = true;
        return child;
      }) as never,
      fetch: vi.fn(async () => {
        if (!running) throw new Error("offline");
        return response({ service: "busabase", status: "ok" });
      }) as never,
    });
    await supervisor.ensure();
    await supervisor.dispose();
    expect(killWindowsTree).toHaveBeenCalledWith(32123);

    const externalKill = vi.fn();
    const external = new BusabaseServerSupervisor(resolveConfig(), {
      platform: "win32",
      killWindowsTree: externalKill,
      fetch: vi.fn().mockResolvedValue(response({ service: "busabase", status: "ok" })),
    });
    await external.ensure();
    await external.dispose();
    expect(externalKill).not.toHaveBeenCalled();
  });

  it("does not spawn remote servers in auto mode", async () => {
    const spawn = vi.fn();
    const supervisor = new BusabaseServerSupervisor(
      resolveConfig({ baseUrl: "https://busabase.example" }),
      {
        fetch: vi.fn().mockRejectedValue(new Error("offline")),
        spawn: spawn as never,
      },
    );
    await expect(supervisor.ensure()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/external/),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

/**
 * Local mode was completely dead on Windows: the default server command is
 * `npm.cmd`, and since Node's April 2024 security fix `spawn` refuses a
 * `.cmd`/`.bat` under `shell: false` with EINVAL — so `busabase_start` never
 * got past launch. `platform` and `spawn` are both injectable, so the Windows
 * branch is exercised here from any OS.
 */
describe("Windows launcher handling", () => {
  it("only asks for a shell where one is actually required", () => {
    expect(needsWindowsShell("win32", "npm.cmd")).toBe(true);
    expect(needsWindowsShell("win32", "NPM.CMD")).toBe(true);
    expect(needsWindowsShell("win32", "pnpm.bat")).toBe(true);
    // A real executable on Windows still goes through the safe argv path.
    expect(needsWindowsShell("win32", "node.exe")).toBe(false);
    expect(needsWindowsShell("win32", "node")).toBe(false);
    // POSIX never takes the shell path, whatever the command is called.
    expect(needsWindowsShell("linux", "npm.cmd")).toBe(false);
    expect(needsWindowsShell("darwin", "npm")).toBe(false);
  });

  it("quotes a data dir containing spaces instead of letting cmd.exe split it", () => {
    const line = buildWindowsShellCommand("npm.cmd", [
      "exec",
      "--package",
      "busabase@latest",
      "--data",
      String.raw`C:\Users\John Smith\busabase`,
    ]);
    // The path survives as ONE argument...
    expect(line).toContain(String.raw`"C:\Users\John Smith\busabase"`);
    // ...while tokens that need no quoting stay bare.
    expect(line.startsWith("npm.cmd exec --package busabase@latest --data ")).toBe(true);
  });

  it("escapes an embedded double quote rather than ending the argument early", () => {
    expect(buildWindowsShellCommand("npm.cmd", ['a"b'])).toBe('npm.cmd "a""b"');
  });

  it("launches npm.cmd through a shell as a single quoted command line", async () => {
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const supervisor = new BusabaseServerSupervisor(
      resolveConfig({ server: { command: "npm.cmd", dataDir: String.raw`C:\bb data` } }),
      {
        platform: "win32",
        killWindowsTree: vi.fn().mockResolvedValue(undefined),
        fetch: vi.fn().mockRejectedValue(new Error("offline")),
        spawn: spawn as never,
      },
    );
    void supervisor.ensure();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    const [command, args, options] = spawn.mock.calls[0] as [string, string[], { shell?: boolean }];
    expect(options.shell).toBe(true);
    // argv must be empty — everything is in the command line we quoted ourselves.
    expect(args).toEqual([]);
    expect(command.startsWith("npm.cmd ")).toBe(true);
    expect(command).toContain(String.raw`"C:\bb data"`);
    await supervisor.dispose?.();
  });

  it("leaves POSIX on a real argv array with no shell", async () => {
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const supervisor = new BusabaseServerSupervisor(resolveConfig(), {
      platform: "linux",
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
      spawn: spawn as never,
    });
    void supervisor.ensure();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    const [command, args, options] = spawn.mock.calls[0] as [string, string[], { shell?: boolean }];
    expect(command).toBe("npm");
    expect(args).toContain("exec");
    expect(args.length).toBeGreaterThan(1);
    expect(options.shell).toBeUndefined();
    await supervisor.dispose?.();
  });
});
