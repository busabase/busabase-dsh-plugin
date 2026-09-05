import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSABASE_HOST_CONFIG_GLOBAL,
  readBusabaseHostConfig,
  resolveBusabaseClientConfig,
  toBusabaseClientConfig,
} from "./client-config.js";
import { resolveConfig } from "./config.js";

afterEach(() => vi.unstubAllGlobals());

describe("Busabase client config bridge", () => {
  it("projects only browser-safe settings from the resolved host config", () => {
    const hostConfig = resolveConfig({
      baseUrl: "https://busabase.com",
      server: {
        command: "secret-launcher",
        env: { PRIVATE_TOKEN: "must-not-reach-browser" },
        cwd: "/private/workspace",
        dataDir: "/private/data",
      },
    });
    const clientConfig = toBusabaseClientConfig({
      ...hostConfig,
      oauth: { accessToken: "private-oauth-token" },
    } as typeof hostConfig);
    expect(clientConfig).toMatchObject({
      baseUrl: "https://busabase.com",
      connection: { mode: "remote" },
      server: { manageable: false },
    });
    expect(JSON.stringify(clientConfig)).not.toMatch(
      /secret-launcher|PRIVATE_TOKEN|must-not-reach-browser|private\/workspace|private\/data|private-oauth-token/,
    );
    expect(clientConfig).not.toHaveProperty("mcpUrl");
    expect(clientConfig).not.toHaveProperty("oauth");
  });

  it("reads only an object-shaped host global", () => {
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, { baseUrl: "https://busabase.com" });
    expect(readBusabaseHostConfig()).toEqual({ baseUrl: "https://busabase.com" });
    for (const value of ["https://attacker.example", [], null, undefined]) {
      vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, value);
      expect(readBusabaseHostConfig()).toBeUndefined();
    }
  });

  it("lets explicit client input override the bridged host config", () => {
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, { baseUrl: "https://busabase.com" });
    expect(resolveBusabaseClientConfig({ baseUrl: "http://localhost:4010" })).toMatchObject({
      baseUrl: "http://localhost:4010",
      connection: { mode: "local" },
    });
  });

  it("restores the Cloud Space and preview settings when DSH passes no client config", () => {
    const host = resolveConfig({
      baseUrl: "https://busabase.com",
      spaceId: "selected-space",
      serverName: "cloud-busabase",
      changeRequestIframe: { enabled: false },
      confirmations: { review: false },
      liveRefresh: { pollIntervalMs: 45_000 },
    });
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, toBusabaseClientConfig(host));
    expect(resolveBusabaseClientConfig({})).toMatchObject({
      baseUrl: "https://busabase.com",
      spaceId: "selected-space",
      serverName: "cloud-busabase",
      connection: { mode: "remote" },
      changeRequestIframe: { enabled: false },
      confirmations: { review: false },
      liveRefresh: { pollIntervalMs: 45_000 },
    });
  });

  it("keeps default local settings when the host bridge is absent", () => {
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, undefined);
    expect(resolveBusabaseClientConfig({})).toEqual(resolveConfig({}));
  });
});
