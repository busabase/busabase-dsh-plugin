// @vitest-environment jsdom

import type { ISession, ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { SlotTestRuntime } from "@deepseek-ai/dsh-client-test-runtime";
import type {
  ChatConversationViewNode,
  ChatSnapshot,
  ConversationNode,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { RunningToolCall, ToolResultNode } from "@deepseek-ai/dsh-client-ui-tool/client";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apply as applyBusabase, inject as injectBusabase } from "./client.js";
import { BUSABASE_HOST_CONFIG_GLOBAL, type BusabaseClientConfig } from "./client-config.js";
import { BusabaseInspectorStore } from "./client-store.js";

type SessionId = Parameters<ISessions["binding"]>[0];

const SESSION_ID = "s1" as SessionId;
const TOOL_NAME = "mcp__busabase__bases_get";
const CHANGE_REQUEST_TOOL_NAME = "mcp__busabase__change_requests_get";
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const LAYOUT_CHILDREN = {
  "tool.call.toolview": { kind: "keyed", scope: "session" },
  rightbar: { kind: "single", scope: "root" },
} as const;

function renderResult(runtime: SlotTestRuntime, result: ToolResultNode) {
  const session = runtime.sessions.retain(SESSION_ID);
  runtime.renderSlot("rightbar", { width: 400, viewportWidth: 1440 });
  const slot = runtime.renderSlot(
    "tool.call.toolview",
    {
      phase: "result",
      block: result,
      callId: result.callId,
      toolName: result.call.name,
      useDisclosure: () => ({ open: false, toggle: () => {} }),
      openFile: () => {},
      loadImage: async () => null,
    },
    { entryKey: result.call.name, session },
  );
  return slot.view;
}

const toolChatSnapshot = (
  settled: readonly ConversationNode[] = [],
  running: readonly RunningToolCall[] = [],
): ChatSnapshot => {
  const roots = [...settled.filter((node) => node.kind === "tool-result"), ...running];
  const nodes: ChatConversationViewNode[] = roots.map((root) => ({
    key: `tool:${root.callId}`,
    kind: "tool-call",
    id: root.callId,
    target: "chat",
    anchorSeq: "kind" in root ? root.seq : Number.MAX_SAFE_INTEGER,
    location: { kind: "session" },
    visibility: "visible",
    data: { root },
  }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const empty: readonly string[] = [];
  return {
    order: nodes.map((node) => node.key),
    nodes: {
      get: (key) => byKey.get(key),
      values: () => nodes,
    },
    locations: {
      getTurn: () => empty,
      getStep: () => empty,
    },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: {
      nodes: settled,
      runningCalls: running,
      partial: null,
      turnTimings: new Map(),
      turnEnds: new Map(),
    },
  };
};

const baseResult = (): ToolResultNode => ({
  kind: "tool-result",
  seq: 3,
  time: 3_000,
  callId: "call-base-crm",
  call: { name: TOOL_NAME, argsRaw: JSON.stringify({ baseId: "bse_crm" }) },
  callTime: 2_500,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        id: "bse_crm",
        baseId: "bse_crm",
        nodeId: "nod_crm",
        type: "base",
        name: "CRM",
        fields: [],
        reviewPolicy: { kind: "single", requiredApprovals: 1 },
      }),
    },
  ],
  isError: false,
  callView: null,
  resultView: null,
  subCalls: [],
});

const changeRequestResult = (): ToolResultNode => ({
  kind: "tool-result",
  seq: 4,
  time: 4_000,
  callId: "call-change-request-quick-review",
  call: {
    name: CHANGE_REQUEST_TOOL_NAME,
    argsRaw: JSON.stringify({ changeRequestId: "crqquick" }),
  },
  callTime: 3_500,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        id: "crqquick",
        changeRequestId: "crqquick",
        type: "change_request",
        name: "Quick proposal",
        status: "in_review",
      }),
    },
  ],
  isError: false,
  callView: null,
  resultView: null,
  subCalls: [],
});

