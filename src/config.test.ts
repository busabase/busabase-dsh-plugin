import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("derives Desktop defaults", () => {
    expect(resolveConfig()).toMatchObject({
      baseUrl: "http://localhost:15419",
      spaceId: null,
      mcpUrl: "http://localhost:15419/api/mcp",
      serverName: "busabase",
      connection: { mode: "local" },
      server: {
        mode: "auto",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: [
          "exec",
          "--yes",
          "--package",
          "busabase@latest",
          "--",
          "busabase",
          "server",
          "--host",
          "127.0.0.1",
          "--port",
          "15419",
        ],
        manageable: true,
        host: "127.0.0.1",
        port: 15419,
        env: { NEXT_PUBLIC_APP_URL: "http://localhost:15419" },
        stopOnDispose: true,
      },
      baseIframe: { enabled: true },
      airAppIframe: { enabled: true },
      changeRequestIframe: { enabled: true },
      confirmations: { review: true, merge: true, close: true },
    });
  });

  it("allows Base embedding to be disabled independently", () => {
    expect(resolveConfig({ baseIframe: { enabled: false } })).toMatchObject({
      baseIframe: { enabled: false },
      airAppIframe: { enabled: true },
      changeRequestIframe: { enabled: true },
    });
  });

  it("normalizes a trailing slash and honors explicit MCP URL", () => {
    expect(
      resolveConfig({ baseUrl: "http://127.0.0.1:15419/", mcpUrl: "http://example.test/mcp" }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:15419",
      mcpUrl: "http://example.test/mcp",
    });
  });

  it("rejects an unstable MCP namespace", () => {
    expect(() => resolveConfig({ serverName: "not valid" })).toThrow(/serverName/);
  });

  it("treats remote auto servers as external", () => {
    const resolved = resolveConfig({ baseUrl: "https://busabase.example" });
    expect(resolved.server).toMatchObject({
      mode: "auto",
      manageable: false,
      host: "busabase.example",
      port: 443,
    });
    expect(resolved.connection).toEqual({ mode: "remote" });
  });

  it("rejects a non-loopback http baseUrl", () => {
    expect(() => resolveConfig({ baseUrl: "http://busabase.example" })).toThrow(/https/);
  });

  it("rejects credentials embedded in either URL", () => {
    expect(() => resolveConfig({ baseUrl: "https://user:secret@busabase.example" })).toThrow(
      /credentials/,
    );
    expect(() =>
      resolveConfig({
        baseUrl: "https://busabase.example",
        mcpUrl: "https://token@busabase.example/api/mcp",
      }),
    ).toThrow(/credentials/);
  });

  it("requires a custom remote MCP URL to use https", () => {
    expect(() =>
      resolveConfig({
        baseUrl: "https://busabase.example",
        mcpUrl: "http://127.0.0.1:3000/api/mcp",
      }),
    ).toThrow(/mcpUrl.*https/);
  });

  it("keeps loopback baseUrl in local mode even when https", () => {
    expect(resolveConfig({ baseUrl: "https://localhost:15419" }).connection).toEqual({
      mode: "local",
    });
  });

  it("preserves an explicit root-host Cloud space id", () => {
    expect(
      resolveConfig({ baseUrl: "https://busabase.example", spaceId: " org_1 " }),
    ).toMatchObject({ spaceId: "org_1" });
  });

  it("passes a bare IPv6 loopback address to the managed server command", () => {
    expect(resolveConfig({ baseUrl: "http://[::1]:15419" }).server).toMatchObject({
      manageable: true,
      host: "::1",
      args: expect.arrayContaining(["--host", "::1"]),
    });
  });

  it("rejects managed mode for a remote server", () => {
    expect(() =>
      resolveConfig({ baseUrl: "https://busabase.example", server: { mode: "managed" } }),
    ).toThrow(/loopback/);
  });

  it("accepts a custom launch command without exposing it through HTTP", () => {
    expect(
      resolveConfig({
        server: { command: "custom-busabase", args: ["server"], env: { TEST: "1" }, cwd: "/tmp" },
      }).server,
    ).toMatchObject({
      command: "custom-busabase",
      args: ["server"],
      env: { TEST: "1" },
      cwd: "/tmp",
    });
  });
});
