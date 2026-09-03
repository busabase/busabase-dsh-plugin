import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import { Busabase } from "busabase-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMinimalAirAppFiles, type checkCanonicalAirAppShape } from "./airapp-fixture.js";
import { buildCordisPatch } from "./cordis-patch.js";
import { killProcessOnPort } from "./dsh-headless-runner.js";
import {
  approveMergeAndOpenPreview,
  closeDetailsPanel,
  dismissTestingNoticeIfPresent,
  selectWorkspaceDirectory,
  submitPrompt,
} from "./dsh-web-driver.js";
import { type DshWebRunHandle, runDshWeb } from "./dsh-web-runner.js";
import { resolveEvidenceDir, saveEvidenceFile } from "./evidence-dir.js";
import { allocateLoopbackPort } from "./free-port.js";
import {
  findPendingChangeRequest,
  readCanonicalAirApp,
  retrieveActiveEmbedLink,
} from "./human-review-driver.js";
import { describeMissingLiveE2EEnv, resolveLiveE2EEnv } from "./live-env.js";
import {
  type ChangeRequestMarker,
  formatChangeRequestMarker,
  generateRunSlug,
  parseChangeRequestMarkerFromJsonl,
} from "./marker.js";
import { checkNodeEngine } from "./node-engine.js";
import { createSecretRedactor } from "./redact.js";
import { runCommand } from "./run-command.js";
import { collectSessionEvidence, type McpPreviewProvenance } from "./session-evidence.js";
import { createStandaloneCopy, removeStandaloneCopy } from "./workspace-copy.js";

const REQUIRED_NODE_ENGINE = ">=24.18.0";
const PLUGIN_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_BUSABASE_DIR = resolve(PLUGIN_SOURCE_DIR, "../busabase");
const LOCAL_BUSABASE_BIN = join(LOCAL_BUSABASE_DIR, "bin/busabase.mjs");
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
 * The browser-driven sibling of live-scenario.test.ts: same standalone copy,
 * frozen install/build, real LLM gateway, and real managed Busabase child,
 * but the model task is submitted through the actual `dsh web` Chromium UI
 * (workspace picker + prompt composer) instead of `dsh --profile headless`.
 * Never runs in ordinary `pnpm test`/CI unless both prerequisites hold.
 */
