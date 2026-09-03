import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Busabase } from "busabase-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMinimalAirAppFiles, type checkCanonicalAirAppShape } from "./airapp-fixture.js";
import { buildCordisPatch } from "./cordis-patch.js";
import { killProcessOnPort, runDshHeadless } from "./dsh-headless-runner.js";
import { allocateLoopbackPort } from "./free-port.js";
import {
  approveAndMergeChangeRequest,
  createAnywhereEmbedLink,
  findPendingChangeRequest,
  readCanonicalAirApp,
  retrieveActiveEmbedLink,
} from "./human-review-driver.js";
import { describeMissingLiveE2EEnv, resolveLiveE2EEnv } from "./live-env.js";
import { formatChangeRequestMarker, generateRunSlug, parseChangeRequestMarker } from "./marker.js";
import { checkNodeEngine } from "./node-engine.js";
import { createSecretRedactor } from "./redact.js";
import { runCommand } from "./run-command.js";
import { collectSessionEvidence } from "./session-evidence.js";
import { createStandaloneCopy, removeStandaloneCopy } from "./workspace-copy.js";

const REQUIRED_NODE_ENGINE = ">=24.18.0";
const PLUGIN_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_NAMES = ["busabase-app-creator", "busabase"] as const;

const nodeEngine = checkNodeEngine(REQUIRED_NODE_ENGINE);
const liveEnv = resolveLiveE2EEnv();
const keepArtifacts = process.env.BUSABASE_DSH_E2E_KEEP_ARTIFACTS === "1";
const skipReason = !liveEnv.ok
  ? `missing required live E2E environment variables:\n${describeMissingLiveE2EEnv(liveEnv.missing).join("\n")}`
  : !nodeEngine.ok
    ? nodeEngine.reason
    : undefined;

/**
 * This is the only opt-in *real* E2E in this package: it spawns a live DSH
 * headless run against a real LLM endpoint and a real managed Busabase child,
 * so it never runs in ordinary `pnpm test`/CI unless both prerequisites hold.
 * Every other file under src/e2e is a deterministic unit test for one of the
 * building blocks this scenario composes.
 */
