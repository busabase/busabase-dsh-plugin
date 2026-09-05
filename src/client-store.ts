import { Busabase } from "busabase-sdk";
import type { ResolvedBusabasePluginConfig } from "./config.js";
import { type BusabaseEntityRef, normalizeBusabaseResult } from "./normalize.js";
import { autoPreviewRef, canonicalNodeId, createNodePreviewLink } from "./preview-link.js";

export interface InspectorSnapshot {
  selected: BusabaseEntityRef | null;
  selectedSessionId: string | null;
  data: unknown;
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
  live: "connecting" | "connected" | "polling" | "stopped";
  action: string | null;
  resumeNotices: Readonly<Record<string, ResumeNotice>>;
}

export interface ResumeNotice {
  sessionId: string;
  changeRequestId: string;
  message: string;
}

type Listener = () => void;
type EnsureServer = () => Promise<void>;
type CreateNodePreview = (nodeId: string) => Promise<unknown>;

const REMOTE_UNSUPPORTED_MESSAGE =
  "Inspector review, merge, and live data are local-only in this release; open the canonical Busabase Cloud link instead.";

export class BusabaseInspectorStore {
  readonly client: Busabase;
  private snapshot: InspectorSnapshot = {
    selected: null,
    selectedSessionId: null,
    data: null,
    phase: "idle",
    error: null,
    live: "stopped",
    action: null,
    resumeNotices: {},
  };
  private listeners = new Set<Listener>();
  private readAbort?: AbortController;
  private liveAbort?: AbortController;
  private pollTimer?: ReturnType<typeof setInterval>;
  private requestVersion = 0;
  private serverStart?: Promise<void>;
  private readonly resumedApprovals = new Set<string>();

  constructor(
    readonly config: ResolvedBusabasePluginConfig,
    client?: Busabase,
    private readonly startServer: EnsureServer = requestServerStart,
    private readonly createPreview: CreateNodePreview = (nodeId) =>
      createNodePreviewLink(this.client, nodeId),
  ) {
    this.client = client ?? new Busabase({ baseUrl: config.baseUrl, webUrl: config.baseUrl });
  }

  getSnapshot = (): InspectorSnapshot => this.snapshot;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select(ref: BusabaseEntityRef, sessionId: string | null = null): void {
    this.set({
      selected: ref,
      selectedSessionId: sessionId,
      data: ref.raw,
      phase: "loading",
      error: null,
    });
    void this.refresh();
    if (
      this.config.connection.mode === "local" &&
      this.config.liveRefresh.enabled &&
      !this.liveAbort
    )
      this.startLiveRefresh();
  }

  selectPreview(ref: BusabaseEntityRef, sessionId: string | null = null): void {
    this.readAbort?.abort();
    this.set({
      selected: ref,
      selectedSessionId: sessionId,
      data: ref.raw,
      phase: "ready",
      error: null,
    });
  }

  clear(): void {
    this.readAbort?.abort();
    this.set({ selected: null, selectedSessionId: null, data: null, phase: "idle", error: null });
  }

  async refresh(): Promise<void> {
    const selected = this.snapshot.selected;
    if (!selected) return;
    this.readAbort?.abort();
    const abort = new AbortController();
    this.readAbort = abort;
    const version = ++this.requestVersion;
    this.set({ phase: "loading", error: null });
    if (this.config.connection.mode === "remote") {
      this.set({ phase: "error", error: REMOTE_UNSUPPORTED_MESSAGE });
      return;
    }
    try {
      await this.ensureServer();
      const data = await readEntity(this.client, selected, abort.signal);
      if (!abort.signal.aborted && version === this.requestVersion) {
        const normalized = normalizeBusabaseResult(data)[0];
        const canonical =
          selected.metadata.linkPreview ||
          (selected.type === "change-request" && normalized?.type === "change-request")
            ? normalized
            : null;
        this.set({
          selected:
            canonical && canonical.type !== "unknown"
              ? {
                  ...canonical,
                  href: selected.href ?? canonical.href,
                  metadata: { ...canonical.metadata, ...selected.metadata },
                }
              : selected,
          data,
          phase: "ready",
          error: null,
        });
      }
    } catch (error) {
      if (!abort.signal.aborted && version === this.requestVersion)
        this.set({ phase: "error", error: errorMessage(error) });
    }
  }

  async review(verdict: "approved" | "rejected", reason?: string): Promise<boolean> {
    const changeRequestId = requiredChangeRequestId(this.snapshot.selected);
    return this.changeRequestAction("review", () =>
      this.client.changeRequests.review({
        changeRequestId,
        verdict,
        ...(reason ? { reason } : {}),
      }),
    );
  }

