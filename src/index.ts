import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-host-webserver";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import type {} from "@deepseek-ai/dsh-skill";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Busabase } from "busabase-sdk";
import { type BusabasePluginConfig, Config, resolveConfig } from "./config.js";
import {
  registerMcpResultPreview,
  registerRemoteChangeRequestPreview,
} from "./mcp-result-preview.js";
import { unwrapMcpResult } from "./normalize.js";
import { connectRemoteMcp, type RemoteMcpHandle } from "./oauth-mcp-client.js";
import { BUSABASE_SYSTEM_PROMPT } from "./prompt.js";
import { createBusabaseServerRouter } from "./server-router.js";
import { BusabaseServerSupervisor } from "./server-supervisor.js";

export const name = "@busabase/dsh-plugin";
export const inject = ["systemPrompt", "tools", "skills"];
export { Config, resolveConfig };
export type { BusabasePluginConfig, ResolvedBusabasePluginConfig } from "./config.js";
export * from "./normalize.js";
export * from "./preview-link.js";
export * from "./server-router.js";
export * from "./server-supervisor.js";

const bundledSkillsDir = (): string => {
  const builtDir = fileURLToPath(new URL("./skills/", import.meta.url));
  return existsSync(builtDir) ? builtDir : fileURLToPath(new URL("../skills/", import.meta.url));
};

export function registerBundledSkills(ctx: Context): () => void {
  return ctx.skills.registerProvider(
    (control) =>
      new FileSystemSkillProvider(ctx, control, {
        providerName: "busabase-bundled",
        includeDefaultRoots: false,
        bundledSkillDir: bundledSkillsDir(),
        watch: false,
      }),
  );
}

export async function apply(ctx: Context, input: BusabasePluginConfig = {}): Promise<void> {
  const config = resolveConfig(input);
  const client = new Busabase({ baseUrl: config.baseUrl, webUrl: config.baseUrl });
  registerBundledSkills(ctx);
  ctx.systemPrompt.section({
    name: "busabase:workspace",
    order: 160,
    text: BUSABASE_SYSTEM_PROMPT,
  });
  if (config.connection.mode === "remote") {
    let handle!: RemoteMcpHandle;
    ctx.effect(() => {
      const credentials = ctx.get("credentials", false);
      if (!credentials)
        throw new Error(
          "busabase: connecting to a remote (Cloud) Busabase server requires the credentials service",
        );
      handle = connectRemoteMcp(ctx, config, credentials);
      return async () => handle.dispose();
    }, "busabase: cloud mcp connection");
    registerRemoteChangeRequestPreview(
      ctx,
      config.serverName,
      async (changeRequestId, targetSpaceId, signal) => {
        const result = await handle.createChangeRequestEmbedLink(
          changeRequestId,
          targetSpaceId,
          signal,
        );
        const link = unwrapMcpResult(result) as Record<string, unknown>;
        return { ...link, type: "change-request", typeId: changeRequestId, autoPreview: true };
      },
    );
    const outcome = await handle.ready;
    if (outcome.error)
      throw new Error(
        `busabase: initial Cloud MCP connection failed for "${config.serverName}"; check OAuth authorization and network connectivity`,
        { cause: outcome.error },
      );
    return;
  }
  registerMcpResultPreview(ctx, client, config.serverName);
  const supervisor = new BusabaseServerSupervisor(config);
  ctx.effect(() => async () => supervisor.dispose(), "busabase: managed server");
  ctx.inject(["webServer"], (webCtx) =>
    webCtx.webServer.register({
      kind: "prefix",
      path: "/busabase-api",
      handler: createBusabaseServerRouter(supervisor, config.baseUrl, client),
    }),
  );
  ctx.effect(
    () =>
      ctx.tools.register(
        createStartTool(ctx, config.serverName, config.server.mcpReadyTimeoutMs, supervisor),
      ),
    "busabase: lazy server tool",
  );
  ctx.plugin(mcpClient, {
    transport: "streamable-http",
    serverName: config.serverName,
    url: config.mcpUrl,
    headers: {
      "x-busabase-relay-permission-level": "changeRequest",
      ...(config.server.manageable ? { "x-busabase-space": "local" } : {}),
    },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: {
      enabled: true,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    },
  });
}

function createStartTool(
  ctx: Context,
  serverName: string,
  mcpReadyTimeoutMs: number,
  supervisor: BusabaseServerSupervisor,
) {
  return defineTool({
    name: "busabase_start",
    description: `Start or reconnect the local Busabase server before using Busabase MCP tools. Call this when mcp__${serverName}__* tools are unavailable, then continue Busabase work on the next step.`,
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          baseUrl: { type: "string", required: true },
          owned: { type: "boolean", required: true },
          reused: { type: "boolean", required: true },
          mcpReady: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    timeoutMs: mcpReadyTimeoutMs + 5_000,
    async execute(_args, execution) {
      const result = await supervisor.ensure();
      if (!result.ok) throw new Error(result.reason);
      const mcpReady = await waitForMcpTools(ctx, serverName, mcpReadyTimeoutMs, execution.signal);
      return { ...result, mcpReady };
    },
  });
}

async function waitForMcpTools(
  ctx: Context,
  serverName: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const names = [
    `mcp__${serverName}__busabase_guide`,
    `mcp__${serverName}__search`,
    `mcp__${serverName}__change_requests_list_page`,
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (names.some((name) => ctx.tools.get(name))) return true;
    if (signal.aborted) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
