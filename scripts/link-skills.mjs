import { lstat, mkdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const BUNDLED_SKILL_NAMES = ["busabase", "busabase-app-creator"];

const statOrUndefined = async (path, followLinks = true) => {
  try {
    return await (followLinks ? stat(path) : lstat(path));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
};

export async function linkBundledSkills(options = {}) {
  const packageRoot = options.packageRoot ?? resolve(import.meta.dirname, "..");
  const platform = options.platform ?? process.platform;
  const destinationRoot = resolve(packageRoot, "skills");
  const sourceCheckout = await statOrUndefined(resolve(packageRoot, "src", "index.ts"));

  // Published packages contain materialized lib/skills and exclude the TypeScript source tree.
  if (!sourceCheckout) return { linked: 0, reused: 0, skipped: true };

  const sourceCandidates = options.sourceRoot
    ? [options.sourceRoot]
    : [
        resolve(packageRoot, "../..", ".agents", "skills"),
        resolve(packageRoot, ".agents", "skills"),
        // When embedded at busabase/skills/dsh-plugin, the package sits one
        // level below that repository's root skills. Prefer those committed links
        // instead of requiring a redundant .skills-source clone.
        resolve(packageRoot, "..", "skills"),
        resolve(packageRoot, ".skills-source", "skills"),
      ];
  let sourceRoot;
  for (const candidate of sourceCandidates) {
    const candidateStat = await statOrUndefined(candidate);
    if (!candidateStat?.isDirectory()) continue;
    const requiredSkills = await Promise.all(
      BUNDLED_SKILL_NAMES.map((name) => statOrUndefined(resolve(candidate, name))),
    );
    if (!requiredSkills.every((skill) => skill?.isDirectory())) continue;
    sourceRoot = candidate;
    break;
  }

  if (!sourceRoot) {
    throw new Error(
      "Canonical Busabase Skills not found. In a standalone checkout, clone https://github.com/busabase/skills.git to .skills-source before installing.",
    );
  }

  const sources = BUNDLED_SKILL_NAMES.map((name) => ({
    name,
    source: resolve(sourceRoot, name),
    destination: resolve(destinationRoot, name),
  }));

  await mkdir(destinationRoot, { recursive: true });
  let linked = 0;
  let reused = 0;

  for (const { name, source, destination } of sources) {
    const destinationStat = await statOrUndefined(destination, false);
    if (destinationStat) {
      if (!destinationStat.isSymbolicLink()) {
        const portableTarget = relative(dirname(destination), source).replaceAll("\\", "/");
        const materializedLink =
          platform === "win32" && destinationStat.isFile()
            ? (await readFile(destination, "utf8")).trim()
            : undefined;
        if (materializedLink !== portableTarget) {
          throw new Error(`Refusing to replace non-link skill destination: ${destination}`);
        }
        // With core.symlinks=false, Git checks a committed symlink out as a
        // plain file containing its relative target. Replace only that exact
        // representation with the junction Windows needs.
        await rm(destination);
      } else {
        let destinationRealPath;
        try {
          destinationRealPath = await realpath(destination);
        } catch {
          throw new Error(`Refusing to replace broken skill link: ${destination}`);
        }
        if (destinationRealPath !== (await realpath(source))) {
          throw new Error(
            `Refusing to replace skill link with an unexpected target: ${destination}`,
          );
        }
        reused += 1;
        continue;
      }
    }

    const target = platform === "win32" ? source : relative(dirname(destination), source);
    await symlink(target, destination, platform === "win32" ? "junction" : "dir");
    linked += 1;
    console.log(`Linked ${name}: ${destination} -> ${target}`);
  }

  return { linked, reused, skipped: false };
}

if (import.meta.main) {
  await linkBundledSkills();
}
