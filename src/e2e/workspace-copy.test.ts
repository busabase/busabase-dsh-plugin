import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStandaloneCopy,
  isEmptyOrMissingDir,
  removeStandaloneCopy,
  shouldCopyEntry,
} from "./workspace-copy.js";

describe("shouldCopyEntry", () => {
  it("excludes node_modules, lib, build caches, and vcs metadata", () => {
    for (const name of ["node_modules", "lib", ".turbo", ".git", ".logs", ".dsh", "coverage"]) {
      expect(shouldCopyEntry(name)).toBe(false);
    }
  });

  it("excludes packaged tarballs and tsbuildinfo files", () => {
    expect(shouldCopyEntry("busabase-dsh-plugin-0.1.0.tgz")).toBe(false);
    expect(shouldCopyEntry("tsconfig.tsbuildinfo")).toBe(false);
  });

  it("keeps ordinary source, config, and doc files", () => {
    for (const name of ["src", "package.json", "pnpm-lock.yaml", "README.md", "cordis.patch.yml"]) {
      expect(shouldCopyEntry(name)).toBe(true);
    }
  });
});

describe("createStandaloneCopy / removeStandaloneCopy", () => {
  let workDir: string;
  let pluginSourceDir: string;
  let repoSkillsDir: string;
  let destinationDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "workspace-copy-"));
    pluginSourceDir = join(workDir, "plugin-source");
    repoSkillsDir = join(workDir, "skills-source");
    destinationDir = join(workDir, "standalone");

    await mkdir(join(pluginSourceDir, "src"), { recursive: true });
    await mkdir(join(pluginSourceDir, "node_modules", "left-over"), { recursive: true });
    await mkdir(join(pluginSourceDir, "lib"), { recursive: true });
    await mkdir(join(pluginSourceDir, "skills", "stale-copy"), { recursive: true });
    await writeFile(join(pluginSourceDir, "package.json"), "{}");
    await writeFile(join(pluginSourceDir, "src", "index.ts"), "export {};");
    await writeFile(join(pluginSourceDir, "plugin-0.1.0.tgz"), "fake-tarball");

    await mkdir(join(repoSkillsDir, "busabase-app-creator", "references"), { recursive: true });
    await writeFile(join(repoSkillsDir, "busabase-app-creator", "SKILL.md"), "# skill");
    await writeFile(
      join(repoSkillsDir, "busabase-app-creator", "references", "runtime-and-sdk.md"),
      "# ref",
    );
    await mkdir(join(repoSkillsDir, "busabase"), { recursive: true });
    await writeFile(join(repoSkillsDir, "busabase", "SKILL.md"), "# busabase skill");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("copies plugin source excluding node_modules/lib/tarball, and both skill bundles", async () => {
    const result = await createStandaloneCopy({
      pluginSourceDir,
      repoSkillsDir,
      skillNames: ["busabase-app-creator", "busabase"],
      destinationDir,
    });

    const pluginEntries = await readdir(result.pluginDir);
    expect(pluginEntries).toContain("src");
    expect(pluginEntries).toContain("package.json");
    expect(pluginEntries).not.toContain("node_modules");
    expect(pluginEntries).not.toContain("lib");
    expect(pluginEntries).not.toContain("skills");
    expect(pluginEntries.some((entry) => entry.endsWith(".tgz"))).toBe(false);

    const skillEntries = await readdir(result.skillsDir);
    expect(skillEntries.sort()).toEqual(["busabase", "busabase-app-creator"]);
    expect(result.skillsDir).toBe(join(result.pluginDir, ".agents", "skills"));

    const creatorEntries = await readdir(join(result.skillsDir, "busabase-app-creator"));
    expect(creatorEntries).toContain("SKILL.md");
    expect(creatorEntries).toContain("references");
  });

  it("removes the full standalone copy", async () => {
    await createStandaloneCopy({
      pluginSourceDir,
      repoSkillsDir,
      skillNames: ["busabase-app-creator", "busabase"],
      destinationDir,
    });
    await removeStandaloneCopy(destinationDir);
    await expect(isEmptyOrMissingDir(destinationDir)).resolves.toBe(true);
  });

  it("tolerates removing an already-removed directory", async () => {
    await expect(
      removeStandaloneCopy(join(destinationDir, "never-created")),
    ).resolves.toBeUndefined();
  });
});

describe("isEmptyOrMissingDir", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "empty-check-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("is true for a missing directory", async () => {
    await expect(isEmptyOrMissingDir(join(workDir, "missing"))).resolves.toBe(true);
  });

  it("is true for an empty directory and false once it has content", async () => {
    const dir = join(workDir, "dir");
    await mkdir(dir);
    await expect(isEmptyOrMissingDir(dir)).resolves.toBe(true);
    await writeFile(join(dir, "file.txt"), "x");
    await expect(isEmptyOrMissingDir(dir)).resolves.toBe(false);
  });
});
