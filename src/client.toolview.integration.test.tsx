// @vitest-environment jsdom

import { SlotTestRuntime } from "@deepseek-ai/dsh-client-test-runtime";
import type { ToolResultNode } from "@deepseek-ai/dsh-client-ui-tool/client";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { apply as applyBusabase, inject as injectBusabase } from "./client.js";

const SPACE_ID = "org_cloud_test";
const result: ToolResultNode = {
  kind: "tool-result",
  seq: 1,
  time: 1000,
  callId: "call-cloud-review",
  call: {
    name: "mcp__busabase__change_requests_get",
    argsRaw: JSON.stringify({ changeRequestId: "crq_cloud_test", targetSpaceId: SPACE_ID }),
  },
  callTime: 900,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        id: "crq_cloud_test",
        type: "change_request",
        name: "PUL-303 Cloud preview acceptance",
        status: "in_review",
      }),
    },
  ],
  isError: false,
  callView: null,
  resultView: null,
  subCalls: [],
};
let sessionRef: ReturnType<SlotTestRuntime["sessions"]["retain"]>;

it("renders a Cloud ChangeRequest through the DSH 0.2 keyed ToolView and reports a denied preview", async () => {
  const runtime = await SlotTestRuntime.create();
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() };
  runtime.ctx.provide("layout", layout);
  runtime.ctx.provide("connection", {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  await runtime.sessions.add({ id: "s1" });
  sessionRef = runtime.sessions.retain("s1");
  await sessionRef.ready;
  await runtime.declare({
    "tool.call.toolview": { kind: "keyed", scope: "session" },
    rightbar: { kind: "single", scope: "root" },
  });
  const busabase = await runtime.mount({
    name: "busabase-cloud-toolview",
    inject: [...injectBusabase],
    apply: (ctx) => applyBusabase(ctx, { baseUrl: "https://busabase.com", spaceId: SPACE_ID }),
  });
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
    { entryKey: result.call.name, session: sessionRef },
  );
  const view = slot.view;
  const card = view.getByRole("button", { name: /PUL-303 Cloud preview acceptance/i });
  fireEvent.click(card);
  expect(layout.openRightbar).toHaveBeenCalledWith(true, false);
  const panel = document.querySelector(".bb-panel") as HTMLElement;
  expect(panel).not.toBeNull();
  await waitFor(() =>
    expect(within(panel).getByText("Could not load the Cloud ChangeRequest preview.")).toBeTruthy(),
  );
  expect(panel.querySelector("iframe")).toBeNull();
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes(`spaceId=${SPACE_ID}`)),
  ).toBe(true);
  await busabase.dispose();
  await runtime.dispose();
  vi.unstubAllGlobals();
});
