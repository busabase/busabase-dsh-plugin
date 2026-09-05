import { describe, expect, it, vi } from "vitest";
import {
  BUSABASE_HOST_CONFIG_GLOBAL,
  readBusabaseHostConfig,
  resolveBusabaseClientConfig,
  toBusabaseClientConfig,
} from "./client-config.js";
import { resolveConfig } from "./config.js";

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

    const clientConfig = toBusabaseClientConfig(hostConfig);

    expect(clientConfig).toMatchObject({
      baseUrl: "https://busabase.com",
      connection: { mode: "remote" },
      server: { manageable: false },
    });
    expect(JSON.stringify(clientConfig)).not.toMatch(
      /secret-launcher|PRIVATE_TOKEN|must-not-reach-browser|private\/workspace|private\/data/,
    );
  });

  it("reads only an object-shaped host global", () => {
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, { baseUrl: "https://busabase.com" });
    expect(readBusabaseHostConfig()).toEqual({ baseUrl: "https://busabase.com" });
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, "https://attacker.example");
    expect(readBusabaseHostConfig()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("lets explicit client input override the bridged host config", () => {
    vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, { baseUrl: "https://busabase.com" });
    expect(resolveBusabaseClientConfig({ baseUrl: "http://localhost:4010" })).toMatchObject({
      baseUrl: "http://localhost:4010",
      connection: { mode: "local" },
    });
    vi.unstubAllGlobals();
  });
});
