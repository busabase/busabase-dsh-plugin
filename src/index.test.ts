// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { apply, inject } from "./index.js";

vi.mock("./oauth-mcp-client.js", () => ({
  connectRemoteMcp: vi.fn(() => ({
    ready: Promise.resolve({}),
    dispose: vi.fn().mockResolvedValue(undefined),
    createChangeRequestEmbedLink: vi.fn(),
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
  const listenerCallbacks: Array<(...args: unknown[]) => unknown> = [];
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
    on: (event: string, callback: (...args: unknown[]) => unknown) => {
      listeners.push(event);
      listenerCallbacks.push(callback);
      return vi.fn();
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    get: vi.fn(() => undefined),
    inject: (_dependencies: string[], callback: (injected: typeof ctx) => unknown) => callback(ctx),
    plugin: (plugin: unknown, config: Record<string, unknown>) => {
      plugins.push({ plugin, config });
    },
  };
  return {
    ctx,
    sections,
    plugins,
    guard,
    tools,
    routes,
    skillProviders,
    listeners,
    listenerCallbacks,
    disposers,
  };
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
      createChangeRequestEmbedLink: vi.fn(),
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
    // The remote ChangeRequest preview augmentation registers its own post-execute listener.
    expect(listeners).toEqual(["tools/post-execute"]);
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

  it("mints a ChangeRequest embed link via the current handle after a pending create, preserving targetSpaceId and cancellation", async () => {
    const { ctx, listenerCallbacks } = createHostCtx();
    const credentials = { readRecord: vi.fn(), modifyRecord: vi.fn(), deleteRecord: vi.fn() };
    ctx.get = vi.fn((name: string) => (name === "credentials" ? credentials : undefined)) as never;
    const createChangeRequestEmbedLink = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: {
        id: "emb_1",
        typeId: "crq_1",
        url: "https://busabase.example/embed/emb_1",
        iframeUrl: "https://busabase.example/embed/emb_1?view=iframe",
      },
    });
    vi.mocked(connectRemoteMcp).mockReturnValueOnce({
      ready: Promise.resolve({}),
      dispose: vi.fn().mockResolvedValue(undefined),
      createChangeRequestEmbedLink,
    });

    await apply(ctx as never, { baseUrl: "https://busabase.example" });
    const postExecute = listenerCallbacks[0] as (
      exec: { name: string; arguments: unknown; signal: AbortSignal },
      result: { isError: boolean; value: unknown; content: unknown[] },
      next: () => Promise<{ kind: "accept" }>,
    ) => Promise<{ kind: string; content?: unknown[] }>;
    const signal = new AbortController().signal;
    const decision = await postExecute(
      { name: "mcp__busabase__node_create", arguments: { targetSpaceId: "spc_1" }, signal },
      {
        isError: false,
        value: { id: "crq_1", type: "change_request", status: "in_review" },
        content: [{ type: "text", text: "{}" }],
      },
      async () => ({ kind: "accept" }),
    );
    expect(createChangeRequestEmbedLink).toHaveBeenCalledWith("crq_1", "spc_1", signal);
    expect(decision.kind).toBe("accept");
    expect(decision.content).toHaveLength(2);
    const appended = JSON.parse((decision.content?.[1] as { text: string }).text);
    expect(appended).toMatchObject({
      type: "change-request",
      typeId: "crq_1",
      autoPreview: true,
    });
  });

  it("rejects with the original cause when the initial Cloud connection fails", async () => {
    const { ctx } = createHostCtx();
    const credentials = { readRecord: vi.fn(), modifyRecord: vi.fn(), deleteRecord: vi.fn() };
    ctx.get = vi.fn((name: string) => (name === "credentials" ? credentials : undefined)) as never;
    const connectError = new Error("oauth authorization denied");
    vi.mocked(connectRemoteMcp).mockReturnValueOnce({
      ready: Promise.resolve({ error: connectError }),
      dispose: vi.fn().mockResolvedValue(undefined),
      createChangeRequestEmbedLink: vi.fn(),
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