describe.skipIf(Boolean(skipReason))(
  "live DSH web + Busabase AirApp ChangeRequest scenario",
  () => {
    let standaloneRoot: string;
    let pluginDir: string;
    let dshHome: string;
    let dataDir: string;
    let host: string;
    let busabasePort: number;
    let dshWebHost: string;
    let dshWebPort: number;
    let patchPath: string;
    let dshBinPath: string;
    let redact: (text: string) => string;
    let runSlug: string;
    let appSlug: string;
    let evidenceDir: string | undefined;
    let dshWeb: DshWebRunHandle | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;

    beforeAll(async () => {
      if (skipReason) return;
      const env = liveEnv.config;
      if (!env) throw new Error("live E2E environment resolved ok but config is missing");

      standaloneRoot = await mkdtemp(join(tmpdir(), "busabase-dsh-web-e2e-"));
      dshHome = join(standaloneRoot, "dsh-home");
      dataDir = join(standaloneRoot, "busabase-data");
      await mkdir(dshHome, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      host = "127.0.0.1";
      dshWebHost = "127.0.0.1";
      busabasePort = await allocateLoopbackPort(host);
      dshWebPort = await allocateLoopbackPort(dshWebHost);
      runSlug = generateRunSlug();
      appSlug = runSlug;
      evidenceDir = resolveEvidenceDir({
        pluginRootDir: PLUGIN_SOURCE_DIR,
        runSlug,
        env: process.env,
      });

      const copy = await createStandaloneCopy({
        pluginSourceDir: PLUGIN_SOURCE_DIR,
        repoSkillsDir: env.skillsDir,
        skillNames: SKILL_NAMES,
        destinationDir: standaloneRoot,
      });
      pluginDir = copy.pluginDir;

      redact = createSecretRedactor([env.apiKey]);

      const serverBin =
        process.env.BUSABASE_DSH_E2E_SERVER_BIN ?? (await buildLocalBusabaseServer());

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
          port: busabasePort,
          dataDir,
          npmCacheDir: join(dataDir, "npm-cache"),
          startupTimeoutMs: 60_000,
          mcpReadyTimeoutMs: 60_000,
          ...(serverBin
            ? {
                command: process.execPath,
                commandArgsPrefix: [serverBin, "server"],
              }
            : {}),
        },
      });
      patchPath = join(standaloneRoot, "patch.json");
      await writeFile(patchPath, JSON.stringify(patch), "utf8");

      dshBinPath = resolve(pluginDir, "node_modules/@deepseek-ai/dsh/lib/bin.js");

      // Materializes $DSH_HOME/profiles/web (dsh scaffolds it on first use) then
      // installs the standalone copy into it via `link:`, exactly the README's
      // local-install path — mirrors the headless scenario's setup exactly,
      // just against the "web" profile this run will actually boot.
      await runCommand(
        process.execPath,
        [dshBinPath, "--profile", "web", "--dump-default-config"],
        {
          cwd: pluginDir,
          env: { ...process.env, DSH_HOME: dshHome },
          timeoutMs: 60_000,
        },
      );
      await runCommand(
        process.execPath,
        [dshBinPath, "plugin", "--profile", "web", "add", pluginDir],
        {
          cwd: pluginDir,
          env: { ...process.env, DSH_HOME: dshHome },
          timeoutMs: 120_000,
        },
      );

      dshWeb = await runDshWeb({
        dshBinPath,
        cwd: pluginDir,
        dshHome,
        patchPath,
        host: dshWebHost,
        port: dshWebPort,
        env: { ...process.env },
        readyTimeoutMs: 60_000,
      });

      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    }, 420_000);

    afterAll(async () => {
      if (skipReason) return;
      await page?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await dshWeb?.stop().catch(() => undefined);
      await killProcessOnPort(busabasePort).catch(() => undefined);
      if (!keepArtifacts) await removeStandaloneCopy(standaloneRoot).catch(() => undefined);
    });

    it("installs and builds the standalone plugin copy under a frozen lockfile", async () => {
      await expect(readFile(join(pluginDir, "lib", "index.js"), "utf8")).resolves.toContain(
        "apply",
      );
    }, 30_000);

    it("drives the real dsh web UI through AirApp creation, human review, and automatic right-panel embed preview", async () => {
      if (!page || !dshWeb) throw new Error("browser/page not initialized");
      const currentPage = page;
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

      await currentPage.goto(dshWeb.url, { waitUntil: "domcontentloaded" });
      await dismissTestingNoticeIfPresent(currentPage);
      await captureEvidence(currentPage, evidenceDir, "01-loaded");

      await selectWorkspaceDirectory(currentPage, pluginDir);
      await captureEvidence(currentPage, evidenceDir, "02-workspace-selected");

      await submitPrompt(currentPage, task);
      await captureEvidence(currentPage, evidenceDir, "03-prompt-submitted");

      const parsedMarker = await waitForChangeRequestMarker(
        dshHome,
        dshWeb,
        () => redact(dshWeb.output()),
        600_000,
      );
      await captureEvidence(currentPage, evidenceDir, "04-task-complete");
      if (!parsedMarker) {
        throw new Error("no ChangeRequest marker found in the DSH session log within the timeout");
      }
      expect(parsedMarker.slug).toBe(appSlug);
      const changeRequestId = parsedMarker.changeRequestId;

      // Server-side state is authoritative from here on — the browser DOM is not trusted again.
      const evidence = await collectSessionEvidence(dshHome, "busabase");
      expect(evidence.usedSkillTool).toBe(true);
      expect(evidence.loadedBusabaseAppCreatorSkill).toBe(true);
      expect(evidence.calledBusabaseMcpTool).toBe(true);
      expect(evidence.calledChangeRequestMutationTool).toBe(true);
      expect(evidence.mcpAirAppCreateSlugs).toContain(appSlug);
      expect(evidence.mcpChangeRequestIds).toContain(changeRequestId);

      const client = new Busabase({ baseUrl: `http://${host}:${String(busabasePort)}` });
      const pending = await findPendingChangeRequest(client, {
        changeRequestId,
        slug: appSlug,
      });
      expect(pending.status).toBe("in_review");

      const nodeCreateProvenance = evidence.mcpPreviewProvenance.find(
        (item) =>
          item.toolName === "mcp__busabase__node_create" &&
          item.changeRequestId === changeRequestId,
      );
      if (!nodeCreateProvenance) {
        throw new Error(`no call-level node_create preview provenance for ${changeRequestId}`);
      }
      await verifyChangeRequestPreview(currentPage, client, nodeCreateProvenance);
      await captureEvidence(currentPage, evidenceDir, "05-change-request-embed-preview");

      const iframeUrl = await approveMergeAndOpenPreview(currentPage, appSlug);
      await captureEvidence(currentPage, evidenceDir, "06-automatic-node-embed-preview");

      const merged = await client.changeRequests.get({ changeRequestId: pending.id });
      const mergedNodeIds = merged.mergeSummary.mergedNodeIds;
      const nodeId =
        merged.nodeId ??
        (Array.isArray(mergedNodeIds) && typeof mergedNodeIds[0] === "string"
          ? mergedNodeIds[0]
          : null);
      if (!nodeId) throw new Error("merge succeeded but returned no nodeId");

      const canonical = await readCanonicalAirApp(client, nodeId);
      expect(canonical.shapeCheck).toEqual<ReturnType<typeof checkCanonicalAirAppShape>>({
        ok: true,
        reasons: [],
      });

      const embedUrl = new URL(iframeUrl);
      const embedLinkId = embedUrl.pathname.split("/").filter(Boolean).at(-1);
      if (!embedLinkId) throw new Error(`automatic embed URL has no link id: ${iframeUrl}`);
      expect(embedUrl.searchParams.get("view")).toBe("iframe");
      expect(embedUrl.searchParams.get("token")).toBeTruthy();
      await expect(retrieveActiveEmbedLink(client, nodeId, embedLinkId)).resolves.toEqual({
        id: embedLinkId,
        active: true,
        typeId: nodeId,
      });
      await closeDetailsPanel(currentPage);

      const recordBase = await client.bases.create({
        name: `${appSlug} Records`,
        slug: `${appSlug}-records`,
        fields: [{ slug: "name", name: "Name", type: "text", required: true, options: {} }],
        autoMerge: true,
      });
      const recordName = `${appSlug}-record`;
      const recordTask = [
        "Use the already-running mcp__busabase server.",
        "Call mcp__busabase__bases_create_change_request exactly once with:",
        `baseId: ${recordBase.id}`,
        `fields: {"name":${JSON.stringify(recordName)}}`,
        `message: ${JSON.stringify(`Add ${recordName}`)}`,
        "Do not use autoMerge, do not review or merge the ChangeRequest, and do not call another mutating tool.",
        "After the tool succeeds, report its real ChangeRequest id. Do not claim success if the tool fails.",
      ].join("\n");
      await submitPrompt(currentPage, recordTask);

      const basesCreateProvenance = await waitForPreviewProvenance(
        dshHome,
        dshWeb,
        () => redact(dshWeb.output()),
        "mcp__busabase__bases_create_change_request",
        new Set(evidence.mcpPreviewProvenance.map((item) => item.callId)),
        300_000,
      );
      const recordChangeRequest = await client.changeRequests.get({
        changeRequestId: basesCreateProvenance.changeRequestId,
      });
      expect(recordChangeRequest.status).toBe("in_review");
      expect(recordChangeRequest.baseId).toBe(recordBase.id);
      expect(recordChangeRequest.primaryOperation.operation).toBe("record_create");
      expect(recordChangeRequest.primaryOperation.headCommit.payload).toMatchObject({
        name: recordName,
      });
      await verifyChangeRequestPreview(currentPage, client, basesCreateProvenance);
      await captureEvidence(
        currentPage,
        evidenceDir,
        "07-bases-create-change-request-embed-preview",
      );
    }, 900_000);
  },
);

