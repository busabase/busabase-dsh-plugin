import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEvidenceDir, saveEvidenceFile } from "./evidence-dir.js";

describe("resolveEvidenceDir", () => {
  const pluginRootDir = "/plugin-root";

  it("returns undefined when neither env var is set", () => {
    expect(resolveEvidenceDir({ pluginRootDir, runSlug: "run-1", env: {} })).toBeUndefined();
  });

  it("prefers an explicit BUSABASE_DSH_E2E_EVIDENCE_DIR, resolved and joined with the run slug", () => {
    expect(
      resolveEvidenceDir({
        pluginRootDir,
        runSlug: "run-1",
        env: { BUSABASE_DSH_E2E_EVIDENCE_DIR: "/custom/evidence" },
      }),
    ).toBe("/custom/evidence/run-1");
  });

  it("ignores a blank explicit env var and falls through to the keep-artifacts default", () => {
    expect(
      resolveEvidenceDir({
        pluginRootDir,
        runSlug: "run-1",
        env: { BUSABASE_DSH_E2E_EVIDENCE_DIR: "   ", BUSABASE_DSH_E2E_KEEP_ARTIFACTS: "1" },
      }),
    ).toBe(join(pluginRootDir, ".artifacts", "run-1"));
  });

  it("falls back to <pluginRootDir>/.artifacts/<runSlug> when BUSABASE_DSH_E2E_KEEP_ARTIFACTS=1", () => {
    expect(
      resolveEvidenceDir({
        pluginRootDir,
        runSlug: "run-1",
        env: { BUSABASE_DSH_E2E_KEEP_ARTIFACTS: "1" },
      }),
    ).toBe(join(pluginRootDir, ".artifacts", "run-1"));
  });

  it("treats any value other than the literal '1' as not opted in", () => {
    expect(
      resolveEvidenceDir({
        pluginRootDir,
        runSlug: "run-1",
        env: { BUSABASE_DSH_E2E_KEEP_ARTIFACTS: "true" },
      }),
    ).toBeUndefined();
  });
});

describe("saveEvidenceFile", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "evidence-dir-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates the evidence directory and copies the file under its basename", async () => {
    const sourcePath = join(workDir, "source", "shot.png");
    await mkdir(join(workDir, "source"), { recursive: true });
    await writeFile(sourcePath, "fake-png-bytes", "utf8");
    const evidenceDir = join(workDir, "evidence", "run-1");

    const destination = await saveEvidenceFile(evidenceDir, sourcePath);

    expect(destination).toBe(join(evidenceDir, "shot.png"));
    await expect(readFile(destination, "utf8")).resolves.toBe("fake-png-bytes");
  });
});