beforeEach(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "bse_crm",
            baseId: "bse_crm",
            nodeId: "nod_crm",
            type: "base",
            name: "CRM",
            fields: [],
            reviewPolicy: { kind: "single", requiredApprovals: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("registers Busabase ToolViews before slot declaration and opens the canonical entity in Details", async () => {
  const runtime = await SlotTestRuntime.create();
  const addEventListener = vi.spyOn(document, "addEventListener");
  const removeEventListener = vi.spyOn(document, "removeEventListener");
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() };

  runtime.ctx.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  runtime.ctx.provide("layout", layout);

  const result = baseResult();
  await runtime.sessions.add({
    id: SESSION_ID,
    summary: { title: "Busabase", displayTitle: "Busabase" },
    snapshot: { nodes: [result], chat: toolChatSnapshot([result]) },
    session: {
      loadOlder: vi.fn<ISession["loadOlder"]>(),
      prompt: vi.fn<ISession["prompt"]>(async () => ({ ok: true, value: { accepted: true } })),
    },
  });
  await runtime.declare(LAYOUT_CHILDREN);
  const busabase = await runtime.mount({
    name: "busabase-test-client",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, { liveRefresh: { enabled: false } }),
  });
  expect(runtime.slots.entries("tool.call.toolview").map((entry) => entry.options.key)).toContain(
    TOOL_NAME,
  );

  const view = renderResult(runtime, result);
  const card = view.getByRole("button", { name: /CRM/i });
  expect(view.queryByText("Tool call")).toBeNull();
  fireEvent.click(card);
  expect(layout.openRightbar).toHaveBeenCalledWith(true, false);

  const details = document.querySelector(".bb-panel");
  expect(details).not.toBeNull();
  expect(within(details as HTMLElement).queryByText("Busabase Inspector")).toBeNull();
  expect(
    within(details as HTMLElement).getByRole("heading", { level: 2, name: "CRM" }),
  ).toBeTruthy();

  const clickRegistration = addEventListener.mock.calls.find(([type]) => type === "click");
  expect(clickRegistration).toBeDefined();
  await busabase.dispose();
  await runtime.flush();
  expect(
    runtime.slots.entries("tool.call.toolview").some((entry) => entry.options.key === TOOL_NAME),
  ).toBe(false);
  expect(removeEventListener).toHaveBeenCalledWith("click", clickRegistration?.[1]);

  await runtime.dispose();
});

