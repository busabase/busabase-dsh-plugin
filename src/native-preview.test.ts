// @vitest-environment node

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeChangeRequestPreview } from "./native-preview.js";

interface FakeTabRegistry {
  get: (kind: string) => unknown;
}

interface FakeSidebarRight {
  mounted: { getSnapshot: () => string | undefined };
  openTab: (kind: string, options: { params: { url: string } }) => void;
}

function fakeCtx(options: {
  sidebarRight?: FakeSidebarRight;
  sidebarRightTabs?: FakeTabRegistry;
  omitGet?: boolean;
  workspaces?: unknown;
}): Context {
  const services: Record<string, unknown> = {
    sidebarRight: options.sidebarRight
      ? {
          isExpanded: () => true,
          toggleExpanded: vi.fn(),
          ...options.sidebarRight,
        }
      : undefined,
    sidebarRightTabs: options.sidebarRightTabs,
    workspaces: options.workspaces ?? {},
  };
  if (options.omitGet) return {} as Context;
  return { get: (name: string) => services[name] } as unknown as Context;
}

function available(sessionId = "s1"): {
  ctx: Context;
  openTab: ReturnType<typeof vi.fn>;
} {
  const openTab = vi.fn();
  const ctx = fakeCtx({
    sidebarRight: { mounted: { getSnapshot: () => sessionId }, openTab },
    sidebarRightTabs: {
      get: (kind) =>
        kind === "browser" ? { id: "@deepseek-ai/dsh-client-ui-sidebar-browser" } : undefined,
    },
  });
  return { ctx, openTab };
}

