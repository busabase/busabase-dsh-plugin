import z from "@deepseek-ai/schemastery";

export interface BusabasePluginConfig {
  baseUrl?: string;
  spaceId?: string;
  mcpUrl?: string;
  serverName?: string;
  server?: {
    mode?: "auto" | "managed" | "external";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    dataDir?: string;
    startupTimeoutMs?: number;
    mcpReadyTimeoutMs?: number;
    stopOnDispose?: boolean;
  };
  liveRefresh?: {
    enabled?: boolean;
    pollIntervalMs?: number;
    reconnectInitialDelayMs?: number;
    reconnectMaxDelayMs?: number;
  };
  airAppIframe?: {
    enabled?: boolean;
  };
  baseIframe?: {
    enabled?: boolean;
  };
  changeRequestIframe?: {
    enabled?: boolean;
  };
  confirmations?: {
    review?: boolean;
    merge?: boolean;
    close?: boolean;
  };
}

export interface ResolvedBusabasePluginConfig {
  baseUrl: string;
  spaceId: string | null;
  mcpUrl: string;
  serverName: string;
  server: {
    mode: "auto" | "managed" | "external";
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    startupTimeoutMs: number;
    mcpReadyTimeoutMs: number;
    stopOnDispose: boolean;
    host: string;
    port: number;
    manageable: boolean;
  };
  liveRefresh: {
    enabled: boolean;
    pollIntervalMs: number;
    reconnectInitialDelayMs: number;
    reconnectMaxDelayMs: number;
  };
  airAppIframe: { enabled: boolean };
  baseIframe: { enabled: boolean };
  changeRequestIframe: { enabled: boolean };
  confirmations: { review: boolean; merge: boolean; close: boolean };
}

export const Config: z<BusabasePluginConfig> = z.object({
  baseUrl: z.string().default("http://localhost:15419"),
  spaceId: z.string(),
  mcpUrl: z.string(),
  serverName: z.string().default("busabase"),
  server: z
    .object({
      mode: z.union([z.const("auto"), z.const("managed"), z.const("external")]).default("auto"),
      command: z.string().default(""),
      args: z.array(String).default([]),
      env: z.dict(String).default({}),
      cwd: z.string().default(""),
      dataDir: z.string().default(""),
      startupTimeoutMs: z.number().min(1_000).default(30_000),
      mcpReadyTimeoutMs: z.number().min(1_000).default(30_000),
      stopOnDispose: z.boolean().default(true),
    })
    .default({
      mode: "auto",
      command: "",
      args: [],
      env: {},
      cwd: "",
      dataDir: "",
      startupTimeoutMs: 30_000,
      mcpReadyTimeoutMs: 30_000,
      stopOnDispose: true,
    }),
  liveRefresh: z
    .object({
      enabled: z.boolean().default(true),
      pollIntervalMs: z.number().min(5_000).default(30_000),
      reconnectInitialDelayMs: z.number().min(250).default(1_000),
      reconnectMaxDelayMs: z.number().min(1_000).default(30_000),
    })
    .default({
      enabled: true,
      pollIntervalMs: 30_000,
      reconnectInitialDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
    }),
  airAppIframe: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  baseIframe: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  changeRequestIframe: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  confirmations: z
    .object({
      review: z.boolean().default(true),
      merge: z.boolean().default(true),
      close: z.boolean().default(true),
    })
    .default({ review: true, merge: true, close: true }),
});

export function resolveConfig(config: BusabasePluginConfig = {}): ResolvedBusabasePluginConfig {
  const baseUrl = normalizeBaseUrl(config.baseUrl ?? "http://localhost:15419");
  const serverUrl = new URL(baseUrl);
  const serverName = config.serverName ?? "busabase";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName))
    throw new Error("serverName must match [A-Za-z0-9_-]{1,32}");
  const serverMode = config.server?.mode ?? "auto";
  const manageable = isLoopbackHostname(serverUrl.hostname);
  if (serverMode === "managed" && !manageable)
    throw new Error("server.mode managed requires a loopback baseUrl");
  const urlHostname = serverUrl.hostname.replace(/^\[(.*)\]$/, "$1");
  const serverHost = urlHostname === "localhost" ? "127.0.0.1" : urlHostname;
  const serverPort = Number(serverUrl.port || (serverUrl.protocol === "https:" ? "443" : "80"));
  const defaultArgs = [
    "exec",
    "--yes",
    "--package",
    "busabase@latest",
    "--",
    "busabase",
    "server",
    "--host",
    serverHost,
    "--port",
    String(serverPort),
  ];
  if (config.server?.dataDir) defaultArgs.push("--data", config.server.dataDir);
  return {
    baseUrl,
    spaceId: config.spaceId?.trim() || null,
    mcpUrl: config.mcpUrl ?? `${baseUrl}/api/mcp`,
    serverName,
    server: {
      mode: serverMode,
      command: config.server?.command || defaultNpmCommand(),
      args: config.server?.args?.length ? config.server.args : defaultArgs,
      env: { NEXT_PUBLIC_APP_URL: baseUrl, ...(config.server?.env ?? {}) },
      cwd: config.server?.cwd ?? "",
      startupTimeoutMs: config.server?.startupTimeoutMs ?? 30_000,
      mcpReadyTimeoutMs: config.server?.mcpReadyTimeoutMs ?? 30_000,
      stopOnDispose: config.server?.stopOnDispose ?? true,
      host: serverHost,
      port: serverPort,
      manageable,
    },
    liveRefresh: {
      enabled: config.liveRefresh?.enabled ?? true,
      pollIntervalMs: config.liveRefresh?.pollIntervalMs ?? 30_000,
      reconnectInitialDelayMs: config.liveRefresh?.reconnectInitialDelayMs ?? 1_000,
      reconnectMaxDelayMs: config.liveRefresh?.reconnectMaxDelayMs ?? 30_000,
    },
    airAppIframe: { enabled: config.airAppIframe?.enabled ?? true },
    baseIframe: { enabled: config.baseIframe?.enabled ?? true },
    changeRequestIframe: { enabled: config.changeRequestIframe?.enabled ?? true },
    confirmations: {
      review: config.confirmations?.review ?? true,
      merge: config.confirmations?.merge ?? true,
      close: config.confirmations?.close ?? true,
    },
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function defaultNpmCommand(): string {
  return typeof process !== "undefined" && process.platform === "win32" ? "npm.cmd" : "npm";
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("baseUrl must use http or https");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