describe.skipIf(Boolean(skipReason))("live DSH + Busabase AirApp ChangeRequest scenario", () => {
  let standaloneRoot: string;
  let pluginDir: string;
  let dshHome: string;
  let dataDir: string;
  let host: string;
  let port: number;
  let patchPath: string;
  let dshBinPath: string;
  let redact: (text: string) => string;
  let runSlug: string;
  let appSlug: string;
  let reviewServer: ChildProcess | undefined;
  let reviewServerOutput = "";

  beforeAll(async () => {
    if (skipReason) return;
    const env = liveEnv.config;
    if (!env) throw new Error("live E2E environment resolved ok but config is missing");

    standaloneRoot = await mkdtemp(join(tmpdir(), "busabase-dsh-e2e-"));
    dshHome = join(standaloneRoot, "dsh-home");
    dataDir = join(standaloneRoot, "busabase-data");
    await mkdir(dshHome, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    host = "127.0.0.1";
    port = await allocateLoopbackPort(host);
    runSlug = generateRunSlug();
    appSlug = runSlug;

    const copy = await createStandaloneCopy({
      pluginSourceDir: PLUGIN_SOURCE_DIR,
      repoSkillsDir: env.skillsDir,
      skillNames: SKILL_NAMES,
      destinationDir: standaloneRoot,
    });
    pluginDir = copy.pluginDir;

    redact = createSecretRedactor([env.apiKey]);

    // Prove the frozen install/build works from the isolated copy before ever booting DSH.
    await runCommand("corepack", ["pnpm", "install", "--frozen-lockfile"], {
      cwd: pluginDir,
      timeoutMs: 300_000,
    });
    await runCommand("corepack", ["pnpm", "run", "build"], {
      cwd: pluginDir,
      timeoutMs: 120_000,
    });

    const patch = buildCordisPatch({
      sessionRoot: join(dshHome, "sessions"),
      llmProvider: {
        providerId: env.providerId,
        apiKeyEnv: "BUSABASE_DSH_E2E_API_KEY",
        baseURL: env.baseUrl,
        modelId: env.modelId,
      },
      busabase: {
        serverName: "busabase",
        host,
        port,
        dataDir,
        npmCacheDir: join(dataDir, "npm-cache"),
        startupTimeoutMs: 60_000,
        mcpReadyTimeoutMs: 60_000,
      },
    });
    patchPath = join(standaloneRoot, "patch.json");
    await writeFile(patchPath, JSON.stringify(patch), "utf8");

    dshBinPath = resolve(pluginDir, "node_modules/@deepseek-ai/dsh/lib/bin.js");

    // Materializes $DSH_HOME/profiles/headless (dsh scaffolds it on first use)
    // then installs the standalone copy into it via `link:`, exactly the
    // README's local-install path — Cordis resolves plugin `name` through
    // normal module resolution, so the package must be reachable from the
    // profile's own node_modules before the --patch overlay above can insert it.
    await runCommand(
      process.execPath,
      [dshBinPath, "--profile", "headless", "--dump-default-config"],
      {
        cwd: pluginDir,
        env: { ...process.env, DSH_HOME: dshHome },
        timeoutMs: 60_000,
      },
    );
    await runCommand(
      process.execPath,
      [dshBinPath, "plugin", "--profile", "headless", "add", pluginDir],
      {
        cwd: pluginDir,
        env: { ...process.env, DSH_HOME: dshHome },
        timeoutMs: 120_000,
      },
    );
  }, 360_000);

  afterAll(async () => {
    if (skipReason) return;
    await killProcessOnPort(port).catch(() => undefined);
    stopProcess(reviewServer);
    if (!keepArtifacts) await removeStandaloneCopy(standaloneRoot).catch(() => undefined);
  });

  it("installs and builds the standalone plugin copy under a frozen lockfile", async () => {
    await expect(readFile(join(pluginDir, "lib", "index.js"), "utf8")).resolves.toContain("apply");
  }, 30_000);

  it("runs the model end-to-end: loads the skill, calls busabase_start, submits an AirApp CR, then the human driver approves/merges and verifies canonical state", async () => {
    const marker = { changeRequestId: "", slug: appSlug };
    const files = buildMinimalAirAppFiles(appSlug);
    const task = [
      "Load the busabase-app-creator skill.",
      "Call busabase_start, then read the Busabase AirApp guide with the busabase_guide MCP tool.",
      `Create a new minimal runnable plain-Node AirApp named "${appSlug}" with exactly these two files:`,
      `package.json:\n${files[0].content}`,
      `server.js:\n${files[1].content}`,
      "Submit it as a ChangeRequest — do not request autoMerge, do not attempt to review or merge it yourself.",
      "Use only the skill, busabase_start, and mcp__busabase__* tools for this task. Do not use bash, curl, or direct HTTP as a fallback; if an MCP call fails, report the failure and do not print the success marker.",
      `After the ChangeRequest is created, print exactly one line: ${formatChangeRequestMarker({ changeRequestId: "<id>", slug: appSlug })}`,
      "using the real changeRequestId the tool returned in place of <id>.",
    ].join("\n");

    const result = await runDshHeadless({
      dshBinPath,
      cwd: pluginDir,
      dshHome,
      patchPath,
      task,
      env: { ...process.env },
      timeoutMs: 600_000,
    });

    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `dsh headless run failed (exitCode=${String(result.exitCode)}, timedOut=${String(result.timedOut)}): ` +
          `${redact(`${result.stdout}\n${result.stderr}`).slice(-8_000)}`,
      );
    }

    const parsedMarker = parseChangeRequestMarker(result.stdout);
    if (!parsedMarker)
      throw new Error(`no ChangeRequest marker found in model output: ${redact(result.stdout)}`);
    marker.changeRequestId = parsedMarker.changeRequestId;
    expect(parsedMarker.slug).toBe(appSlug);

    // Server-side state is authoritative from here on — the model's prose is not trusted again.
    const evidence = await collectSessionEvidence(dshHome, "busabase");
    expect(evidence.usedSkillTool).toBe(true);
    expect(evidence.loadedBusabaseAppCreatorSkill).toBe(true);
    expect(evidence.calledBusabaseMcpTool).toBe(true);
    expect(evidence.calledChangeRequestMutationTool).toBe(true);
    expect(evidence.mcpAirAppCreateSlugs).toContain(appSlug);
    expect(evidence.mcpChangeRequestIds).toContain(marker.changeRequestId);

    // The plugin owns the server it launched. Verify its disposal path first,
    // then reopen the same isolated data with the published CLI for the
    // human-only review and capability-link phase.
    await waitForPortClosed(host, port, 15_000);
    reviewServer = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "exec",
        "--yes",
        "--package",
        "busabase@latest",
        "--",
        "busabase",
        "server",
        "--host",
        host,
        "--port",
        String(port),
        "--data",
        dataDir,
      ],
      {
        cwd: pluginDir,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: join(dataDir, "npm-cache"),
          NEXT_PUBLIC_APP_URL: `http://${host}:${String(port)}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    reviewServer.stdout?.on("data", (chunk: Buffer) => {
      reviewServerOutput = `${reviewServerOutput}${chunk.toString()}`.slice(-8_000);
    });
    reviewServer.stderr?.on("data", (chunk: Buffer) => {
      reviewServerOutput = `${reviewServerOutput}${chunk.toString()}`.slice(-8_000);
    });
    await waitForHealth(`http://${host}:${String(port)}/api/health`, 60_000, reviewServer, () =>
      redact(reviewServerOutput),
    );

    const client = new Busabase({ baseUrl: `http://${host}:${String(port)}` });
    const pending = await findPendingChangeRequest(client, {
      changeRequestId: marker.changeRequestId,
      slug: appSlug,
    });
    expect(pending.status).toBe("in_review");

    const { nodeId } = await approveAndMergeChangeRequest(client, pending.id);
    if (!nodeId) throw new Error("merge succeeded but returned no nodeId");

    const canonical = await readCanonicalAirApp(client, nodeId);
    expect(canonical.shapeCheck).toEqual<ReturnType<typeof checkCanonicalAirAppShape>>({
      ok: true,
      reasons: [],
    });

    const embedLink = await createAnywhereEmbedLink(client, nodeId);
    expect(new URL(embedLink.iframeUrl).pathname).toBe(new URL(embedLink.url).pathname);
    expect(new URL(embedLink.iframeUrl).searchParams.get("view")).toBe("iframe");
    expect(new URL(embedLink.url).pathname).toContain(embedLink.id);
    expect(new URL(embedLink.url).searchParams.get("token")).toBeTruthy();
    await expect(retrieveActiveEmbedLink(client, nodeId, embedLink.id)).resolves.toEqual({
      id: embedLink.id,
      active: true,
      typeId: nodeId,
    });

    stopProcess(reviewServer);
    reviewServer = undefined;
    await waitForPortClosed(host, port, 15_000);
  }, 720_000);
});

async function waitForHealth(
  url: string,
  timeoutMs: number,
  child?: ChildProcess,
  output: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null)
      throw new Error(`Busabase exited before health check succeeded: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Busabase did not become healthy at ${url}: ${output()}`);
}

async function waitForPortClosed(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await isPortOpen(host, port);
    if (!listening) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`process on ${host}:${String(port)} did not exit`);
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function stopProcess(child: ChildProcess | undefined): void {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
  } catch {
    // It already exited.
  }
}
