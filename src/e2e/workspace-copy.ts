import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

/** Directory/file names never copied into the standalone workspace. */
const EXCLUDED_NAMES = new Set([
  "node_modules",
  "lib",
  ".turbo",
  ".git",
  ".logs",
  ".dsh",
  "coverage",
]);

/** File suffixes never copied — build artifacts and packaged tarballs. */
const EXCLUDED_SUFFIXES = [".tgz", ".tsbuildinfo"];

export function shouldCopyEntry(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return false;
  if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  return true;
}

export interface StandaloneCopyInput {
  /** Absolute path to the plugin package source (this app's directory). */
  pluginSourceDir: string;
  /** Absolute path to the repo's `.agents/skills` directory. */
  repoSkillsDir: string;
  /** Skill directory names to copy from `repoSkillsDir`, e.g. ["busabase-app-creator", "busabase"]. */
  skillNames: readonly string[];
  /** Destination root for the standalone copy; created if absent. */
  destinationDir: string;
}

export interface StandaloneCopyResult {
  pluginDir: string;
  skillsDir: string;
}

/**
 * Materializes an isolated standalone copy of the plugin package (excluding
 * node_modules/lib/tarball/transient artifacts) plus the exact skill bundles
 * the model task depends on, under `.agents/skills` so DSH's
 * `dsh-skill-filesystem` discovers them relative to the copy's own cwd.
 */
export async function createStandaloneCopy(
  input: StandaloneCopyInput,
): Promise<StandaloneCopyResult> {
  const pluginDir = join(input.destinationDir, "plugin");
  const skillsDir = join(pluginDir, ".agents", "skills");
  await mkdir(input.destinationDir, { recursive: true });

  await cp(input.pluginSourceDir, pluginDir, {
    recursive: true,
    filter: (source) => {
      if (relative(input.pluginSourceDir, source) === "skills") return false;
      return shouldCopyEntry(source.split("/").pop() ?? source);
    },
  });

  await mkdir(skillsDir, { recursive: true });
  for (const skillName of input.skillNames) {
    await cp(join(input.repoSkillsDir, skillName), join(skillsDir, skillName), {
      recursive: true,
      filter: (source) => shouldCopyEntry(source.split("/").pop() ?? source),
    });
  }

  return { pluginDir, skillsDir };
}

/** Removes the standalone copy's root, tolerating a partially-created or already-removed directory. */
export async function removeStandaloneCopy(destinationDir: string): Promise<void> {
  await rm(destinationDir, { recursive: true, force: true });
}

/** True when `dir` exists and is non-empty; used to refuse overwriting unrelated content. */
export async function isEmptyOrMissingDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}
