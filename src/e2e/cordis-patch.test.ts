import { resolve } from "node:path";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";
import { buildCordisPatch } from "./cordis-patch.js";

const bundledPatchPath = resolve(process.cwd(), "cordis.patch.yml");

const baseInput = {
  sessionRoot: "/tmp/dsh-sessions",
  llmProvider: {
    providerId: "busabase-dsh-e2e",
    apiKeyEnv: "BUSABASE_DSH_E2E_API_KEY",
    baseURL: "https://example.invalid/v1",
    modelId: "example/model-1",
  },
  busabase: {
    serverName: "busabase",
    host: "127.0.0.1",
    port: 34567,
    dataDir: "/tmp/e2e-data",
    npmCacheDir: "/tmp/e2e-data/npm-cache",
    startupTimeoutMs: 60_000,
    mcpReadyTimeoutMs: 60_000,
  },
};

describe("buildCordisPatch", () => {
  it("routes the llm-pi-ai provider by env-only api key, never the value", () => {
    const patch = buildCordisPatch(baseInput);
    const provider = (patch[0] as { config: { providers: Record<string, unknown> } }).config
      .providers["busabase-dsh-e2e"] as Record<string, unknown>;
    expect(provider).toEqual({
      apiKeyEnv: "BUSABASE_DSH_E2E_API_KEY",
      api: "openai-completions",
      baseURL: "https://example.invalid/v1",
      models: [{ id: "example/model-1", input: ["text", "image"] }],
    });
    expect(JSON.stringify(patch)).not.toMatch(/sk-|apiKey"\s*:/);
  });

  it("points agent-default-model at the same provider/model route", () => {
    const patch = buildCordisPatch(baseInput);
    expect(patch[1]).toEqual({
      id: "agent-default-model",
      config: { provider: "busabase-dsh-e2e", model: "example/model-1" },
    });
  });

  it("configures the existing bundled busabase entry by id for a managed loopback child, without inserting a second one", () => {
    const patch = buildCordisPatch(baseInput);
    expect(patch[2]).toEqual({
      id: "session-persistence-jsonl",
      config: { root: "/tmp/dsh-sessions", compression: "none", packChunks: false },
    });

    // Regression guard (PUL-147): `dsh plugin add` already applies the
    // package's bundled dsh.bundle.patch, which inserts the `busabase`
    // loader entry. This patch must never insert a second one, or Cordis
    // throws `duplicate loader entry id: busabase`.
    expect(
      patch.some((entry) => entry !== null && typeof entry === "object" && "insert" in entry),
    ).toBe(false);

    const busabaseEntry = patch.find(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { id?: unknown }).id === "busabase",
    );
    expect(busabaseEntry).toEqual({
      id: "busabase",
      config: {
        baseUrl: "http://127.0.0.1:34567",
        serverName: "busabase",
        server: {
          mode: "managed",
          command: process.platform === "win32" ? "npm.cmd" : "npm",
          env: {
            NPM_CONFIG_CACHE: "/tmp/e2e-data/npm-cache",
            NEXT_PUBLIC_APP_URL: "http://127.0.0.1:34567",
          },
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
            "34567",
            "--data",
            "/tmp/e2e-data",
          ],
          dataDir: "/tmp/e2e-data",
          startupTimeoutMs: 60_000,
          mcpReadyTimeoutMs: 60_000,
          stopOnDispose: true,
        },
      },
    });
  });

  it("composes with the real bundled patch into exactly one named busabase entry", () => {
    const warnings: string[] = [];
    const generatedBusabasePatches = buildCordisPatch(baseInput).filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { id?: unknown }).id === "busabase",
    );
    const entries = composeEntries(
      [
        loadOverlayPatches("busabase-dsh-plugin-test", bundledPatchPath),
        generatedBusabasePatches as Parameters<typeof composeEntries>[0][number],
      ],
      (warning) => warnings.push(warning),
    );
    const busabaseEntries = entries.filter((entry) => entry.id === "busabase");

    expect(warnings).toEqual([]);
    expect(busabaseEntries).toHaveLength(1);
    expect(busabaseEntries[0]).toMatchObject({
      id: "busabase",
      name: "@busabase/dsh-plugin",
      config: {
        baseUrl: "http://127.0.0.1:34567",
        serverName: "busabase",
        server: {
          mode: "managed",
          env: {
            NPM_CONFIG_CACHE: "/tmp/e2e-data/npm-cache",
            NEXT_PUBLIC_APP_URL: "http://127.0.0.1:34567",
          },
          dataDir: "/tmp/e2e-data",
          startupTimeoutMs: 60_000,
          mcpReadyTimeoutMs: 60_000,
          stopOnDispose: true,
        },
      },
    });
  });

  it("never embeds a path field, since Cordis resolves plugin name via module resolution", () => {
    const patch = buildCordisPatch(baseInput);
    expect(JSON.stringify(patch)).not.toMatch(/"path"/);
  });

  it("can launch a locally built Busabase server without changing the default npm path", () => {
    const patches = buildCordisPatch({
      sessionRoot: "/tmp/sessions",
      llmProvider: {
        providerId: "test",
        apiKeyEnv: "TEST_KEY",
        baseURL: "https://example.test/v1",
        modelId: "test-model",
      },
      busabase: {
        serverName: "busabase",
        host: "127.0.0.1",
        port: 15419,
        dataDir: "/tmp/data",
        npmCacheDir: "/tmp/npm",
        startupTimeoutMs: 60_000,
        mcpReadyTimeoutMs: 60_000,
        command: "/usr/bin/node",
        commandArgsPrefix: ["/repo/apps/busabase/bin/busabase.mjs", "server"],
      },
    }) as Array<{ id?: string; config?: { server?: { command?: string; args?: string[] } } }>;
    const server = patches.find((entry) => entry.id === "busabase")?.config?.server;
    expect(server?.command).toBe("/usr/bin/node");
    expect(server?.args?.slice(0, 2)).toEqual(["/repo/apps/busabase/bin/busabase.mjs", "server"]);
  });
});
