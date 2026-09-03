/**
 * Neutral environment configuration for the opt-in live E2E scenarios
 * (`live-scenario.test.ts`, `live-browser-scenario.test.ts`). Both scenarios
 * must exercise the plugin's generic `openai-completions` Cordis adapter
 * against whatever OpenAI-compatible endpoint the operator points at — never
 * a hard-coded private gateway — so every value here comes from an explicit
 * environment variable with no default baked into source.
 */
export interface LiveE2EEnvConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  providerId: string;
  skillsDir: string;
}

export type LiveE2EEnvResolution =
  | { ok: true; config: LiveE2EEnvConfig; missing: [] }
  | { ok: false; config?: undefined; missing: string[] };

const REQUIRED_VARS = [
  "BUSABASE_DSH_E2E_API_KEY",
  "BUSABASE_DSH_E2E_BASE_URL",
  "BUSABASE_DSH_E2E_MODEL_ID",
  "BUSABASE_DSH_E2E_SKILLS_DIR",
] as const;

const DEFAULT_PROVIDER_ID = "busabase-dsh-e2e";

/**
 * Resolves the live-E2E environment, or reports exactly which required
 * variables are missing so the caller can skip with a precise reason instead
 * of failing deep inside a spawned `dsh` process. `BUSABASE_DSH_E2E_SKILLS_DIR`
 * is required (not derived from the repo root) so a standalone checkout of
 * this package, with no `.agents/skills` sibling, can still run the scenario by
 * pointing it at its own skills directory.
 */
export function resolveLiveE2EEnv(
  env: Record<string, string | undefined> = process.env,
): LiveE2EEnvResolution {
  const missing = REQUIRED_VARS.filter((name) => !hasValue(env[name]));
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    missing: [],
    config: {
      apiKey: env.BUSABASE_DSH_E2E_API_KEY as string,
      baseUrl: env.BUSABASE_DSH_E2E_BASE_URL as string,
      modelId: env.BUSABASE_DSH_E2E_MODEL_ID as string,
      providerId: hasValue(env.BUSABASE_DSH_E2E_PROVIDER_ID)
        ? (env.BUSABASE_DSH_E2E_PROVIDER_ID as string)
        : DEFAULT_PROVIDER_ID,
      skillsDir: env.BUSABASE_DSH_E2E_SKILLS_DIR as string,
    },
  };
}

/** One human-readable line per missing variable, for a consistent skip message across scripts and tests. */
export function describeMissingLiveE2EEnv(missing: readonly string[]): string[] {
  return missing.map((name) => `  - ${name} is not set`);
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
