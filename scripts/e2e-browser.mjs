import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

const REQUIRED_NODE_ENGINE = { major: 24, minor: 18, patch: 0 };
const REQUIRED_ENV_VARS = [
  "BUSABASE_DSH_E2E_API_KEY",
  "BUSABASE_DSH_E2E_BASE_URL",
  "BUSABASE_DSH_E2E_MODEL_ID",
  "BUSABASE_DSH_E2E_SKILLS_DIR",
];

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function satisfiesMinimum(actual, required) {
  if (actual.major !== required.major) return actual.major > required.major;
  if (actual.minor !== required.minor) return actual.minor > required.minor;
  return actual.patch >= required.patch;
}

const actual = parseVersion(process.version);
const nodeOk = Boolean(actual && satisfiesMinimum(actual, REQUIRED_NODE_ENGINE));
const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]?.trim());

if (missingEnvVars.length > 0 || !nodeOk) {
  console.log("Skipping live browser E2E — prerequisites not met:");
  for (const name of missingEnvVars) console.log(`  - ${name} is not set`);
  if (!nodeOk) console.log(`  - Node ${process.version} does not satisfy >=24.18.0`);
  console.log(
    "Set BUSABASE_DSH_E2E_API_KEY, BUSABASE_DSH_E2E_BASE_URL, BUSABASE_DSH_E2E_MODEL_ID, " +
      "and BUSABASE_DSH_E2E_SKILLS_DIR (optionally BUSABASE_DSH_E2E_PROVIDER_ID) and run under " +
      "Node >=24.18.0 to execute the real scenario.",
  );
  process.exit(0);
}

console.log(`Prerequisites satisfied (Node ${process.version}). Running live browser E2E…`);

try {
  await exec(
    "corepack",
    ["pnpm", "exec", "vitest", "run", "src/e2e/live-browser-scenario.test.ts"],
    { cwd: root, env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  console.log("Live browser E2E passed.");
} catch (error) {
  process.stdout.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? "");
  process.exitCode = 1;
}
