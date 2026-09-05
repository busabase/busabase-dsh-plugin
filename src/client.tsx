import type { Context } from "@deepseek-ai/cordis";
import type { ISessions, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ToolCallOwnerProps, ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { Busabase } from "busabase-sdk";
import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { resolveBusabaseClientConfig } from "./client-config.js";
import { BusabaseInspectorStore } from "./client-store.js";
import type { BusabasePluginConfig } from "./config.js";
import {
  BUILT_IN_NODE_TYPES,
  type BusabaseEntityRef,
  normalizeBusabaseResult,
} from "./normalize.js";
import { isAutoPreviewToolName } from "./preview-link.js";
import styles from "./styles.css";

export const name = "@busabase/dsh-plugin/client";
export const inject = ["slots", "layout", "sessions"];

const RAW_TOOL_NAMES = [
  "activity_list_for_node",
  "activity_list_for_record",
  "activity_list_paged",
  "agent_list_tasks",
  "assets_confirm",
  "assets_create_text_upload_url",
  "assets_create_upload_url",
  "assets_delete",
  "assets_download",
  "assets_edit_content",
  "assets_get",
  "assets_list",
  "assets_put_text",
  "assets_read_text_lines",
  "assets_update_metadata",
  "audit_events_create",
  "audit_events_list",
  "auth_verify",
  "base_field_change_request",
  "bases_create_bulk_change_request",
  "bases_create_change_request",
  "bases_create_field",
  "bases_get",
  "bases_lifecycle_change_request",
  "bases_list",
  "bases_list_views",
  "bases_preview_field_conversion",
  "busabase_guide",
  "change_request_merge",
  "change_request_query",
  "change_request_review",
  "change_requests_close",
  "change_requests_get",
  "change_requests_list_page",
  "comments_create",
  "comments_list",
  "embed_links_create",
  "embed_links_list",
  "embed_links_revoke",
  "forms_create",
  "forms_get_by_node",
  "forms_list",
  "forms_submit",
  "forms_update",
  "grep",
  "list_archived",
  "node_archive",
  "node_create",
  "node_file_read",
  "node_files_change_request",
  "node_files_list",
  "node_get_file_tree",
  "node_list_files_trees",
  "node_permission",
  "node_share",
  "nodes_create_change_request",
  "nodes_get",
  "nodes_get_agent_prompts",
  "nodes_icon_confirm",
  "nodes_icon_create_upload_url",
  "nodes_list",
  "nodes_list_favorites",
  "nodes_move",
  "nodes_purge",
  "nodes_read_lines",
  "nodes_search_by_name",
  "nodes_toggle_favorite",
  "nodes_update_agent_prompts",
  "nodes_update_content",
  "nodes_update_metadata",
  "nodes_update_settings",
  "nodes_update_visibility",
  "operations_revise",
  "record_change_request",
  "record_bulk_update_change_request",
  "record_find_by_field",
  "record_query",
  "records_get",
  "records_group_by",
  "records_list_change_requests",
  "records_list_links",
  "records_list_page",
  "search",
  "system_health",
  "system_meta",
  "templates_list",
  "users_me",
  "view_change_request",
  "webhooks_create",
  "webhooks_delete",
  "webhooks_deliveries",
  "webhooks_get",
  "webhooks_list",
  "webhooks_test_fire",
  "webhooks_update",
] as const;

export function apply(ctx: Context, input: BusabasePluginConfig = {}): void {
  ensureStyles();
  const config = resolveBusabaseClientConfig(input);
  const inspectorClient = config.server.manageable
    ? new Busabase({
        baseUrl: new URL("/busabase-api/proxy", window.location.origin).toString(),
        webUrl: config.baseUrl,
      })
    : undefined;
  const store = new BusabaseInspectorStore(
    config,
    inspectorClient,
    undefined,
    config.server.manageable ? requestNodePreview : undefined,
  );
  ctx.effect(() => () => store.dispose(), "busabase: inspector store");
  ctx.effect(() => {
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.hasAttribute("download")) return;
      const ref = busabaseRefFromLink(target.href, target.textContent, config.baseUrl);
      if (!ref) return;
      if (config.connection.mode === "remote") return;
      event.preventDefault();
      if (ref.type === "embed") store.selectPreview(ref);
      else store.select(ref);
      ctx.layout.openDetails();
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, "busabase: embed link navigation");

  for (const rawName of RAW_TOOL_NAMES) {
    const toolName = `mcp__${config.serverName}__${rawName}`;
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register({ name: "tool.call.toolview", key: toolName }, createToolCard(store, ctx)),
    );
  }

  ctx.slots.register(
    { name: "details", priority: -10 } as never,
    createDetailsPanel(store, ctx) as never,
  );
}

