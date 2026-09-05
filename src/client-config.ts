import {
  type BusabasePluginConfig,
  type ResolvedBusabasePluginConfig,
  resolveConfig,
} from "./config.js";

/**
 * Global `client.tsx`'s `apply()` reads before building its own config. Written into the boot
 * HTML by the host plugin (`index.ts`) via a `webserver/index-inject` `global` row, which renders
 * ahead of the client bundle's own script — see `dsh-client-ui-theme`'s `apply()` for the same
 * established pattern. No wire protocol otherwise carries plugin config to a client bundle: the
 * loader activates client plugins with only `{ name }` (no `config`), so without this bridge
 * `client.tsx` always resolves its own isolated defaults regardless of what the host resolved.
 */
export const BUSABASE_HOST_CONFIG_GLOBAL = "__BUSABASE_HOST_CONFIG__";

/**
 * The read-only, credential-free subset of {@link ResolvedBusabasePluginConfig} safe to hand to
 * the browser. Never add a field here that isn't already safe to expose: no API keys, no server
 * launch command/env/cwd/dataDir.
 */
export interface BusabaseClientConfig {
  baseUrl: string;
  spaceId: string | null;
  serverName: string;
  connection: { mode: "local" | "remote" };
  server: { manageable: boolean };
  liveRefresh: ResolvedBusabasePluginConfig["liveRefresh"];
  airAppIframe: { enabled: boolean };
  baseIframe: { enabled: boolean };
  changeRequestIframe: { enabled: boolean };
  confirmations: { review: boolean; merge: boolean; close: boolean };
}

export function toBusabaseClientConfig(config: ResolvedBusabasePluginConfig): BusabaseClientConfig {
  return {
    baseUrl: config.baseUrl,
    spaceId: config.spaceId,
    serverName: config.serverName,
    connection: config.connection,
    server: { manageable: config.server.manageable },
    liveRefresh: config.liveRefresh,
    airAppIframe: config.airAppIframe,
    baseIframe: config.baseIframe,
    changeRequestIframe: config.changeRequestIframe,
    confirmations: config.confirmations,
  };
}

/**
 * Reads the host-injected global, ignoring anything malformed rather than throwing — a
 * missing/corrupt global must fall back to `client.tsx`'s own defaults, not break boot.
 */
export function readBusabaseHostConfig(): Partial<BusabaseClientConfig> | undefined {
  const value = (globalThis as Record<string, unknown>)[BUSABASE_HOST_CONFIG_GLOBAL];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<BusabaseClientConfig>)
    : undefined;
}

/** Resolve browser behavior from the host bridge while preserving explicit caller overrides. */
export function resolveBusabaseClientConfig(
  input: BusabasePluginConfig,
): ResolvedBusabasePluginConfig {
  const host = readBusabaseHostConfig();
  return resolveConfig({
    ...(host?.baseUrl !== undefined ? { baseUrl: host.baseUrl } : {}),
    ...(host?.spaceId !== undefined ? { spaceId: host.spaceId ?? undefined } : {}),
    ...(host?.serverName !== undefined ? { serverName: host.serverName } : {}),
    ...(host?.liveRefresh ? { liveRefresh: host.liveRefresh } : {}),
    ...(host?.airAppIframe ? { airAppIframe: host.airAppIframe } : {}),
    ...(host?.baseIframe ? { baseIframe: host.baseIframe } : {}),
    ...(host?.changeRequestIframe ? { changeRequestIframe: host.changeRequestIframe } : {}),
    ...(host?.confirmations ? { confirmations: host.confirmations } : {}),
    ...input,
  });
}