  async merge(): Promise<void> {
    const changeRequestId = requiredChangeRequestId(this.snapshot.selected);
    await this.changeRequestAction(
      "merge",
      () => this.client.changeRequests.merge({ changeRequestId }),
      true,
    );
  }

  async close(reason: string): Promise<void> {
    const changeRequestId = requiredChangeRequestId(this.snapshot.selected);
    await this.changeRequestAction("close", () =>
      this.client.changeRequests.close({ changeRequestId, reason }),
    );
  }

  /**
   * Claims a session+ChangeRequest resume key exactly once. Guards the race
   * between the ToolCard quick-approve button and the Inspector panel's
   * approve button firing for the same approval.
   */
  claimResume(sessionId: string, changeRequestId: string): boolean {
    const key = `${sessionId}:${changeRequestId}`;
    if (this.resumedApprovals.has(key)) return false;
    this.resumedApprovals.add(key);
    return true;
  }

  setResumeNotice(notice: ResumeNotice): void {
    this.set({
      resumeNotices: {
        ...this.snapshot.resumeNotices,
        [resumeKey(notice.sessionId, notice.changeRequestId)]: notice,
      },
    });
  }

  clearResumeNotice(sessionId: string, changeRequestId: string): void {
    const key = resumeKey(sessionId, changeRequestId);
    if (!(key in this.snapshot.resumeNotices)) return;
    const resumeNotices = { ...this.snapshot.resumeNotices };
    delete resumeNotices[key];
    this.set({ resumeNotices });
  }

  resumeNotice(sessionId: string, changeRequestId: string): ResumeNotice | undefined {
    return this.snapshot.resumeNotices[resumeKey(sessionId, changeRequestId)];
  }

  nodeUrl(ref = this.snapshot.selected): string | undefined {
    if (!ref) return undefined;
    return (
      resolveResultUrl(this.config.baseUrl, ref.metadata.openUrl) ??
      resolveSearchResultHref(this.config.baseUrl, ref.href, this.config.spaceId)
    );
  }

  changeRequestEmbedUrl(ref = this.snapshot.selected): string | undefined {
    if (!ref || ref.type !== "change-request") return undefined;
    return (
      resolveResultUrl(this.config.baseUrl, ref.metadata.previewUrl) ??
      (ref.metadata.autoPreview === true
        ? resolveManagedLoopbackPreviewUrl(this.config.baseUrl, ref.metadata.previewUrl)
        : undefined)
    );
  }

  airAppUrl(ref = this.snapshot.selected): string | undefined {
    if (!ref || ref.type !== "airapp") return undefined;
    return (
      resolveResultUrl(this.config.baseUrl, ref.metadata.previewUrl) ??
      resolveSearchResultHref(this.config.baseUrl, ref.href, this.config.spaceId)
    );
  }

  embedUrl(ref = this.snapshot.selected): string | undefined {
    if (ref?.type !== "embed") return undefined;
    return ref.metadata.autoPreview === true
      ? resolveHttpUrl(ref.href)
      : resolveResultUrl(this.config.baseUrl, ref.href);
  }

  dispose(): void {
    this.readAbort?.abort();
    this.liveAbort?.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.set({ live: "stopped" });
  }

  private async changeRequestAction(
    action: string,
    request: () => Promise<unknown>,
    readCanonical = false,
  ): Promise<boolean> {
    if (this.snapshot.action) return false;
    if (this.config.connection.mode === "remote") {
      this.set({ error: REMOTE_UNSUPPORTED_MESSAGE, phase: "error" });
      throw new Error(REMOTE_UNSUPPORTED_MESSAGE);
    }
    this.set({ action, error: null });
    try {
      await this.ensureServer();
      const result = await request();
      await this.refresh();
      if (readCanonical && result) {
        const canonical = await readCanonicalResult(this.client, result);
        if (canonical !== undefined) {
          this.set({ data: { changeRequest: this.snapshot.data, canonical } });
          await this.openCanonicalPreview(canonical);
        }
      }
      return true;
    } catch (error) {
      this.set({ error: errorMessage(error), phase: "error" });
      throw error;
    } finally {
      this.set({ action: null });
    }
  }

  private async openCanonicalPreview(canonical: unknown): Promise<void> {
    const nodeId = canonicalNodeId(canonical);
    if (!nodeId) return;
    try {
      const link = await this.createPreview(nodeId);
      const preview = autoPreviewRef(link);
      if (preview) this.selectPreview(preview, this.snapshot.selectedSessionId);
    } catch {
      // A merged canonical result remains successful even when link issuance is unavailable.
    }
  }