async function requestNodePreview(nodeId: string): Promise<unknown> {
  const response = await fetch(`/busabase-api/previews/nodes/${encodeURIComponent(nodeId)}`, {
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`Busabase preview creation failed (${String(response.status)})`);
  return body;
}

function ensureStyles(): void {
  if (document.getElementById("busabase-dsh-plugin-styles")) return;
  const element = document.createElement("style");
  element.id = "busabase-dsh-plugin-styles";
  element.textContent = styles;
  document.head.append(element);
}

export function extractToolPayload(block: ToolCallOwnerProps["block"]): unknown {
  if (!("content" in block)) {
    try {
      return block.argsRaw ? JSON.parse(block.argsRaw) : {};
    } catch {
      return { arguments: block.argsRaw };
    }
  }
  const texts = block.content.flatMap((part: unknown) => {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
      return [part.text];
    return [];
  });
  const parsed: unknown[] = [];
  for (const text of texts) {
    try {
      parsed.push(JSON.parse(text));
    } catch {
      /* continue */
    }
  }
  if (parsed.length === 1) return parsed[0];
  if (parsed.length > 1) return parsed.flatMap((value) => (Array.isArray(value) ? value : [value]));
  return { content: texts.join("\n"), isError: block.isError };
}

function createToolCard(store: BusabaseInspectorStore, ctx: Context): React.FC<ToolCallViewProps> {
  return function BusabaseToolCard({ block, toolName, sessionId }) {
    const refs = useMemo(() => normalizeBusabaseResult(extractToolPayload(block)), [block]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const preview = isAutoPreviewToolName(toolName, store.config.serverName)
      ? refs.find(
          (ref) =>
            (ref.type === "embed" || ref.type === "change-request") &&
            ref.metadata.autoPreview === true,
        )
      : undefined;
    useEffect(() => {
      if (!preview) return;
      const selected = store.getSnapshot().selected;
      if (
        (preview.type === "embed" && selected?.type === "embed" && selected.id === preview.id) ||
        (preview.type === "change-request" &&
          selected?.type === "change-request" &&
          selected.id === preview.id &&
          selected.metadata.autoPreview === true &&
          selected.metadata.previewUrl === preview.metadata.previewUrl)
      )
        return;
      if (preview.type === "change-request" && store.config.connection.mode === "local")
        store.select(preview, sessionId ?? null);
      else store.selectPreview(preview, sessionId ?? null);
      ctx.layout.openDetails();
    }, [
      preview,
      sessionId,
      store.getSnapshot,
      store.select,
      store.selectPreview,
      store.config.connection.mode,
      ctx.layout.openDetails,
    ]);
    return (
      <div className="bb-card-stack">
        {refs.slice(0, 8).map((ref, index) => {
          const selectedChangeRequest = sameChangeRequest(snapshot.selected, ref)
            ? snapshot.selected
            : null;
          const displayRef = selectedChangeRequest ?? ref;
          const data = selectedChangeRequest ? snapshot.data : ref.raw;
          const status =
            ref.type === "change-request"
              ? changeRequestStatus(data, displayRef.status)
              : ref.status;
          return (
            <div className="bb-card" key={`${ref.type}:${ref.id ?? ref.slug ?? index}`}>
              <button
                type="button"
                className="bb-card-open"
                onClick={() => {
                  if (store.config.connection.mode === "local")
                    store.select(ref, sessionId ?? null);
                  else store.selectPreview(ref, sessionId ?? null);
                  ctx.layout.openDetails();
                }}
              >
                <span className="bb-card-icon">{entityIcon(ref.type)}</span>
                <span className="bb-card-main">
                  <strong>{displayRef.title}</strong>
                  <small>
                    {entityLabel(ref)}
                    {status ? ` · ${status}` : ""}
                  </small>
                </span>
                {ref.type === "change-request" && status !== "merged" ? (
                  <span className="bb-pill">Review</span>
                ) : null}
                <span className="bb-card-action">Details</span>
              </button>
              {ref.type === "change-request" ? (
                <ChangeRequestActions
                  refValue={displayRef}
                  data={data}
                  store={store}
                  ctx={ctx}
                  sessionId={sessionId}
                  compact
                  beforeAction={() => store.selectPreview(displayRef, sessionId ?? null)}
                />
              ) : null}
            </div>
          );
        })}
        <ResumeNotice store={store} sessionId={sessionId} refs={refs} />
        {/*<div className="bb-tool-footer">
          <span>{toolName.replace(/^mcp__[^_]+__/, "")}</span>
          {inspect ? (
            <button type="button" onClick={inspect}>
              Inspect call
            </button>
          ) : null}
        </div>*/}
      </div>
    );
  };
}

function createDetailsPanel(
  store: BusabaseInspectorStore,
  ctx: Context,
): React.FC<PropsRuntime<"details">> {
  return function BusabaseDetailsPanel() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const [fullscreen, setFullscreen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const [changeRequestFrameVersion, setChangeRequestFrameVersion] = useState(0);
    const ref = snapshot.selected;
    const status =
      ref?.type === "change-request" ? changeRequestStatus(snapshot.data, ref.status) : ref?.status;
    const closePanel = () => {
      setFullscreen(false);
      ctx.layout.closeDetails();
    };
    useEffect(() => {
      if (!fullscreen) return;
      const previousOverflow = document.body.style.overflow;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") setFullscreen(false);
      };
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
        document.body.style.overflow = previousOverflow;
      };
    }, [fullscreen]);
    return (
      <aside className={`bb-panel${fullscreen ? " bb-panel-fullscreen" : ""}`}>
        <header className="bb-panel-header">
          <div className="bb-panel-heading">
            <h2 title={ref?.title}>{ref?.title ?? "Select a Busabase result"}</h2>
            {status ? <span className="bb-panel-status">{status}</span> : null}
          </div>
          <div className="bb-panel-header-controls">
            {ref?.type === "change-request" ? (
              <ChangeRequestActions
                refValue={ref}
                data={snapshot.data}
                store={store}
                ctx={ctx}
                sessionId={(snapshot.selectedSessionId as SessionId | null) ?? undefined}
                variant="primary"
              />
            ) : null}
            {ref ? (
              <div className="bb-more">
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  onClick={() => setMoreOpen((value) => !value)}
                >
                  More
                </button>
                {moreOpen ? (
                  <div className="bb-more-menu" role="menu">
                    {ref.type !== "embed" && store.config.connection.mode === "local" ? (
                      <button
                        type="button"
                        role="menuitem"
                        disabled={snapshot.phase === "loading"}
                        onClick={() => {
                          setMoreOpen(false);
                          void store.refresh();
                        }}
                      >
                        Refresh
                      </button>
                    ) : null}
                    {ref.type === "change-request" ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          setChangeRequestFrameVersion((value) => value + 1);
                        }}
                      >
                        Reload preview
                      </button>
                    ) : null}
                    {(() => {
                      const nodeUrl = store.nodeUrl();
                      return nodeUrl ? (
                        <a
                          href={nodeUrl}
                          role="menuitem"
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setMoreOpen(false)}
                        >
                          Open in Busabase
                        </a>
                      ) : null;
                    })()}
                    {ref.type === "change-request" ? (
                      <ChangeRequestActions
                        refValue={ref}
                        data={snapshot.data}
                        store={store}
                        ctx={ctx}
                        sessionId={(snapshot.selectedSessionId as SessionId | null) ?? undefined}
                        variant="secondary"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={() => setFullscreen((value) => !value)}
            >
              <FullscreenIcon restored={fullscreen} />
            </button>
            <button
              type="button"
              aria-label="Close details"
              onPointerDown={closePanel}
              onClick={closePanel}
            >
              ×
            </button>
          </div>
        </header>
        {!ref ? (
          <div className="bb-empty">Open a Busabase card to inspect live canonical data.</div>
        ) : (
          <>
            {ref.type !== "change-request" && ref.type !== "embed" && store.nodeUrl() ? (
              <div className="bb-panel-toolbar">
                <a
                  className="bb-button"
                  href={store.nodeUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in Busabase
                </a>
              </div>
            ) : null}
            {snapshot.error ? <div className="bb-error">{snapshot.error}</div> : null}
            <InspectorBody
              refValue={ref}
              data={snapshot.data}
              store={store}
              changeRequestFrameVersion={changeRequestFrameVersion}
            />
          </>
        )}
      </aside>
    );
  };
}

function InspectorBody({
  refValue,
  data,
  store,
  changeRequestFrameVersion = 0,
}: {
  refValue: BusabaseEntityRef;
  data: unknown;
  store: BusabaseInspectorStore;
  changeRequestFrameVersion?: number;
}) {
  if (refValue.type === "embed") return <EmbedInspector refValue={refValue} store={store} />;
  if (refValue.type === "base")
    return <BaseInspector refValue={refValue} data={data} store={store} />;
  if (refValue.type === "airapp")
    return <AirAppInspector refValue={refValue} data={data} store={store} />;
  if (refValue.type === "change-request")
    return (
      <ChangeRequestInspector
        refValue={refValue}
        data={data}
        store={store}
        frameVersion={changeRequestFrameVersion}
      />
    );
  const record = asRecord(data);
  const rich = findRichField(record);
  return (
    <div className="bb-inspector">
      <Summary refValue={refValue} data={record} />
      {rich?.kind === "html" ? (
        <iframe
          className="bb-article-frame"
          sandbox=""
          srcDoc={rich.value}
          title={`${refValue.title} article`}
        />
      ) : null}
      {rich?.kind === "markdown" ? (
        <article className="bb-article">
          <pre>{rich.value}</pre>
        </article>
      ) : null}
      <JsonTree value={data} />
    </div>
  );
}

function EmbedInspector({
  refValue,
  store,
}: {
  refValue: BusabaseEntityRef;
  store: BusabaseInspectorStore;
}) {
  const url = store.embedUrl(refValue);
  return (
    <div className="bb-inspector bb-embed-inspector">
      {url ? (
        <iframe
          className="bb-airapp-frame bb-embed-frame"
          src={url}
          sandbox="allow-scripts allow-forms allow-same-origin"
          referrerPolicy="no-referrer"
          title={`${refValue.title} embed`}
        />
      ) : (
        <div className="bb-empty">This embed link is unavailable.</div>
      )}
    </div>
  );
}

function BaseInspector({
  refValue,
  data,
  store,
}: {
  refValue: BusabaseEntityRef;
  data: unknown;
  store: BusabaseInspectorStore;
}) {
  const url = store.nodeUrl(refValue);
  const [frameVersion, setFrameVersion] = useState(0);
  return (
    <div className="bb-inspector">
      <Summary refValue={refValue} data={asRecord(data)} />
      {url && store.config.baseIframe.enabled && store.config.connection.mode === "local" ? (
        <>
          <div className="bb-node-actions">
            <button type="button" onClick={() => setFrameVersion((value) => value + 1)}>
              Reload Base
            </button>
          </div>
          <iframe
            key={frameVersion}
            className="bb-base-frame"
            src={url}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            title={`${refValue.title} Base`}
          />
        </>
      ) : (
        <div className="bb-empty">
          {store.config.connection.mode === "remote"
            ? "Open this Base in Busabase Cloud."
            : "Base embedding is disabled."}
        </div>
      )}
      <JsonTree value={data} />
    </div>
  );
}

function AirAppInspector({
  refValue,
  data,
  store,
}: {
  refValue: BusabaseEntityRef;
  data: unknown;
  store: BusabaseInspectorStore;
}) {
  const url = store.airAppUrl(refValue);
  const [frameVersion, setFrameVersion] = useState(0);
  return (
    <div className="bb-inspector">
      <Summary refValue={refValue} data={asRecord(data)} />
      {url && store.config.airAppIframe.enabled && store.config.connection.mode === "local" ? (
        <>
          <div className="bb-node-actions">
            <button type="button" onClick={() => setFrameVersion((value) => value + 1)}>
              Reload AirApp
            </button>
          </div>
          <iframe
            key={frameVersion}
            className="bb-airapp-frame"
            src={url}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            title={`${refValue.title} AirApp`}
          />
        </>
      ) : (
        <div className="bb-empty">
          {store.config.connection.mode === "remote"
            ? "Open this AirApp in Busabase Cloud."
            : "AirApp iframe is disabled."}
        </div>
      )}
      <JsonTree value={data} />
    </div>
  );
}

function ChangeRequestInspector({
  refValue,
  data,
  store,
  frameVersion,
}: {
  refValue: BusabaseEntityRef;
  data: unknown;
  store: BusabaseInspectorStore;
  frameVersion: number;
}) {
  const value = asRecord(data);
  const previewUrl = store.changeRequestEmbedUrl(refValue);
  return (
    <div className="bb-inspector bb-change-request-inspector">
      {previewUrl && store.config.changeRequestIframe.enabled ? (
        <section className="bb-change-request-preview">
          <iframe
            key={frameVersion}
            className="bb-change-request-frame"
            src={previewUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            title={`${refValue.title} Change Request`}
          />
        </section>
      ) : (
        <div className="bb-empty">
          Rich Change Request preview is unavailable for this Busabase instance.
        </div>
      )}
      {value.canonical !== undefined ? (
        <CanonicalResultCard value={value.canonical} store={store} />
      ) : null}
    </div>
  );
}

/** User-visible status only. LLM continuation instructions live in BUSABASE_SYSTEM_PROMPT. */
function resumePromptText(): string {
  return "ChangeRequest was approved.";
}

function isSafeChangeRequestId(value: string): boolean {
  return value.length <= 128 && /^crq[a-z0-9]+$/.test(value);
}

async function resumeApprovedChangeRequest(
  ctx: Context,
  store: BusabaseInspectorStore,
  sessionId: SessionId | null | undefined,
  changeRequestId: string | undefined,
): Promise<void> {
  if (!sessionId || !changeRequestId) return;
  if (!store.claimResume(sessionId, changeRequestId)) return;
  if (!isSafeChangeRequestId(changeRequestId)) {
    store.setResumeNotice({
      sessionId,
      changeRequestId,
      message:
        'The ChangeRequest was approved, but its identifier is unsafe to send to chat. Send "continue" to resume manually.',
    });
    return;
  }
  store.clearResumeNotice(sessionId, changeRequestId);
  try {
    // This client bundle runs with dsh-client-runtime's ISessions service. The
    // The shared type graph also declares the server SessionStore on Context, so
    // narrow explicitly at this browser-only boundary.
    const sessions = ctx.sessions as unknown as ISessions;
    const session = sessions.binding(sessionId)?.session;
    if (!session) {
      store.setResumeNotice({
        sessionId,
        changeRequestId,
        message: `ChangeRequest ${changeRequestId} was approved, but the original chat is no longer available. Send "continue" to resume manually.`,
      });
      return;
    }
    const result = await session.prompt([{ type: "text", text: resumePromptText() }], "queue");
    if (!result.ok)
      store.setResumeNotice({
        sessionId,
        changeRequestId,
        message: `ChangeRequest ${changeRequestId} was approved, but the chat could not resume: ${result.error.message}. Send "continue" to retry manually.`,
      });
  } catch (error) {
    store.setResumeNotice({
      sessionId,
      changeRequestId,
      message: `ChangeRequest ${changeRequestId} was approved, but the chat could not resume: ${errorMessage(error)}. Send "continue" to retry manually.`,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ChangeRequestActions({
  refValue,
  data,
  store,
  ctx,
  sessionId,
  compact = false,
  beforeAction,
  variant = "all",
}: {
  refValue: BusabaseEntityRef;
  data: unknown;
  store: BusabaseInspectorStore;
  ctx: Context;
  sessionId?: SessionId;
  compact?: boolean;
  beforeAction?: () => void;
  variant?: "all" | "primary" | "secondary";
}) {
  if (store.config.connection.mode === "remote") return null;
  const status = changeRequestStatus(data, refValue.status);
  const busy = store.getSnapshot().action;
  const confirmAction = async (
    required: boolean,
    message: string,
    action: () => Promise<unknown>,
  ) => {
    if (!required || window.confirm(message)) {
      beforeAction?.();
      await action();
    }
  };
  return (
    <div className={`bb-review-actions${compact ? " bb-review-actions-compact" : ""}`}>
      {["in_review", "changes_requested"].includes(status ?? "") ? (
        <>
          {variant !== "secondary" ? (
            <button
              type="button"
              disabled={!!busy}
              className="primary"
              onClick={() =>
                void confirmAction(
                  store.config.confirmations.review,
                  `Approve only ChangeRequest ${refValue.changeRequestId ?? refValue.id}?`,
                  async () => {
                    const reviewed = await store.review("approved");
                    if (!reviewed) return;
                    void resumeApprovedChangeRequest(
                      ctx,
                      store,
                      sessionId,
                      refValue.changeRequestId ?? refValue.id,
                    );
                  },
                )
              }
            >
              Approve
            </button>
          ) : null}
          {variant !== "primary" ? (
            <button
              type="button"
              role={variant === "secondary" ? "menuitem" : undefined}
              disabled={!!busy}
              className="danger"
              onClick={() => {
                const reason = window.prompt("Reason for rejection (optional)") ?? undefined;
                if (reason !== undefined)
                  void confirmAction(
                    store.config.confirmations.review,
                    `Reject only ChangeRequest ${refValue.changeRequestId ?? refValue.id}?`,
                    () => store.review("rejected", reason),
                  );
              }}
            >
              Reject
            </button>
          ) : null}
        </>
      ) : null}
      {status === "approved" && variant !== "secondary" ? (
        <button
          type="button"
          disabled={!!busy}
          className="primary"
          onClick={() =>
            void confirmAction(
              store.config.confirmations.merge,
              `Merge only approved ChangeRequest ${refValue.changeRequestId ?? refValue.id}? This changes canonical data.`,
              () => store.merge(),
            )
          }
        >
          Merge
        </button>
      ) : null}
      {!compact && variant !== "primary" && !["merged", "abandoned"].includes(status ?? "") ? (
        <button
          type="button"
          role={variant === "secondary" ? "menuitem" : undefined}
          disabled={!!busy}
          onClick={() => {
            const reason = window.prompt("Reason for closing this ChangeRequest");
            if (reason)
              void confirmAction(
                store.config.confirmations.close,
                `Close only ChangeRequest ${refValue.changeRequestId ?? refValue.id}?`,
                () => store.close(reason),
              );
          }}
        >
          Close
        </button>
      ) : null}
    </div>
  );
}

function ResumeNotice({
  store,
  sessionId,
  refs,
}: {
  store: BusabaseInspectorStore;
  sessionId?: SessionId;
  refs: BusabaseEntityRef[];
}) {
  if (!sessionId) return null;
  const ref = refs.find((candidate) => {
    const changeRequestId = candidate.changeRequestId ?? candidate.id;
    return changeRequestId && store.resumeNotice(sessionId, changeRequestId);
  });
  const changeRequestId = ref?.changeRequestId ?? ref?.id;
  const notice = changeRequestId ? store.resumeNotice(sessionId, changeRequestId) : undefined;
  if (!notice) return null;
  return (
    <div className="bb-error" role="alert">
      {notice.message}
      <button
        type="button"
        onClick={() => store.clearResumeNotice(notice.sessionId, notice.changeRequestId)}
      >
        Dismiss
      </button>
    </div>
  );
}

function changeRequestStatus(data: unknown, fallback?: string): string | undefined {
  const value = asRecord(data);
  const refreshedChangeRequest = asRecord(value.changeRequest);
  const changeRequest =
    Object.keys(refreshedChangeRequest).length > 0 ? refreshedChangeRequest : value;
  return typeof changeRequest.status === "string" ? changeRequest.status : fallback;
}

function sameChangeRequest(
  selected: BusabaseEntityRef | null,
  candidate: BusabaseEntityRef,
): boolean {
  if (selected?.type !== "change-request" || candidate.type !== "change-request") return false;
  const selectedId = selected.changeRequestId ?? selected.id;
  const candidateId = candidate.changeRequestId ?? candidate.id;
  return !!selectedId && selectedId === candidateId;
}

function FullscreenIcon({ restored }: { restored: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d={
          restored
            ? "M6 3v3H3m10 0h-3V3m0 10v-3h3M3 10h3v3"
            : "M6 3H3v3m10 0V3h-3m0 10h3v-3M3 10v3h3"
        }
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CanonicalResultCard({ value, store }: { value: unknown; store: BusabaseInspectorStore }) {
  const refs = normalizeBusabaseResult(value);
  return (
    <section className="bb-canonical-result">
      <span className="bb-eyebrow">Canonical result</span>
      <div className="bb-card-stack">
        {refs.slice(0, 4).map((ref, index) => (
          <button
            type="button"
            className="bb-card"
            key={`${ref.type}:${ref.id ?? ref.slug ?? index}`}
            onClick={() => store.select(ref)}
          >
            <span className="bb-card-icon">{entityIcon(ref.type)}</span>
            <span className="bb-card-main">
              <strong>{ref.title}</strong>
              <small>
                {entityLabel(ref)}
                {ref.status ? ` · ${ref.status}` : ""}
              </small>
            </span>
            <span className="bb-card-action">Details</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Summary({
  refValue,
  data,
}: {
  refValue: BusabaseEntityRef;
  data: Record<string, unknown>;
}) {
  const internalKeys = new Set(["linkPreview", "openUrl", "previewUrl"]);
  return (
    <section className="bb-summary">
      <div className="bb-summary-type">
        {entityIcon(refValue.type)} {refValue.type}
      </div>
      <h3>{refValue.title}</h3>
      <dl>
        {Object.entries({
          id: refValue.id,
          slug: refValue.slug,
          status: data.status ?? refValue.status,
          baseId: refValue.baseId,
          ...refValue.metadata,
        })
          .filter(([key, value]) => !internalKeys.has(key) && primitive(value))
          .slice(0, 10)
          .map(([key, value]) => (
            <React.Fragment key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </React.Fragment>
          ))}
      </dl>
    </section>
  );
}

function JsonTree({ value }: { value: unknown }) {
  return (
    <details className="bb-json">
      <summary>Raw Busabase data</summary>
      <pre>{safeStringify(value)}</pre>
    </details>
  );
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function primitive(value: unknown): boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function entityLabel(ref: BusabaseEntityRef): string {
  return [ref.type, ref.slug ?? ref.id].filter(Boolean).join(" · ");
}
function entityIcon(type: string): string {
  return (
    (
      {
        base: "▦",
        record: "◫",
        form: "✎",
        airapp: "◈",
        embed: "◈",
        doc: "▤",
        html: "▤",
        file: "⌑",
        drive: "▣",
        skill: "✦",
        folder: "▱",
        whiteboard: "◇",
        workflow: "⇄",
        "change-request": "△",
        table: "▦",
        gallery: "▧",
        kanban: "▥",
        calendar: "□",
        gantt: "▰",
      } as Record<string, string>
    )[type] ?? "◆"
  );
}

export function busabaseRefFromLink(
  href: string,
  label: string | null,
  baseUrl: string,
): BusabaseEntityRef | null {
  let url: URL;
  let configuredOrigin: string;
  try {
    url = new URL(href);
    configuredOrigin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  if (url.origin !== configuredOrigin) return null;
  const title = label?.trim() || "Busabase node";
  const changeRequestEmbedMatch = url.pathname.match(/^\/embed\/change-request\/([^/]+)\/?$/);
  if (changeRequestEmbedMatch) {
    const id = decodeURIComponent(changeRequestEmbedMatch[1]);
    const openUrl = `${configuredOrigin}/dashboard${isDesktopOrigin(configuredOrigin) ? "/local" : ""}/inbox/${encodeURIComponent(id)}`;
    return {
      type: "change-request",
      id,
      changeRequestId: id,
      title,
      href: url.toString(),
      metadata: { linkPreview: true, openUrl, previewUrl: url.toString() },
      raw: { type: "change-request", id },
    };
  }
  const embedMatch = url.pathname.match(/^\/embed\/([^/]+)\/?$/);
  if (embedMatch && url.searchParams.get("token")) {
    const openUrl = new URL(url);
    openUrl.searchParams.delete("view");
    const iframeUrl = new URL(url);
    iframeUrl.searchParams.set("view", "iframe");
    const id = decodeURIComponent(embedMatch[1]);
    return {
      type: "embed",
      id,
      title,
      href: iframeUrl.toString(),
      metadata: { openUrl: openUrl.toString() },
      raw: { type: "embed", id },
    };
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== "dashboard") return null;
  const candidateTypeIndex = BUILT_IN_NODE_TYPES.includes(segments[1] as never) ? 1 : 2;
  const type = segments[candidateTypeIndex];
  const slug = segments[candidateTypeIndex + 1];
  if (!BUILT_IN_NODE_TYPES.includes(type as never) || !slug) return null;
  const openUrl = new URL(url);
  openUrl.searchParams.delete("fullscreen");
  const previewUrl = new URL(openUrl);
  if (type === "airapp") previewUrl.searchParams.set("fullscreen", "1");
  return {
    type: type as BusabaseEntityRef["type"],
    slug,
    title,
    href: previewUrl.toString(),
    metadata: { linkPreview: true, openUrl: openUrl.toString(), previewUrl: previewUrl.toString() },
    raw: { type, slug },
  };
}
function isDesktopOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function findRichField(
  record: Record<string, unknown>,
): { kind: "html" | "markdown"; value: string } | null {
  const sources = [
    record.fields,
    asRecord(record.headCommit).data,
    asRecord(record.headCommit).fields,
    record,
  ];
  for (const source of sources)
    if (source && typeof source === "object")
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        if (/html|body/i.test(key) && /<\w+[\s>]/.test(value)) return { kind: "html", value };
        if (/markdown|body|article|content|description/i.test(key) && value.length > 120)
          return { kind: "markdown", value };
      }
  return null;
}
