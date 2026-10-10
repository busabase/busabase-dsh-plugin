import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { SlotTestRuntime } from "@deepseek-ai/dsh-client-test-runtime";
import type { ToolResultNode } from "@deepseek-ai/dsh-client-ui-tool/client";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apply, inject } from "./client.js";
import { loadOfficialClientModule } from "./test-support/dsh-browser-modules.js";

type SessionId = Parameters<ISessions["binding"]>[0];
const SESSION = "sidebar-session" as SessionId;
const OTHER = "sidebar-other" as SessionId;
const runtimes: SlotTestRuntime[] = [];
let animationsDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {} },
  });
  animationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (animationsDescriptor)
    Object.defineProperty(Element.prototype, "getAnimations", animationsDescriptor);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
});

async function boot(desktop = false, pluginFirst = false) {
  const acquire = vi.fn(async () => ({ lease: "fake-lease", partition: "fake-partition" }));
  if (desktop)
    vi.stubGlobal("dshDesktop", {
      protocolVersion: 1,
      browser: {
        acquire,
        release: vi.fn(async () => {}),
        onOpenRequested: () => () => {},
      },
    });
  const runtime = await SlotTestRuntime.create();
  runtimes.push(runtime);
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: runtime.panelInfo };
  runtime.ctx.provide("layout", layout as never);
  runtime.ctx.provide("resources", { pin: () => {} } as never);
  runtime.ctx.provide("shortcuts", {
    register: () => () => {},
    catalog: createSnapshotStore([]),
  } as never);
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.ctx.provide("locale", locale);
  runtime.slots.installLocale(locale);
  await runtime.declare({
    rightbar: { kind: "single", scope: "root" },
    "conversation.session.header.corner": { kind: "single", scope: "session" },
    "tool.call.toolview": { kind: "keyed", scope: "session" },
  });
  await runtime.sessions.add({ id: SESSION });
  await runtime.sessions.add({ id: OTHER });
  const reference = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: "mainView" });
  const mountOfficial = async () => {
    const handles = [];
    for (const id of ["ui-sidebar-right", "ui-sidebar-browser"]) {
      const official = loadOfficialClientModule(`@deepseek-ai/dsh-client-${id}/client`);
      handles.push(
        await runtime.mount({
          inject: official.inject as string[],
          apply: official.apply as typeof apply,
        }),
      );
    }
    return handles;
  };
  if (!pluginFirst) await mountOfficial();
  const plugin = await runtime.mount({
    inject,
    apply: (ctx) => apply(ctx, { baseUrl: "https://busabase.com" }),
  });
  const root = runtime.renderSlot("rightbar", { width: 420, viewportWidth: 1440, canShow: true });
  const link = document.createElement("a");
  link.href = "https://busabase.com/embed/emb_test?token=fake-test-token";
  link.textContent = "Session preview";
  document.body.append(link);
  return { runtime, root, link, reference, layout, acquire, plugin, mountOfficial };
}

it("migrates a plugin-first root when official services load, restores fallback on unload, and reloads cleanly (FAKE desktop bridge)", async () => {
  const h = await boot(true, true);
  try {
    fireEvent.click(h.link);
    await waitFor(() => expect(h.root.container.querySelector(".bb-panel iframe")).not.toBeNull());
    const [sidebar, browser] = await h.mountOfficial();
    expect(h.runtime.ctx.sidebarRightTabs.get("busabase-inspector")?.id).toBe(
      "@busabase/dsh-plugin/inspector",
    );
    fireEvent.click(h.link);
    await waitFor(() => expect(h.root.container.querySelector("webview")).not.toBeNull());
    expect(h.acquire).toHaveBeenCalledWith(`session:${SESSION}`);
    expect(h.root.container.querySelector(".bb-panel")).toBeNull();
    act(() => h.runtime.ctx.sidebarRight.openTab("busabase-inspector"));
    await waitFor(() =>
      expect(h.root.view.getByRole("heading", { name: "Session preview" })).toBeDefined(),
    );
    await browser.dispose();
    await sidebar.dispose();
    expect(h.runtime.ctx.get("sidebarRight")).toBeUndefined();
    fireEvent.click(h.link);
    await waitFor(() => expect(h.root.container.querySelector(".bb-panel iframe")).not.toBeNull());
    await h.mountOfficial();
    fireEvent.click(h.link);
    await waitFor(() => expect(h.root.container.querySelector("webview")).not.toBeNull());
    expect(h.root.container.querySelector(".bb-panel")).toBeNull();
    await h.plugin.dispose();
    expect(h.runtime.ctx.sidebarRightTabs.get("busabase-inspector")).toBeUndefined();
    expect(h.root.container.querySelector("webview")).not.toBeNull();
  } finally {
    h.link.remove();
  }
});

it("does not resurrect the root fallback when a plugin with live optional services unloads", async () => {
  const h = await boot();
  try {
    fireEvent.click(h.link);
    await waitFor(() => expect(h.root.container.querySelector(".bb-panel iframe")).not.toBeNull());
    await h.plugin.dispose();
    expect(h.runtime.ctx.sidebarRightTabs.get("busabase-inspector")).toBeUndefined();
    await waitFor(() => expect(h.root.container.querySelector(".bb-panel")).toBeNull());
    expect(h.root.container.querySelector("[data-sidebar-right-open]")).not.toBeNull();
  } finally {
    h.link.remove();
  }
});