it("renders quick ChangeRequest review actions through the real ToolView slot", async () => {
  const runtime = await SlotTestRuntime.create();
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() };
  const sessionPrompt = vi.fn<ISession["prompt"]>(async () => ({
    ok: true,
    value: { accepted: true },
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(BusabaseInspectorStore.prototype, "review").mockResolvedValue(true);

  runtime.ctx.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  runtime.ctx.provide("layout", layout);

  const result = changeRequestResult();
  await runtime.sessions.add({
    id: SESSION_ID,
    summary: { title: "Busabase review", displayTitle: "Busabase review" },
    snapshot: { nodes: [result], chat: toolChatSnapshot([result]) },
    session: {
      loadOlder: vi.fn<ISession["loadOlder"]>(),
      prompt: sessionPrompt,
    },
  });
  await runtime.declare(LAYOUT_CHILDREN);
  const busabase = await runtime.mount({
    name: "busabase-quick-review-test-client",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, { liveRefresh: { enabled: false } }),
  });

  const view = renderResult(runtime, result);
  expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Reject" })).toBeTruthy();
  expect(view.queryByText("Tool call")).toBeNull();
  expect(layout.openRightbar).not.toHaveBeenCalled();

  fireEvent.click(view.getByRole("button", { name: /Quick proposal/i }));
  expect(layout.openRightbar).toHaveBeenCalledWith(true, false);
  const details = document.querySelector(".bb-panel");
  expect(details).not.toBeNull();
  expect(within(details as HTMLElement).queryByText("Busabase Inspector")).toBeNull();
  fireEvent.click(within(details as HTMLElement).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(sessionPrompt).toHaveBeenCalledOnce());
  expect(sessionPrompt).toHaveBeenCalledWith(
    [
      {
        type: "text",
        text: "ChangeRequest was approved.",
      },
    ],
    "queue",
  );

  await busabase.dispose();
  await runtime.flush();
  expect(
    runtime.slots
      .entries("tool.call.toolview")
      .some((entry) => entry.options.key === CHANGE_REQUEST_TOOL_NAME),
  ).toBe(false);
  await runtime.dispose();
});

it("keeps Cloud results link-only without Inspector REST actions or embeds", async () => {
  const runtime = await SlotTestRuntime.create();
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() };

  runtime.ctx.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  runtime.ctx.provide("layout", layout);

  const result = baseResult();
  result.content = [
    {
      type: "text",
      text: JSON.stringify({
        id: "bse_crm",
        baseId: "bse_crm",
        nodeId: "nod_crm",
        type: "base",
        name: "Cloud CRM",
        url: "https://busabase.com/dashboard/org_1/nodes/nod_crm",
      }),
    },
  ];
  await runtime.sessions.add({
    id: SESSION_ID,
    summary: { title: "Busabase Cloud", displayTitle: "Busabase Cloud" },
    snapshot: { nodes: [result], chat: toolChatSnapshot([result]) },
    session: {
      loadOlder: vi.fn<ISession["loadOlder"]>(),
      prompt: vi.fn<ISession["prompt"]>(async () => ({ ok: true, value: { accepted: true } })),
    },
  });
  await runtime.declare(LAYOUT_CHILDREN);
  const busabase = await runtime.mount({
    name: "busabase-cloud-test-client",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, { baseUrl: "https://busabase.com" }),
  });

  const fetchMock = vi.mocked(fetch);
  fetchMock.mockClear();
  const view = renderResult(runtime, result);
  fireEvent.click(view.getByRole("button", { name: /Cloud CRM/i }));
  const details = document.querySelector(".bb-panel");
  expect(details).not.toBeNull();
  const panel = within(details as HTMLElement);
  expect(panel.getByRole("link", { name: "Open in Busabase" }).getAttribute("href")).toBe(
    "https://busabase.com/dashboard/org_1/nodes/nod_crm",
  );
  expect(panel.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(panel.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(details?.querySelector("iframe")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();

  await busabase.dispose();
  await runtime.dispose();
});

it("uses the host-injected Cloud config for a ChangeRequest preview with no manual config", async () => {
  // Reproduces production boot: the client-plugin loader activates client bundles with only
  // `{ name }`, never a `config` (see client-config.ts) — so apply() gets `{}` here, exactly
  // like it does for real, and must still resolve Cloud/remote behavior via the global the
  // host plugin (index.ts) injects into the boot HTML ahead of this bundle's own script.
  const hostConfig: BusabaseClientConfig = {
    baseUrl: "https://busabase.com",
    spaceId: null,
    serverName: "busabase",
    connection: { mode: "remote" },
    server: { manageable: false },
    liveRefresh: {
      enabled: true,
      pollIntervalMs: 30_000,
      reconnectInitialDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
    },
    airAppIframe: { enabled: true },
    baseIframe: { enabled: true },
    changeRequestIframe: { enabled: true },
    confirmations: { review: true, merge: true, close: true },
  };
  vi.stubGlobal(BUSABASE_HOST_CONFIG_GLOBAL, hostConfig);

  const runtime = await SlotTestRuntime.create();
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() };

  runtime.ctx.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  runtime.ctx.provide("layout", layout);

  const result = changeRequestResult();
  result.call = {
    name: "mcp__busabase__embed_links_create",
    argsRaw: JSON.stringify({ type: "change-request", typeId: "crqcloud" }),
  };
  result.content = [
    {
      type: "text",
      text: JSON.stringify({
        id: "emb_cloud",
        type: "change-request",
        typeId: "crqcloud",
        targetName: "Cloud proposal",
        url: "https://busabase.com/dashboard/org_1/inbox/crqcloud",
        iframeUrl: "https://busabase.com/embed/emb_cloud?token=preview-token&view=iframe",
      }),
    },
  ];
  await runtime.sessions.add({
    id: SESSION_ID,
    summary: { title: "Busabase Cloud", displayTitle: "Busabase Cloud" },
    snapshot: { nodes: [result], chat: toolChatSnapshot([result]) },
    session: {
      loadOlder: vi.fn<ISession["loadOlder"]>(),
      prompt: vi.fn<ISession["prompt"]>(async () => ({ ok: true, value: { accepted: true } })),
    },
  });
  await runtime.declare(LAYOUT_CHILDREN);
  const busabase = await runtime.mount({
    name: "busabase-cloud-bridge-test-client",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, {}),
  });

  const fetchMock = vi.mocked(fetch);
  fetchMock.mockClear();
  renderResult(runtime, result);
  await waitFor(() => expect(layout.openRightbar).toHaveBeenCalledWith(true, false));
  const details = document.querySelector(".bb-panel");
  expect(details).not.toBeNull();
  const panel = within(details as HTMLElement);
  expect(panel.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(panel.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(panel.queryByRole("button", { name: "Reject" })).toBeNull();
  expect(details?.querySelector("iframe")?.getAttribute("src")).toBe(
    "https://busabase.com/embed/emb_cloud?token=preview-token&view=iframe",
  );
  fireEvent.click(panel.getByRole("button", { name: "More" }));
  expect(panel.getByRole("menuitem", { name: "Open in Busabase" }).getAttribute("href")).toBe(
    "https://busabase.com/dashboard/org_1/inbox/crqcloud",
  );
  expect(fetchMock).not.toHaveBeenCalled();

  await busabase.dispose();
  await runtime.dispose();
});