describe("NativeChangeRequestPreview", () => {
  beforeEach(() =>
    vi.stubGlobal("dshDesktop", { protocolVersion: 1, browser: { acquire: vi.fn() } }),
  );
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    undefined,
    { protocolVersion: 2, browser: { acquire: vi.fn() } },
    { protocolVersion: 1 },
  ])("matches the official protocol-v1 Desktop browser selection (%j)", (bridge) => {
    vi.stubGlobal("dshDesktop", bridge);
    const { ctx, openTab } = available();
    expect(
      new NativeChangeRequestPreview().open(ctx, {
        sessionId: "s1",
        spaceId: "org1",
        changeRequestId: "crq1",
        url: "https://busabase.com/embed/crq1",
      }),
    ).toBe("unavailable");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("lets the official browser wait for workspaces, but requires its official provider", () => {
    const { ctx, openTab } = available();
    const get = ctx.get.bind(ctx);
    const input = {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/crq1",
    };
    const missingWorkspaces = {
      get: (name: string) => (name === "workspaces" ? undefined : get(name as never)),
    } as unknown as Context;
    expect(new NativeChangeRequestPreview().open(missingWorkspaces, input)).toBe("opened");
    const replacement = fakeCtx({
      sidebarRight: { mounted: { getSnapshot: () => "s1" }, openTab },
      sidebarRightTabs: { get: () => ({ id: "third-party" }) },
    });
    expect(new NativeChangeRequestPreview().open(replacement, input)).toBe("unavailable");
    expect(openTab).toHaveBeenCalledOnce();
  });

  it("deduplicates token refreshes but separates Spaces and sessions without storing tokens", () => {
    let session = "s1";
    const { ctx, openTab } = available();
    const sidebar = ctx.get("sidebarRight");
    if (!sidebar) throw new Error("Test sidebar unavailable");
    sidebar.mounted.getSnapshot = () => session as never;
    const preview = new NativeChangeRequestPreview();
    const input = {
      sessionId: session,
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/crq1?token=first",
    };
    expect(preview.open(ctx, input)).toBe("opened");
    expect(
      preview.open(ctx, { ...input, url: "https://busabase.com/embed/crq1?token=refreshed" }),
    ).toBe("opened");
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...(preview as unknown as { opened: Set<string> }).opened])).not.toMatch(
      /token|first|refreshed/,
    );
    preview.open(ctx, { ...input, spaceId: "org2" });
    session = "s2";
    preview.open(ctx, { ...input, sessionId: session });
    expect(openTab).toHaveBeenCalledTimes(3);
  });

  it("contains service lookup errors and retries failed opens without a reservation", () => {
    const input = {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/crq1",
    };
    const preview = new NativeChangeRequestPreview();
    expect(
      preview.open(
        {
          get: () => {
            throw new Error("unloaded");
          },
        } as unknown as Context,
        input,
      ),
    ).toBe("error");
    const { ctx, openTab } = available();
    openTab.mockImplementationOnce(() => {
      throw new Error("not registered");
    });
    preview.forget(input.sessionId, input.spaceId, input.changeRequestId);
    expect(preview.open(ctx, input)).toBe("error");
    expect(preview.open(ctx, input)).toBe("opened");
    expect(openTab).toHaveBeenCalledTimes(2);
    preview.forget(input.sessionId, input.spaceId, input.changeRequestId);
    expect(preview.open(ctx, input)).toBe("opened");
    expect(openTab).toHaveBeenCalledTimes(3);
  });
  it("opens the browser tab when the host has registered sidebarRight and the browser kind", () => {
    const { ctx, openTab } = available();
    const preview = new NativeChangeRequestPreview();
    const result = preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("opened");
    expect(openTab).toHaveBeenCalledWith("browser", {
      params: { url: "https://busabase.com/embed/change-request/crq1?token=t" },
    });
  });

  it("falls back to unavailable when ctx.get does not exist", () => {
    const preview = new NativeChangeRequestPreview();
    const result = preview.open(fakeCtx({ omitGet: true }), {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("unavailable");
  });

  it("falls back to unavailable when sidebarRight is not provided by the host", () => {
    const ctx = fakeCtx({
      sidebarRightTabs: { get: () => ({ id: "@deepseek-ai/dsh-client-ui-sidebar-browser" }) },
    });
    const preview = new NativeChangeRequestPreview();
    const result = preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("unavailable");
  });

  it("falls back to unavailable when the browser kind is not registered", () => {
    const openTab = vi.fn();
    const ctx = fakeCtx({
      sidebarRight: { mounted: { getSnapshot: () => "s1" }, openTab },
      sidebarRightTabs: { get: () => undefined },
    });
    const preview = new NativeChangeRequestPreview();
    const result = preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("unavailable");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("falls back to unavailable when no session id is known", () => {
    const { ctx, openTab } = available();
    const preview = new NativeChangeRequestPreview();
    const result = preview.open(ctx, {
      sessionId: null,
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("unavailable");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("reports stale and does not open when the originating session is no longer on screen", () => {
    const { ctx, openTab } = available("s2");
    const preview = new NativeChangeRequestPreview();
    const result = preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("stale");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("reports error and does not throw when openTab throws", () => {
    const openTab = vi.fn(() => {
      throw new Error("host wiring mistake");
    });
    const ctx = fakeCtx({
      sidebarRight: { mounted: { getSnapshot: () => "s1" }, openTab },
      sidebarRightTabs: { get: () => ({ id: "@deepseek-ai/dsh-client-ui-sidebar-browser" }) },
    });
    const preview = new NativeChangeRequestPreview();
    expect(() =>
      preview.open(ctx, {
        sessionId: "s1",
        spaceId: "org1",
        changeRequestId: "crq1",
        url: "https://busabase.com/embed/change-request/crq1?token=t",
      }),
    ).not.toThrow();
    const result = preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    expect(result).toBe("error");
  });

  it("deduplicates repeated opens for the same session, ChangeRequest, and url", () => {
    const { ctx, openTab } = available();
    const preview = new NativeChangeRequestPreview();
    const input = {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    };
    expect(preview.open(ctx, input)).toBe("opened");
    expect(preview.open(ctx, input)).toBe("opened");
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("allows a deliberate reopen after forget", () => {
    const { ctx, openTab } = available();
    const preview = new NativeChangeRequestPreview();
    const input = {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    };
    expect(preview.open(ctx, input)).toBe("opened");
    preview.forget(input.sessionId, input.spaceId, input.changeRequestId);
    expect(preview.open(ctx, input)).toBe("opened");
    expect(openTab).toHaveBeenCalledTimes(2);
  });

  it("expands a collapsed official sidebar even for a deduplicated dispatch", () => {
    const { ctx, openTab } = available();
    const sidebar = ctx.get("sidebarRight");
    if (!sidebar) throw new Error("Test sidebar unavailable");
    sidebar.isExpanded = vi.fn(() => false);
    sidebar.toggleExpanded = vi.fn();
    const preview = new NativeChangeRequestPreview();
    const input = {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/dashboard/org1/inbox/crq1",
    };
    expect(preview.open(ctx, input)).toBe("opened");
    expect(preview.open(ctx, input)).toBe("opened");
    expect(openTab).toHaveBeenCalledOnce();
    expect(sidebar.toggleExpanded).toHaveBeenCalledOnce();
  });

  it("opens independent tabs for different ChangeRequests in the same session", () => {
    const { ctx, openTab } = available();
    const preview = new NativeChangeRequestPreview();
    preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq1",
      url: "https://busabase.com/embed/change-request/crq1?token=t",
    });
    preview.open(ctx, {
      sessionId: "s1",
      spaceId: "org1",
      changeRequestId: "crq2",
      url: "https://busabase.com/embed/change-request/crq2?token=t",
    });
    expect(openTab).toHaveBeenCalledTimes(2);
  });
});
