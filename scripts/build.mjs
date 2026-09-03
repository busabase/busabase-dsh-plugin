import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const lib = resolve(root, "lib");
await rm(lib, { recursive: true, force: true });
await mkdir(lib, { recursive: true });

const packagedSkillsDir = resolve(lib, "skills");
await cp(resolve(root, "skills"), packagedSkillsDir, {
  recursive: true,
  dereference: true,
  filter: (source) => {
    const name = source.split(/[\\/]/).pop() ?? source;
    return name !== "__pycache__" && !name.endsWith(".pyc") && !name.includes(".test.");
  },
});
await makeAirAppTemplatePackable(packagedSkillsDir);

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: resolve(lib, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  sourcemap: true,
});

const clientTmp = resolve(lib, "client.cjs");
await build({
  entryPoints: [resolve(root, "src/client.tsx")],
  outfile: clientTmp,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: [
    "react",
    "react/jsx-runtime",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-runtime/*",
    "@deepseek-ai/dsh-client-ui-tool",
    "@deepseek-ai/dsh-client-ui-tool/*",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-conversation/*",
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-ui-layout/*",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-slots/*",
  ],
  loader: { ".css": "text" },
  sourcemap: false,
});

const clientCode = await readFile(clientTmp, "utf8");
const indentedClientCode = clientCode
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")
  .replace(/[\t ]+$/gm, "");
await writeFile(
  resolve(lib, "client.js"),
  `window.__ModuleLoader__.load({\n  id: "@busabase/dsh-plugin",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${indentedClientCode}\n    return module.exports;\n  }\n});\n`,
);
await rm(clientTmp);
await writeFile(
  resolve(lib, "styles.css"),
  await readFile(resolve(root, "src/styles.css"), "utf8"),
);
await exec(
  process.execPath,
  [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(root, "tsconfig.build.json")],
  { cwd: root },
);

await mkdir(dirname(resolve(lib, "types/client.d.ts")), { recursive: true });

async function makeAirAppTemplatePackable(skillsDir) {
  const creatorDir = resolve(skillsDir, "busabase-app-creator");
  const templateDir = resolve(creatorDir, "assets/airapp-template");
  await rename(resolve(templateDir, ".gitignore"), resolve(templateDir, "gitignore.template"));

  const kitPath = resolve(creatorDir, "scripts/airapp-kit.mjs");
  const source = await readFile(kitPath, "utf8");
  const fsImportPattern = /import \{([^}]+)\} from "node:fs\/promises";/;
  const scaffoldCopy = "  await cp(templateDir, output, { recursive: true });";
  const restoreGitignore =
    '  await rename(path.join(output, "gitignore.template"), path.join(output, ".gitignore"));';

  const importMatch = source.match(fsImportPattern);
  if (!importMatch || !source.includes(scaffoldCopy)) {
    throw new Error("Unable to prepare busabase-app-creator for npm packaging");
  }

  const imports = importMatch[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!imports.includes("rename")) imports.push("rename");

  const packagedSource = source
    .replace(fsImportPattern, `import { ${imports.join(", ")} } from "node:fs/promises";`)
    .replace(scaffoldCopy, `${scaffoldCopy}\n${restoreGitignore}`);
  await writeFile(kitPath, packagedSource);
}
