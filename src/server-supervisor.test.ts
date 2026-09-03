import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { BusabaseServerSupervisor } from "./server-supervisor.js";

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
