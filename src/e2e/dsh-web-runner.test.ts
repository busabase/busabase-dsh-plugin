import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDshWeb } from "./dsh-web-runner.js";

describe("runDshWeb", () => {
  let workDir: string;
  let fakeDshPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "dsh-web-runner-"));
    fakeDshPath = join(workDir, "fake-dsh.js");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("resolves the ready URL once the child prints the ready line, and passes through argv/env", async () => {
    await writeFile(
      fakeDshPath,
      "const args = process.argv.slice(2);\n" +
        "console.log(JSON.stringify({ args, dshHome: process.env.DSH_HOME }));\n" +
        'console.log("dsh web: http://127.0.0.1:39999");\n' +
        "setInterval(() => {}, 1000);\n",
    );

    const handle = await runDshWeb({
      dshBinPath: fakeDshPath,
      cwd: workDir,
      dshHome: join(workDir, "home"),
      patchPath: join(workDir, "patch.json"),
      host: "127.0.0.1",
      port: 39_999,
      env: { ...process.env },
      readyTimeoutMs: 5_000,
    });

    expect(handle.url).toBe("http://127.0.0.1:39999");
    expect(handle.output()).toContain(
      JSON.stringify({
        args: [
          "--profile",
          "web",
          "--patch",
          join(workDir, "patch.json"),
          "--host",
          "127.0.0.1",
          "--port",
          "39999",
          "--no-open",
        ],
        dshHome: join(workDir, "home"),
      }),
    );

    await handle.stop();
    expect(handle.child.signalCode).toBe("SIGTERM");
  }, 10_000);

  it("rejects if the child exits before printing a ready line", async () => {
    await writeFile(fakeDshPath, 'console.error("boom"); process.exit(1);\n');

    await expect(
      runDshWeb({
        dshBinPath: fakeDshPath,
        cwd: workDir,
        dshHome: join(workDir, "home"),
        patchPath: join(workDir, "patch.json"),
        host: "127.0.0.1",
        port: 40_000,
        env: { ...process.env },
        readyTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/boom/);
  }, 10_000);

  it("rejects on timeout when the child never prints a ready line or exits", async () => {
    await writeFile(fakeDshPath, "setInterval(() => {}, 1000);\n");

    const pending = runDshWeb({
      dshBinPath: fakeDshPath,
      cwd: workDir,
      dshHome: join(workDir, "home"),
      patchPath: join(workDir, "patch.json"),
      host: "127.0.0.1",
      port: 40_001,
      env: { ...process.env },
      readyTimeoutMs: 200,
    });

    await expect(pending).rejects.toThrow(/did not print a ready line/);
  }, 10_000);

  it("stop() is a no-op when the child already exited", async () => {
    await writeFile(
      fakeDshPath,
      'console.log("dsh web: http://127.0.0.1:40002");\nprocess.exit(0);\n',
    );
    const handle = await runDshWeb({
      dshBinPath: fakeDshPath,
      cwd: workDir,
      dshHome: join(workDir, "home"),
      patchPath: join(workDir, "patch.json"),
      host: "127.0.0.1",
      port: 40_002,
      env: { ...process.env },
      readyTimeoutMs: 5_000,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    await expect(handle.stop()).resolves.toBeUndefined();
  }, 10_000);
});
