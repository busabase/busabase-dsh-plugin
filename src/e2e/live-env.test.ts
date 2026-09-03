import { describe, expect, it } from "vitest";
import { describeMissingLiveE2EEnv, resolveLiveE2EEnv } from "./live-env.js";

const fullEnv = {
  BUSABASE_DSH_E2E_API_KEY: "sk-test",
  BUSABASE_DSH_E2E_BASE_URL: "https://example.invalid/v1",
  BUSABASE_DSH_E2E_MODEL_ID: "example/model-1",
  BUSABASE_DSH_E2E_SKILLS_DIR: "/tmp/skills",
};

describe("resolveLiveE2EEnv", () => {
  it("resolves a config from the four required neutral variables", () => {
    const result = resolveLiveE2EEnv(fullEnv);
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://example.invalid/v1",
      modelId: "example/model-1",
      providerId: "busabase-dsh-e2e",
      skillsDir: "/tmp/skills",
    });
    expect(result.missing).toEqual([]);
  });

  it("uses the explicit provider id when BUSABASE_DSH_E2E_PROVIDER_ID is set", () => {
    const result = resolveLiveE2EEnv({
      ...fullEnv,
      BUSABASE_DSH_E2E_PROVIDER_ID: "my-custom-provider",
    });
    expect(result.ok).toBe(true);
    expect(result.config?.providerId).toBe("my-custom-provider");
  });

  it("reports every missing required variable and does not return a config", () => {
    const result = resolveLiveE2EEnv({});
    expect(result.ok).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.missing).toEqual([
      "BUSABASE_DSH_E2E_API_KEY",
      "BUSABASE_DSH_E2E_BASE_URL",
      "BUSABASE_DSH_E2E_MODEL_ID",
      "BUSABASE_DSH_E2E_SKILLS_DIR",
    ]);
  });

  it("treats a blank string the same as unset", () => {
    const result = resolveLiveE2EEnv({ ...fullEnv, BUSABASE_DSH_E2E_API_KEY: "   " });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["BUSABASE_DSH_E2E_API_KEY"]);
  });

  it("never treats the optional provider id as required", () => {
    const result = resolveLiveE2EEnv(fullEnv);
    expect(result.missing).not.toContain("BUSABASE_DSH_E2E_PROVIDER_ID");
  });
});

describe("describeMissingLiveE2EEnv", () => {
  it("formats one indented line per missing variable name", () => {
    expect(
      describeMissingLiveE2EEnv(["BUSABASE_DSH_E2E_API_KEY", "BUSABASE_DSH_E2E_BASE_URL"]),
    ).toEqual([
      "  - BUSABASE_DSH_E2E_API_KEY is not set",
      "  - BUSABASE_DSH_E2E_BASE_URL is not set",
    ]);
  });

  it("returns an empty array when nothing is missing", () => {
    expect(describeMissingLiveE2EEnv([])).toEqual([]);
  });
});
