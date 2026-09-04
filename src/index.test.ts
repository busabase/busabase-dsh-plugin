// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { apply, inject } from "./index.js";

vi.mock("./oauth-mcp-client.js", () => ({
  connectRemoteMcp: vi.fn(() => ({
    ready: Promise.resolve({}),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { connectRemoteMcp } = await import("./oauth-mcp-client.js");

function createHostCtx() {
  const sections: unknown[] = [];
  const plugins: Array<{ plugin: unknown; config: Record<string, unknown> }> = [];
  const guard = vi.fn();
  const tools: Array<Record<string, unknown>> = [];
  const routes: Array<Record<string, unknown>> = [];
  const skillProviders: unknown[] = [];
  const listeners: string[] = [];
  const disposers: Array<() => unknown> = [];
  const ctx = {
    systemPrompt: {
      section: (section: unknown) => {
        sections.push(section);
        return vi.fn();
      },
    },
    tools: {
      guard,
      register: (tool: Record<string, unknown>) => {
        tools.push(tool);
        return vi.fn();
      },
      get: vi.fn(() => ({ name: "mcp__busabase__busabase_guide" })),
    },
    webServer: {
      register: (route: Record<string, unknown>) => {
        routes.push(route);
        return vi.fn();
      },
    },
    skills: {
      registerProvider: (
        create: (control: { signal: AbortSignal; invalidate: () => void }) => unknown,
      ) => {
        skillProviders.push(create({ signal: new AbortController().signal, invalidate: vi.fn() }));
        return vi.fn();
      },
    },
    effect: (factory: () => unknown) => {
      const dispose = factory();
      if (typeof dispose === "function") disposers.push(dispose as () => unknown);
      return dispose;
    },
    on: (event: string) => {
      listeners.push(event);
      return vi.fn();
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    get: vi.fn(() => undefined),
    inject: (_dependencies: string[], callback: (injected: typeof ctx) => unknown) => callback(ctx),
    plugin: (plugin: unknown, config: Record<string, unknown>) => {
      plugins.push({ plugin, config });
    },
  };
  return { ctx, sections, plugins, guard, tools, routes, skillProviders, listeners, disposers };
}

describe("host plugin wiring", () => {
  it("mounts deterministic Busabase MCP with the changeRequest ceiling", async () => {
    const { ctx, sections, plugins, guard, tools, routes, skillProviders, listeners } =
      createHostCtx();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ service: "busabase", status: "ok" }),
      }),
    );
    await apply(ctx as never);
    expect(inject).toEqual(["systemPrompt", "tools", "skills"]);
    expect(skillProviders).toEqual([expect.objectContaining({ name: "busabase-bundled" })]);
    expect(sections).toEqual([expect.objectContaining({ name: "busabase:workspace", order: 160 })]);
    expect(plugins[0]?.config).toMatchObject({
      transport: "streamable-http",
      serverName: "busabase",
      url: "http://localhost:15419/api/mcp",
      headers: {
        "x-busabase-relay-permission-level": "changeRequest",
        "x-busabase-space": "local",
      },
      failOnStartupError: false,
      reconnect: { enabled: true },
    });
    expect(tools).toEqual([expect.objectContaining({ name: "busabase_start" })]);
    expect(guard).not.toHaveBeenCalled();
    expect(routes).toEqual([expect.objectContaining({ kind: "prefix", path: "/busabase-api" })]);
    expect(listeners).toContain("tools/post-execute");
    await expect(
      (
        tools[0]?.execute as (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
      )({}, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      ok: true,
      reused: true,
      owned: false,
      mcpReady: true,
    });
  });

  it("skips local-only wiring, connects via OAuth, and waits for readiness for a remote baseUrl", async () => {
    const { ctx, plugins, tools, routes, listeners, disposers } = createHostCtx();
    const credentials = { readRecord: vi.fn(), modifyRecord: vi.fn(), deleteRecord: vi.fn() };
    ctx.get = vi.fn((name: string) => (name === "credentials" ? credentials : undefined)) as never;
    let resolveReady: (outcome: { error?: unknown }) => void = () => {};
    const dispose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(connectRemoteMcp).mockReturnValueOnce({
      ready: new Promise((resolve) => {
        resolveReady = resolve;
      }),
      dispose,
    });

    let settled = false;
    const applyPromise = apply(ctx as never, { baseUrl: "https://busabase.example" }).then(() => {
      settled = true;
    });

    // apply() must not resolve before the remote handle reports readiness.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(plugins).toEqual([]);
    expect(tools).toEqual([]);
    expect(routes).toEqual([]);
    expect(listeners).toEqual([]);
    expect(connectRemoteMcp).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ connection: { mode: "remote" } }),
      credentials,
    );
    // The disposer is registered up front, before readiness settles, so Cordis can roll it back.
    expect(disposers).toHaveLength(1);

    resolveReady({});
    await expect(applyPromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("rejects with the original cause when the initial Cloud connection fails", async () => {
    const { ctx } = createHostCtx();
    const credentials = { readRecord: vi.fn(), modifyRecord: vi.fn(), deleteRecord: vi.fn() };
    ctx.get = vi.fn((name: string) => (name === "credentials" ? credentials : undefined)) as never;
    const connectError = new Error("oauth authorization denied");
    vi.mocked(connectRemoteMcp).mockReturnValueOnce({
      ready: Promise.resolve({ error: connectError }),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    let caught: unknown;
    try {
      await apply(ctx as never, { baseUrl: "https://busabase.example" });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/initial Cloud MCP connection failed/);
    expect((caught as Error).cause).toBe(connectError);
  });

  it("throws from its effect when credentials are unavailable for a remote baseUrl", async () => {
    const { ctx } = createHostCtx();
    await expect(apply(ctx as never, { baseUrl: "https://busabase.example" })).rejects.toThrow(
      /credentials/,
    );
  });
});