async function buildLocalBusabaseServer(): Promise<string | undefined> {
  const exists = await access(LOCAL_BUSABASE_BIN)
    .then(() => true)
    .catch(() => false);
  if (!exists) return undefined;
  await runCommand("corepack", ["pnpm", "--dir", LOCAL_BUSABASE_DIR, "build"], {
    cwd: PLUGIN_SOURCE_DIR,
    timeoutMs: 300_000,
  });
  await runCommand("corepack", ["pnpm", "--dir", LOCAL_BUSABASE_DIR, "pack:standalone"], {
    cwd: PLUGIN_SOURCE_DIR,
    timeoutMs: 120_000,
  });
  return LOCAL_BUSABASE_BIN;
}

/**
 * Polls the DSH session log for the model's ChangeRequest marker line — the
 * same authoritative signal the headless scenario reads off stdout, just
 * sourced from the persisted JSONL since the browser transcript is DOM, not
 * a process stream this harness owns.
 */
async function waitForChangeRequestMarker(
  sessionRoot: string,
  dshWeb: DshWebRunHandle,
  output: () => string,
  timeoutMs: number,
): Promise<ChangeRequestMarker | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dshWeb.child.exitCode !== null || dshWeb.child.signalCode !== null) {
      throw new Error(
        `dsh web exited before the ChangeRequest marker was persisted ` +
          `(code=${String(dshWeb.child.exitCode)}, signal=${String(dshWeb.child.signalCode)}): ${output()}`,
      );
    }
    const evidence = await collectSessionEvidence(sessionRoot, "busabase");
    for (const file of evidence.sessionFiles) {
      const text = await readFile(file, "utf8").catch(() => "");
      const marker = parseChangeRequestMarkerFromJsonl(text);
      if (marker) return marker;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return undefined;
}

