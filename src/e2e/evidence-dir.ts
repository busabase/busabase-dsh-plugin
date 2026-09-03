import { copyFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface EvidenceDirInput {
  /** Absolute path to the plugin package root (this app's directory). */
  pluginRootDir: string;
  /** Sub-directory name for one run's evidence, e.g. a run slug. */
  runSlug: string;
  env: Record<string, string | undefined>;
}

/**
 * Resolves where this run's durable evidence (screenshots, etc.) should be
 * copied, or `undefined` when the run has not opted in to keeping any.
 * `BUSABASE_DSH_E2E_EVIDENCE_DIR` takes an explicit absolute directory;
 * otherwise `BUSABASE_DSH_E2E_KEEP_ARTIFACTS=1` falls back to the
 * `.artifacts/<runSlug>` directory already declared in the repo's
 * `.gitignore` (`apps/busabase-dsh-plugin/.artifacts`), so evidence never
 * needs its own gitignore entry and is trivially found by a human reviewer
 * without depending on the ephemeral standalone temp copy surviving.
 */
export function resolveEvidenceDir(input: EvidenceDirInput): string | undefined {
  const explicit = input.env.BUSABASE_DSH_E2E_EVIDENCE_DIR;
  if (explicit && explicit.trim().length > 0) return resolve(explicit.trim(), input.runSlug);
  if (input.env.BUSABASE_DSH_E2E_KEEP_ARTIFACTS === "1")
    return join(input.pluginRootDir, ".artifacts", input.runSlug);
  return undefined;
}

/**
 * Copies one evidence file (e.g. a Playwright screenshot) into the resolved
 * evidence directory under its own basename, creating the directory on
 * first use. No-op targets are the caller's responsibility to skip —
 * this always copies when called.
 */
export async function saveEvidenceFile(evidenceDir: string, sourcePath: string): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const destination = join(evidenceDir, basename(sourcePath));
  await copyFile(sourcePath, destination);
  return destination;
}
