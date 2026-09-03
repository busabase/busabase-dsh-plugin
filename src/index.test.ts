// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { apply, inject } from "./index.js";

describe("host plugin wiring", () => {
  it("mounts deterministic Busabase MCP with the changeRequest ceiling", async () => {
    const sections: unknown[] = [];
    const plugins: Array<{ plugin: unknown; config: Record<string, unknown> }> = [];
    const guard = vi.fn();
    const tools: Array<Record<string, unknown>> = [];
    const routes: Array<Record<string, unknown>> = [];
    const skillProviders: unknown[] = [];
    const listeners: string[] = [];
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
          skillProviders.push(
            create({ signal: new AbortController().signal, invalidate: vi.fn() }),
          );
          return vi.fn();
        },
      },
      effect: (factory: () => unknown) => factory(),
      on: (event: string) => {
        listeners.push(event);
        return vi.fn();
      },
      logger: { warn: vi.fn() },
      inject: (_dependencies: string[], callback: (injected: typeof ctx) => unknown) =>
        callback(ctx),
      plugin: (plugin: unknown, config: Record<string, unknown>) => {
        plugins.push({ plugin, config });
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ service: "busabase", status: "ok" }),
      }),
    );
    apply(ctx as never);
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
});
