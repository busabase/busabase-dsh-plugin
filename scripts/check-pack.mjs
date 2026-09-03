import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
  cwd: resolve(import.meta.dirname, ".."),
});
const [packResult] = JSON.parse(stdout);
const files = new Set(packResult.files.map(({ path }) => path));
const requiredFiles = [
  "lib/skills/busabase/SKILL.md",
  "lib/skills/busabase-app-creator/SKILL.md",
  "lib/skills/busabase-app-creator/scripts/airapp-kit.mjs",
  "lib/skills/busabase-app-creator/assets/airapp-template/gitignore.template",
  "scripts/link-skills.mjs",
];

for (const path of requiredFiles) {
  if (!files.has(path)) throw new Error(`npm package is missing required file: ${path}`);
}
if ([...files].some((path) => path.startsWith("skills/"))) {
  throw new Error("npm package must not contain the generated source skills links");
}
if ([...files].some((path) => path.includes("__pycache__") || path.includes(".test."))) {
  throw new Error("npm package must not contain canonical Skill test or cache artifacts");
}

console.log(`npm package contains ${packResult.entryCount} files, including both bundled Skills.`);
