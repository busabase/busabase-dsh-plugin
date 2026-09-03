// @vitest-environment node

import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { describe, expect, it } from "vitest";
import { registerBundledSkills } from "./index.js";

describe("bundled skills", () => {
  it("loads the canonical linked Busabase skills and their resources", async () => {
    const host = new Context();
    const registry = new SkillRegistry(host);
    const dispose = registerBundledSkills(Object.assign(host, { skills: registry }));

    const catalog = await registry.list();
    expect(catalog.map(({ name }) => name)).toEqual(["busabase", "busabase-app-creator"]);

    const busabase = await registry.get("busabase");
    const creator = await registry.get("busabase-app-creator");
    expect(busabase?.content).toContain("# Busabase");
    expect(creator?.content).toContain("# Busabase App Creator");
    expect(creator?.resourceBase?.kind).toBe("directory");
    if (creator?.resourceBase?.kind !== "directory") throw new Error("Missing Skill resources");

    const canonicalCandidates = [
      path.resolve(process.cwd(), "../../.agents/skills/busabase-app-creator"),
      path.resolve(process.cwd(), ".agents/skills/busabase-app-creator"),
      path.resolve(process.cwd(), ".skills-source/skills/busabase-app-creator"),
      path.resolve(process.cwd(), "../skills/busabase-app-creator"),
    ];
    const canonicalPaths = (
      await Promise.all(
        canonicalCandidates.map(async (candidate) => {
          try {
            return await realpath(candidate);
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((candidate): candidate is string => Boolean(candidate));
    expect(canonicalPaths).toContain(await realpath(creator.resourceBase.path));

    await expect(
      access(path.join(creator.resourceBase.path, "scripts", "airapp-kit.mjs")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(creator.resourceBase.path, "assets", "airapp-template", ".gitignore")),
    ).resolves.toBeUndefined();

    dispose();
  });
});