async function waitForPreviewProvenance(
  sessionRoot: string,
  dshWeb: DshWebRunHandle,
  output: () => string,
  toolName: string,
  excludedCallIds: Set<string>,
  timeoutMs: number,
): Promise<McpPreviewProvenance> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dshWeb.child.exitCode !== null || dshWeb.child.signalCode !== null) {
      throw new Error(
        `dsh web exited before ${toolName} preview provenance was persisted ` +
          `(code=${String(dshWeb.child.exitCode)}, signal=${String(dshWeb.child.signalCode)}): ${output()}`,
      );
    }
    const evidence = await collectSessionEvidence(sessionRoot, "busabase");
    const match = evidence.mcpPreviewProvenance.find(
      (item) => item.toolName === toolName && !excludedCallIds.has(item.callId),
    );
    if (match) return match;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`no call-level ${toolName} preview provenance found within the timeout`);
}

async function verifyChangeRequestPreview(
  page: Page,
  client: Busabase,
  provenance: McpPreviewProvenance,
): Promise<void> {
  const embedUrl = new URL(provenance.iframeUrl);
  expect(embedUrl.pathname.split("/").filter(Boolean).at(-1)).toBe(provenance.embedLinkId);
  expect(embedUrl.searchParams.get("view")).toBe("iframe");
  expect(embedUrl.searchParams.get("token")).toBeTruthy();
  const frame = page.locator(`iframe.bb-change-request-frame[src*="/${provenance.embedLinkId}?"]`);
  await frame.last().waitFor({ state: "attached", timeout: 60_000 });
  expect(await frame.last().getAttribute("src")).toBe(provenance.iframeUrl);
  expect(
    await page.locator(".bb-card").filter({ hasText: provenance.changeRequestId }).count(),
  ).toBe(1);
  const links = await client.embedLinks.list({
    type: "change-request",
    typeId: provenance.changeRequestId,
  });
  expect(links).toContainEqual(
    expect.objectContaining({
      id: provenance.embedLinkId,
      active: true,
      type: "change-request",
      typeId: provenance.changeRequestId,
    }),
  );
}

async function captureEvidence(
  page: Page,
  evidenceDir: string | undefined,
  name: string,
): Promise<void> {
  if (!evidenceDir) return;
  const tempDir = await mkdtemp(join(tmpdir(), "dsh-web-shot-"));
  const tempPath = join(tempDir, `${name}.png`);
  try {
    await page.screenshot({ path: tempPath, fullPage: true });
    await saveEvidenceFile(evidenceDir, tempPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
