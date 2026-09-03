// @vitest-environment jsdom

import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type {
  ChatConversationViewNode,
  ChatSnapshot,
  ConversationNode,
  ISession,
  RunningToolCall,
  SessionId,
  ToolResultNode,
} from "@deepseek-ai/dsh-client-runtime/client";
import { SlotTestRuntime, stubSettingsScope } from "@deepseek-ai/dsh-client-test-runtime";
import {
  apply as applyConversation,
  inject as injectConversation,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import { apply as applyTool, inject as injectTool } from "@deepseek-ai/dsh-client-ui-tool/client";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apply as applyBusabase, inject as injectBusabase } from "./client.js";
import { BusabaseInspectorStore } from "./client-store.js";

const SESSION_ID = "s1" as SessionId;
const TOOL_NAME = "mcp__busabase__bases_get";
const CHANGE_REQUEST_TOOL_NAME = "mcp__busabase__change_requests_get";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type AppRootProps = PropsRenderSlots<"conversation" | "details">;

function AppRoot({ renderSlot }: AppRootProps) {
  return (
    <>
      {renderSlot("conversation", {})}
      {renderSlot("details", {})}
    </>
  );
}

const LAYOUT_CHILDREN = {
  conversation: { kind: "single", scope: "session-maybe" },
  details: { kind: "single", scope: "session" },
} as const;

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
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() };

  runtime.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  runtime.provide("remote", { $on: () => () => {} });
  runtime.provide("settingsScope", { bind: () => stubSettingsScope().scope } as never);
  runtime.provide("layout", layout);
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.provide("locale", locale);
  runtime.slots.installLocale(locale);

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
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot);

  const busabase = await runtime.mount({
    name: "busabase-test-client",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, { liveRefresh: { enabled: false } }),
  });
  expect(runtime.slots.entries("tool.call.toolview")).toHaveLength(0);

  await runtime.mount({ inject: [...injectConversation], apply: applyConversation });
  await runtime.mount({ inject: [...injectTool], apply: applyTool });
  expect(runtime.slots.entries("tool.call.toolview").map((entry) => entry.options.key)).toContain(
    TOOL_NAME,
  );

  const view = runtime.renderRoot();
  const card = view.getByRole("button", { name: /CRM/i });
  expect(view.queryByText("Tool call")).toBeNull();
  fireEvent.click(card);
  expect(layout.openDetails).toHaveBeenCalledTimes(1);

  const details = view.container.querySelector(".bb-panel");
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
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() };
  const sessionPrompt = vi.fn<ISession["prompt"]>(async () => ({
    ok: true,
    value: { accepted: true },
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(BusabaseInspectorStore.prototype, "review").mockResolvedValue(true);

  runtime.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  runtime.provide("remote", { $on: () => () => {} });
  runtime.provide("settingsScope", { bind: () => stubSettingsScope().scope } as never);
  runtime.provide("layout", layout);
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.provide("locale", locale);
  runtime.slots.installLocale(locale);

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
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot);

  const busabase = await runtime.mount({
    name: "busabase-quick-review-test-client",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, { liveRefresh: { enabled: false } }),
  });
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation });
  await runtime.mount({ inject: [...injectTool], apply: applyTool });

  const view = runtime.renderRoot();
  expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Reject" })).toBeTruthy();
  expect(view.queryByText("Tool call")).toBeNull();
  expect(layout.openDetails).not.toHaveBeenCalled();

  fireEvent.click(view.getByRole("button", { name: /Quick proposal/i }));
  expect(layout.openDetails).toHaveBeenCalledTimes(1);
  const details = view.container.querySelector(".bb-panel");
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