  private startLiveRefresh(): void {
    const abort = new AbortController();
    this.liveAbort = abort;
    this.set({ live: "connecting" });
    void this.consumeLive(abort.signal);
  }

  private async consumeLive(signal: AbortSignal): Promise<void> {
    if (this.config.connection.mode === "remote") return;
    let delay = this.config.liveRefresh.reconnectInitialDelayMs;
    while (!signal.aborted) {
      try {
        await this.ensureServer();
        const stream = await (
          this.client.client.live.subscribe as unknown as (
            input?: unknown,
            options?: { signal?: AbortSignal },
          ) => Promise<AsyncIterable<LiveEvent>>
        )(undefined, { signal });
        this.stopPolling();
        this.set({ live: "connected" });
        for await (const event of stream) {
          if (signal.aborted) return;
          if (isRelevantEvent(this.snapshot.selected, event)) await this.refresh();
        }
        throw new Error("Busabase live stream ended");
      } catch {
        if (signal.aborted) return;
        this.startPolling();
        await sleep(delay, signal);
        delay = Math.min(delay * 2, this.config.liveRefresh.reconnectMaxDelayMs);
      }
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.set({ live: "polling" });
    this.pollTimer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible")
        void this.refresh();
    }, this.config.liveRefresh.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private ensureServer(): Promise<void> {
    if (this.serverStart) return this.serverStart;
    const start = this.startServer();
    this.serverStart = start;
    void start
      .finally(() => {
        if (this.serverStart === start) this.serverStart = undefined;
      })
      .catch(() => undefined);
    return start;
  }

  private set(patch: Partial<InspectorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function resumeKey(sessionId: string, changeRequestId: string): string {
  return `${sessionId}:${changeRequestId}`;
}

async function requestServerStart(): Promise<void> {
  const response = await fetch("/busabase-api/server/start", { method: "POST" });
  const body = (await response.json().catch(() => null)) as { reason?: unknown } | null;
  if (!response.ok)
    throw new Error(
      typeof body?.reason === "string"
        ? body.reason
        : `Busabase server startup failed (${String(response.status)})`,
    );
}

interface LiveEvent {
  changeRequestId: string | null;
  baseId: string | null;
  nodeIds: string[];
  recordIds: string[];
  viewIds: string[];
}

export function isRelevantEvent(ref: BusabaseEntityRef | null, event: LiveEvent): boolean {
  if (!ref) return false;
  return Boolean(
    (ref.changeRequestId && event.changeRequestId === ref.changeRequestId) ||
      (ref.baseId && event.baseId === ref.baseId) ||
      (ref.nodeId && event.nodeIds.includes(ref.nodeId)) ||
      (ref.id &&
        (event.nodeIds.includes(ref.id) ||
          event.recordIds.includes(ref.id) ||
          event.viewIds.includes(ref.id))),
  );
}

async function readEntity(
  client: Busabase,
  ref: BusabaseEntityRef,
  signal: AbortSignal,
): Promise<unknown> {
  const id = ref.id;
  if (ref.metadata.linkPreview && ref.slug && ref.type !== "embed") {
    const matches = await client.nodes.searchByName({ query: ref.slug, limit: 20 }, {
      signal,
    } as never);
    const exact = matches.find((node) => node.slug === ref.slug && node.type === ref.type);
    if (!exact) throw new Error(`Busabase ${ref.type} not found: ${ref.slug}`);
    return client.nodes.get({ nodeId: exact.id }, { signal } as never);
  }
  if (ref.type === "base" && (id || ref.baseId))
    return client.bases.get({ baseId: id ?? ref.baseId! }, { signal } as never);
  if (ref.type === "record" && id) return client.records.get({ recordId: id }, { signal } as never);
  if (["table", "gallery", "kanban", "calendar", "gantt"].includes(ref.type) && ref.nodeId)
    return client.nodes.get({ nodeId: ref.nodeId }, { signal } as never);
  if (ref.type === "form" && (ref.nodeId || id))
    return client.client.forms.getByNode({ nodeId: ref.nodeId ?? id! }, { signal } as never);
  if (ref.type === "change-request" && (ref.changeRequestId || id)) {
    const changeRequest = await client.changeRequests.get(
      { changeRequestId: ref.changeRequestId ?? id! },
      { signal } as never,
    );
    if (isMergedChangeRequest(changeRequest)) {
      const canonical = await readCanonicalResult(client, changeRequest, signal);
      if (canonical !== undefined) return { changeRequest, canonical };
    }
    return changeRequest;
  }
  if (ref.type === "embed") return ref.raw;
  if ((ref.nodeId || id) && !["field", "operation", "search-result", "unknown"].includes(ref.type))
    return client.nodes.get({ nodeId: ref.nodeId ?? id! }, { signal } as never);
  return ref.raw;
}

function requiredChangeRequestId(ref: BusabaseEntityRef | null): string {
  const id = ref?.changeRequestId ?? (ref?.type === "change-request" ? ref.id : undefined);
  if (!id) throw new Error("No ChangeRequest is selected");
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function readCanonicalResult(
  client: Busabase,
  result: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const records = collectRecords(result);
  const recordId =
    firstDeepString(records, ["mergedRecordId", "recordId"]) ?? firstNestedId(records, "record");
  if (recordId)
    return signal
      ? client.records.get({ recordId }, { signal } as never)
      : client.records.get({ recordId });
  const nodeId =
    firstDeepString(records, ["nodeId", "mergedNodeId"]) ??
    firstDeepArrayString(records, ["mergedNodeIds"]) ??
    firstNestedId(records, "node");
  if (nodeId)
    return signal
      ? client.nodes.get({ nodeId }, { signal } as never)
      : client.nodes.get({ nodeId });
  return undefined;
}

function isMergedChangeRequest(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).status === "merged",
  );
}

function resolveResultUrl(baseUrl: string, url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  let configured: URL;
  let resolved: URL;
  try {
    configured = new URL(baseUrl);
    resolved = new URL(url, configured);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(resolved.protocol)) return undefined;
  if (!isSameBusabaseOrigin(configured, resolved)) return undefined;
  return resolved.toString();
}

function resolveHttpUrl(url: unknown): string | undefined {
  return parsedHttpUrl(url)?.toString();
}

function resolveManagedLoopbackPreviewUrl(baseUrl: string, url: unknown): string | undefined {
  const configured = parsedHttpUrl(baseUrl);
  const candidate = parsedHttpUrl(url);
  if (!configured || !candidate) return undefined;
  if (!isLoopbackHostname(configured.hostname) || !isLoopbackHostname(candidate.hostname))
    return undefined;
  // Managed Busabase uses an allocated loopback port that can differ from the Client default.
  return configured.protocol === candidate.protocol ? candidate.toString() : undefined;
}

function parsedHttpUrl(url: unknown): URL | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const resolved = new URL(url);
    return ["http:", "https:"].includes(resolved.protocol) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isSameBusabaseOrigin(configured: URL, candidate: URL): boolean {
  if (candidate.origin === configured.origin) return true;
  return (
    candidate.protocol === configured.protocol &&
    candidate.port === configured.port &&
    isLoopbackHostname(candidate.hostname) &&
    isLoopbackHostname(configured.hostname)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

/**
 * Real search-result `href`s are dashboard-relative paths (`/inbox/:id`,
 * `/base/:slug[/record]`, `/airapp/:slug`, …) that must resolve under the
 * configured Busabase dashboard — including the Desktop `/dashboard/local`
 * space prefix — not at the bare origin root. Absolute URLs and paths that
 * already carry a `/dashboard` (or `/embed`) root are left untouched.
 */
function resolveSearchResultHref(
  baseUrl: string,
  href: unknown,
  configuredSpaceId: string | null,
): string | undefined {
  if (typeof href !== "string" || !href) return undefined;
  if (!href.startsWith("/") || href.startsWith("//")) return resolveResultUrl(baseUrl, href);
  if (/^\/(dashboard|embed)(\/|$)/.test(href)) return resolveResultUrl(baseUrl, href);
  const spaceId = desktopSpaceId(baseUrl) ?? configuredSpaceId;
  const spacePrefix = spaceId ? `/${spaceId}` : "";
  return resolveResultUrl(baseUrl, `/dashboard${spacePrefix}${href}`);
}

function desktopSpaceId(baseUrl: string): string | null {
  const hostname = new URL(baseUrl).hostname;
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
    ? "local"
    : null;
}

function collectRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(collectRecords);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectRecords)];
}

function firstDeepString(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const record of records)
    for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key];
  return undefined;
}

function firstDeepArrayString(
  records: Record<string, unknown>[],
  keys: string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        const match = value.find(
          (item): item is string => typeof item === "string" && item.length > 0,
        );
        if (match) return match;
      }
    }
  }
  return undefined;
}

function firstNestedId(records: Record<string, unknown>[], key: string): string | undefined {
  for (const record of records) {
    const nested = record[key];
    if (
      nested &&
      typeof nested === "object" &&
      typeof (nested as Record<string, unknown>).id === "string"
    )
      return (nested as Record<string, unknown>).id as string;
  }
  return undefined;
}
