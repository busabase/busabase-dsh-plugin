import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedBusabasePluginConfig } from "./config.js";

const exec = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 200;
const STDERR_LIMIT = 4_000;

export type BusabaseServerPhase = "stopped" | "starting" | "running" | "failed";

export interface BusabaseServerStatus {
  phase: BusabaseServerPhase;
  baseUrl: string;
  owned: boolean;
  reason?: string;
}

export type EnsureBusabaseServerResult =
  | {
      ok: true;
      baseUrl: string;
      owned: boolean;
      reused: boolean;
    }
  | {
      ok: false;
      baseUrl: string;
      owned: false;
      reason: string;
    };

type ProbeResult = "healthy" | "foreign" | "unreachable";

export interface BusabaseServerSupervisorDependencies {
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  delay?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  killWindowsTree?: (pid: number) => Promise<void>;
}

export class BusabaseServerSupervisor {
  private child: ChildProcess | null = null;
  private starting: Promise<EnsureBusabaseServerResult> | null = null;
  private lastFailure: string | undefined;
  private stderr = "";
  private owned = false;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly killWindowsTree: (pid: number) => Promise<void>;

  constructor(
    private readonly config: ResolvedBusabasePluginConfig,
    dependencies: BusabaseServerSupervisorDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.spawnImpl = dependencies.spawn ?? spawn;
    this.delay = dependencies.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.platform = dependencies.platform ?? process.platform;
    this.killWindowsTree =
      dependencies.killWindowsTree ??
      (async (pid) => {
        await exec("taskkill", ["/pid", String(pid), "/t", "/f"]).catch(() => undefined);
      });
  }

  async status(): Promise<BusabaseServerStatus> {
    if (this.starting) return { phase: "starting", baseUrl: this.config.baseUrl, owned: false };
    const probe = await this.probe();
    if (probe === "healthy")
      return { phase: "running", baseUrl: this.config.baseUrl, owned: this.owned };
    if (this.owned) this.clearChild();
    if (this.lastFailure)
      return {
        phase: "failed",
        baseUrl: this.config.baseUrl,
        owned: false,
        reason: this.lastFailure,
      };
    if (probe === "foreign")
      return {
        phase: "failed",
        baseUrl: this.config.baseUrl,
        owned: false,
        reason: this.foreignServiceReason(),
      };
    return { phase: "stopped", baseUrl: this.config.baseUrl, owned: false };
  }

  async ensure(): Promise<EnsureBusabaseServerResult> {
    const probe = await this.probe();
    if (probe === "healthy") {
      this.lastFailure = undefined;
      return { ok: true, baseUrl: this.config.baseUrl, owned: this.owned, reused: true };
    }
    if (probe === "foreign") return this.fail(this.foreignServiceReason());
    if (!this.shouldManage())
      return this.fail(
        `Busabase is unavailable at ${this.config.baseUrl}; server.mode is external`,
      );
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.config.server.stopOnDispose) await this.stopOwnedChild();
    this.lastFailure = undefined;
  }

  private shouldManage(): boolean {
    return (
      this.config.server.mode === "managed" ||
      (this.config.server.mode === "auto" && this.config.server.manageable)
    );
  }

  private async start(): Promise<EnsureBusabaseServerResult> {
    this.stderr = "";
    let child: ChildProcess;
    try {
      const options: SpawnOptions = {
        cwd: this.config.server.cwd || undefined,
        env: { ...process.env, ...this.config.server.env },
        stdio: ["ignore", "ignore", "pipe"],
        detached: this.platform !== "win32",
        windowsHide: true,
      };
      child = this.spawnImpl(this.config.server.command, this.config.server.args, options);
    } catch (error) {
      return this.fail(`failed to launch Busabase: ${errorMessage(error)}`);
    }
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.config.server.startupTimeoutMs) {
      if (spawnError) {
        this.clearChild(child);
        return this.fail(`failed to launch Busabase: ${spawnError.message}`);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        this.clearChild(child);
        const detail = this.stderr.trim();
        return this.fail(
          detail ||
            `Busabase exited before becoming ready (${String(child.signalCode ?? child.exitCode ?? "unknown")})`,
        );
      }
      if ((await this.probe()) === "healthy") {
        this.owned = true;
        this.lastFailure = undefined;
        return { ok: true, baseUrl: this.config.baseUrl, owned: true, reused: false };
      }
      await this.delay(PROBE_INTERVAL_MS);
    }

    await this.stopOwnedChild(true);
    return this.fail(
      `Busabase did not become ready within ${String(this.config.server.startupTimeoutMs)}ms`,
    );
  }

  private async probe(): Promise<ProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(new URL("/api/health", this.config.baseUrl), {
        signal: controller.signal,
      });
      if (!response.ok) return "foreign";
      const body = (await response.json().catch(() => null)) as {
        service?: unknown;
        status?: unknown;
      } | null;
      return body?.service === "busabase" && body.status === "ok" ? "healthy" : "foreign";
    } catch {
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopOwnedChild(force = false): Promise<void> {
    const child = this.child;
    if (!child || (!this.owned && !force)) return;
    this.clearChild(child);
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (this.platform === "win32") {
      await this.killWindowsTree(child.pid);
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await this.delay(500);
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }

  private clearChild(expected?: ChildProcess): void {
    if (expected && this.child !== expected) return;
    this.child = null;
    this.owned = false;
  }

  private fail(reason: string): EnsureBusabaseServerResult {
    this.lastFailure = reason;
    return { ok: false, baseUrl: this.config.baseUrl, owned: false, reason };
  }

  private foreignServiceReason(): string {
    return `Port ${String(this.config.server.port)} at ${this.config.baseUrl} is occupied by a non-Busabase service`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
