import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUNDLED_SKILL_NAMES, linkBundledSkills } from "./link-skills.mjs";

const createFixture = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "busabase-dsh-skill-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "apps", "busabase-dsh-plugin");
  const sourceRoot = join(root, ".agents", "skills");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");
  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(sourceRoot, name), { recursive: true });
    await writeFile(join(sourceRoot, name, "SKILL.md"), `# ${name}\n`);
  }
  return { packageRoot, sourceRoot };
};

test("creates only the two canonical skill links and reuses them", async (t) => {
  const fixture = await createFixture(t);
  assert.deepEqual(await linkBundledSkills(fixture), { linked: 2, reused: 0, skipped: false });
  assert.deepEqual(await linkBundledSkills(fixture), { linked: 0, reused: 2, skipped: false });

  for (const name of BUNDLED_SKILL_NAMES) {
    const destination = join(fixture.packageRoot, "skills", name);
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    assert.equal(await realpath(destination), await realpath(join(fixture.sourceRoot, name)));
  }
});

test("refuses to overwrite an existing non-link destination", async (t) => {
  const fixture = await createFixture(t);
  const destination = join(fixture.packageRoot, "skills", "busabase");
  await mkdir(destination, { recursive: true });

  await assert.rejects(
    linkBundledSkills(fixture),
    /Refusing to replace non-link skill destination/,
  );
});

test("links the package-local canonical skills in a standalone source copy", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "busabase-dsh-standalone-source-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");
  const sourceRoot = join(packageRoot, ".agents", "skills");
  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(sourceRoot, name), { recursive: true });
    await writeFile(join(sourceRoot, name, "SKILL.md"), `# ${name}\n`);
  }

  assert.deepEqual(await linkBundledSkills({ packageRoot }), {
    linked: 2,
    reused: 0,
    skipped: false,
  });
  assert.equal(
    await realpath(join(packageRoot, "skills", "busabase")),
    await realpath(join(sourceRoot, "busabase")),
  );
});

test("links a standalone busabase/skills checkout", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "busabase-dsh-skills-checkout-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");
  const sourceRoot = join(packageRoot, ".skills-source", "skills");
  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(sourceRoot, name), { recursive: true });
    await writeFile(join(sourceRoot, name, "SKILL.md"), `# ${name}\n`);
  }

  assert.deepEqual(await linkBundledSkills({ packageRoot }), {
    linked: 2,
    reused: 0,
    skipped: false,
  });
  assert.equal(
    await realpath(join(packageRoot, "skills", "busabase-app-creator")),
    await realpath(join(sourceRoot, "busabase-app-creator")),
  );
});

test("skips an incomplete candidate when a later source has both Skills", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "busabase-dsh-partial-skills-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");
  await mkdir(join(packageRoot, ".agents", "skills", "busabase"), { recursive: true });

  const completeRoot = join(packageRoot, ".skills-source", "skills");
  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(completeRoot, name), { recursive: true });
    await writeFile(join(completeRoot, name, "SKILL.md"), `# ${name}\n`);
  }

  await linkBundledSkills({ packageRoot });
  assert.equal(
    await realpath(join(packageRoot, "skills", "busabase")),
    await realpath(join(completeRoot, "busabase")),
  );
});

test("skips when no canonical Skills source exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "busabase-dsh-published-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    await linkBundledSkills({ packageRoot: root, sourceRoot: join(root, "missing") }),
    { linked: 0, reused: 0, skipped: true },
  );
});

test("links a busabase/skills/dsh-plugin checkout via sibling ../skills", async (t) => {
  const skillsRepoRoot = await mkdtemp(join(tmpdir(), "busabase-skills-repo-"));
  t.after(() => rm(skillsRepoRoot, { recursive: true, force: true }));
  const packageRoot = join(skillsRepoRoot, "dsh-plugin");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");
  const sourceRoot = join(skillsRepoRoot, "skills");
  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(sourceRoot, name), { recursive: true });
    await writeFile(join(sourceRoot, name, "SKILL.md"), `# ${name}\n`);
  }

  assert.deepEqual(await linkBundledSkills({ packageRoot }), {
    linked: 2,
    reused: 0,
    skipped: false,
  });
  for (const name of BUNDLED_SKILL_NAMES) {
    assert.equal(
      await realpath(join(packageRoot, "skills", name)),
      await realpath(join(sourceRoot, name)),
    );
  }

  const fallbackRoot = join(packageRoot, ".skills-source", "skills");
  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(fallbackRoot, name), { recursive: true });
    await writeFile(join(fallbackRoot, name, "SKILL.md"), `# fallback ${name}\n`);
  }
  assert.deepEqual(await linkBundledSkills({ packageRoot }), {
    linked: 0,
    reused: 2,
    skipped: false,
  });
});

test("repairs exact Git-materialized skill links as Windows junctions", async (t) => {
  const skillsRepoRoot = await mkdtemp(join(tmpdir(), "busabase-skills-windows-"));
  t.after(() => rm(skillsRepoRoot, { recursive: true, force: true }));
  const packageRoot = join(skillsRepoRoot, "dsh-plugin");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");

  for (const name of BUNDLED_SKILL_NAMES) {
    await mkdir(join(skillsRepoRoot, "skills", name), { recursive: true });
    await writeFile(join(skillsRepoRoot, "skills", name, "SKILL.md"), `# ${name}\n`);
    await mkdir(join(packageRoot, "skills"), { recursive: true });
    await writeFile(join(packageRoot, "skills", name), `../../skills/${name}`);
  }

  assert.deepEqual(await linkBundledSkills({ packageRoot, platform: "win32" }), {
    linked: 2,
    reused: 0,
    skipped: false,
  });
  for (const name of BUNDLED_SKILL_NAMES) {
    assert.equal((await lstat(join(packageRoot, "skills", name))).isSymbolicLink(), true);
    assert.equal(
      await realpath(join(packageRoot, "skills", name)),
      await realpath(join(skillsRepoRoot, "skills", name)),
    );
  }
});

test("reports missing canonical Skills in a source checkout", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "busabase-dsh-missing-skills-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "index.ts"), "export {};\n");

  await assert.rejects(
    linkBundledSkills({ packageRoot }),
    /clone https:\/\/github\.com\/busabase\/skills\.git to \.skills-source/,
  );
});
