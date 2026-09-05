import { spawn } from "node:child_process";
import { resolve } from "node:path";

const webStorageFlag = "--no-experimental-webstorage";
const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim() ?? "";
const nodeOptions = inheritedNodeOptions.includes(webStorageFlag)
  ? inheritedNodeOptions
  : [inheritedNodeOptions, webStorageFlag].filter(Boolean).join(" ");
const child = spawn(
  process.execPath,
  [
    resolve(import.meta.dirname, "../node_modules/vitest/vitest.mjs"),
    "run",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