it("coexists with the official root and mounts the Browser webview using a FAKE desktop bridge", async () => {
  const h = await boot(true);
  fireEvent.click(h.link);
  await waitFor(() => expect(h.root.container.querySelector("webview")).not.toBeNull());
  expect(h.acquire).toHaveBeenCalledWith(`session:${SESSION}`);
  expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe("browser");
  expect(h.root.container.querySelector(".bb-panel")).toBeNull();
  expect(
    h.root.container
      .querySelector("[data-sidebar-right-open]")
      ?.getAttribute("data-sidebar-right-open"),
  ).toBe("true");
  act(() => h.runtime.ctx.sidebarRight.openTab("busabase-inspector"));
  await waitFor(() =>
    expect(h.root.view.getByRole("heading", { name: "Session preview" })).toBeDefined(),
  );
  expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe("busabase-inspector");
  const closes = h.layout.closeRightbar.mock.calls.length;
  fireEvent.click(h.root.view.getByRole("button", { name: "Close details" }));
  expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe("browser");
  expect(h.layout.closeRightbar).toHaveBeenCalledTimes(closes);
  expect(
    h.root.container.querySelector("webview")?.closest("[hidden], [aria-hidden='true']"),
  ).toBeNull();
  h.link.remove();
});

it("recovers a failed native dispatch in Inspector and retries a deliberate link click", async () => {
  const h = await boot(true);
  vi.spyOn(h.runtime.ctx.sidebarRight, "openTab").mockImplementationOnce(() => {
    throw new Error("fake dispatch failure");
  });
  fireEvent.click(h.link);
  await waitFor(() => expect(h.root.container.querySelector(".bb-panel iframe")).not.toBeNull());
  expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe("busabase-inspector");
  fireEvent.click(h.link);
  await waitFor(() => expect(h.root.container.querySelector("webview")).not.toBeNull());
  expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe("browser");
  h.link.remove();
});

it.each([false, true])(
  "routes a real tool-slot auto preview and deliberate card click (fake Desktop=%s)",
  async (desktop) => {
    const h = await boot(desktop);
    const toolName = "mcp__busabase__node_create";
    const block: ToolResultNode = {
      kind: "tool-result",
      seq: 1,
      time: 1,
      callId: "sidebar-auto",
      callTime: 1,
      call: { name: toolName, argsRaw: "{}" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "emb_auto",
            type: "node",
            typeId: "nod_auto",
            targetName: "Auto preview",
            nodeType: "airapp",
            url: "https://busabase.com/embed/emb_auto?token=fake",
            iframeUrl: "https://busabase.com/embed/emb_auto?token=fake&view=iframe",
            autoPreview: true,
          }),
        },
      ],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    };
    const card = h.runtime.renderSlot(
      "tool.call.toolview",
      {
        phase: "result",
        block,
        callId: block.callId,
        toolName,
        useDisclosure: () => ({ open: false, toggle: () => {} }),
        openFile: () => {},
        loadImage: async () => null,
      },
      { entryKey: toolName, session: h.reference },
    );
    await waitFor(() =>
      expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe(
        desktop ? "browser" : "busabase-inspector",
      ),
    );
    await waitFor(() =>
      expect(
        h.root.container.querySelector(desktop ? "webview" : ".bb-panel iframe"),
      ).not.toBeNull(),
    );
    const before = h.runtime.ctx.sidebarRight.openTabs.getSnapshot().length;
    card.update({
      phase: "result",
      block: { ...block },
      callId: block.callId,
      toolName,
      useDisclosure: () => ({ open: false, toggle: () => {} }),
      openFile: () => {},
      loadImage: async () => null,
    });
    expect(h.runtime.ctx.sidebarRight.openTabs.getSnapshot()).toHaveLength(before);
    fireEvent.click(card.view.getByRole("button", { name: /Auto preview/ }));
    expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe(
      desktop ? "browser" : "busabase-inspector",
    );
    h.link.remove();
  },
);

it("keeps unsupported Web previews sandboxed in Inspector and hides another session's selection", async () => {
  const h = await boot();
  fireEvent.click(h.link);
  await waitFor(() => expect(h.root.container.querySelector(".bb-panel iframe")).not.toBeNull());
  expect(h.runtime.ctx.sidebarRight.active()?.kind).toBe("busabase-inspector");
  expect(h.root.container.querySelector("iframe")?.getAttribute("sandbox")).toContain(
    "allow-scripts",
  );
  let next: ReturnType<typeof h.runtime.sessions.retainFor> | undefined;
  await act(async () => {
    next = h.runtime.sessions.retainFor(h.runtime.ctx, OTHER, { source: "mainView" });
    h.reference.release();
  });
  act(() => h.runtime.ctx.sidebarRight.openTab("busabase-inspector"));
  await waitFor(() =>
    expect(h.root.view.getByRole("heading", { name: "Select a Busabase result" })).toBeDefined(),
  );
  expect(h.root.container.querySelector(".bb-panel iframe")).toBeNull();
  next?.release();
  h.link.remove();
});
