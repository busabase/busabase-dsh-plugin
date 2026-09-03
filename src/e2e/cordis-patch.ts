export interface CordisPatchInput {
  sessionRoot: string;
  llmProvider: {
    providerId: string;
    apiKeyEnv: string;
    baseURL: string;
    modelId: string;
  };
  busabase: {
    serverName: string;
    host: string;
    port: number;
    dataDir: string;
    npmCacheDir: string;
    startupTimeoutMs: number;
    mcpReadyTimeoutMs: number;
    command?: string;
    commandArgsPrefix?: string[];
  };
}

/**
 * Builds the Cordis patch list an opt-in live E2E run needs: an `llm-pi-ai`
 * provider insert using the plugin's generic `openai-completions` adapter
 * against whatever OpenAI-compatible endpoint the operator supplied (never a
 * hard-coded gateway — see `resolveLiveE2EEnv`), plus a managed Busabase
 * child on a private loopback port/data dir.
 *
 * Loading the standalone copy of `@busabase/dsh-plugin` itself is a separate
 * step (`dsh plugin --profile <name> add <standaloneDir>`, mirroring the
 * README's local-install instructions) because Cordis resolves `name` through
 * normal Node module resolution — a patch entry cannot point at an arbitrary
 * filesystem path.
 *
 * That `dsh plugin add` step also applies the package's own bundled
 * `dsh.bundle.patch` (`cordis.patch.yml`), which already inserts the
 * `busabase` loader entry. So this patch must *configure* that existing
 * entry by `id` (a plain `{ id, config }` override, like the other entries
 * below) rather than `insert` a second one — two inserts sharing the same
 * `id` make Cordis's loader throw `duplicate loader entry id: busabase`.
 */
export function buildCordisPatch(input: CordisPatchInput): unknown[] {
  return [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [input.llmProvider.providerId]: {
            apiKeyEnv: input.llmProvider.apiKeyEnv,
            api: "openai-completions",
            baseURL: input.llmProvider.baseURL,
            models: [{ id: input.llmProvider.modelId, input: ["text", "image"] }],
          },
        },
      },
    },
    {
      id: "agent-default-model",
      config: {
        provider: input.llmProvider.providerId,
        model: input.llmProvider.modelId,
      },
    },
    {
      id: "session-persistence-jsonl",
      config: { root: input.sessionRoot, compression: "none", packChunks: false },
    },
    {
      id: "busabase",
      config: {
        baseUrl: `http://${input.busabase.host}:${String(input.busabase.port)}`,
        serverName: input.busabase.serverName,
        server: {
          mode: "managed",
          command: input.busabase.command ?? (process.platform === "win32" ? "npm.cmd" : "npm"),
          env: {
            NPM_CONFIG_CACHE: input.busabase.npmCacheDir,
            NEXT_PUBLIC_APP_URL: `http://${input.busabase.host}:${String(input.busabase.port)}`,
          },
          args: [
            ...(input.busabase.commandArgsPrefix ?? [
              "exec",
              "--yes",
              "--package",
              "busabase@latest",
              "--",
              "busabase",
              "server",
            ]),
            "--host",
            input.busabase.host,
            "--port",
            String(input.busabase.port),
            "--data",
            input.busabase.dataDir,
          ],
          dataDir: input.busabase.dataDir,
          startupTimeoutMs: input.busabase.startupTimeoutMs,
          mcpReadyTimeoutMs: input.busabase.mcpReadyTimeoutMs,
          stopOnDispose: true,
        },
      },
    },
  ];
}
