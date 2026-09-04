import type { Busabase } from "busabase-sdk";
import { describe, expect, it, vi } from "vitest";
import { BusabaseInspectorStore, isRelevantEvent } from "./client-store.js";
import { resolveConfig } from "./config.js";
import type { BusabaseEntityRef } from "./normalize.js";

const event = { changeRequestId: null, baseId: null, nodeIds: [], recordIds: [], viewIds: [] };
const changeRequest = (status = "in_review") =>
  ({
    type: "change-request",
    id: "cr_1",
    changeRequestId: "cr_1",
    title: "Change request",
    status,
    metadata: {},
    raw: { id: "cr_1", status },
  }) satisfies BusabaseEntityRef;

function fakeClient() {
  return {
    bases: { get: vi.fn() },
    records: { get: vi.fn() },
    nodes: { get: vi.fn(), searchByName: vi.fn() },
    changeRequests: { get: vi.fn(), review: vi.fn(), merge: vi.fn(), close: vi.fn() },
    embedLinks: { create: vi.fn() },
    client: { forms: { getByNode: vi.fn() }, live: { subscribe: vi.fn() } },
  } as unknown as Busabase;
}

function createStore(
  live = false,
  client = fakeClient(),
  startServer = vi.fn().mockResolvedValue(undefined),
  createPreview?: (nodeId: string) => Promise<unknown>,
): BusabaseInspectorStore {
  return new BusabaseInspectorStore(
    resolveConfig({
      liveRefresh: {
        enabled: live,
        pollIntervalMs: 5_000,
        reconnectInitialDelayMs: 250,
        reconnectMaxDelayMs: 1_000,
      },
    }),
    client,
    startServer,
    createPreview,
  );
}

function createRemoteStore(client = fakeClient()): BusabaseInspectorStore {
  return new BusabaseInspectorStore(resolveConfig({ baseUrl: "https://busabase.example" }), client);
}

describe("live event filtering", () => {
  it("refetches only selected entity dependencies", () => {
    const ref = {
      type: "record",
      id: "rec_1",
      baseId: "bse_1",
      title: "Record",
      metadata: {},
      raw: {},
    } satisfies BusabaseEntityRef;
    expect(isRelevantEvent(ref, { ...event, recordIds: ["rec_1"] })).toBe(true);
    expect(isRelevantEvent(ref, { ...event, baseId: "bse_1" })).toBe(true);
    expect(isRelevantEvent(ref, { ...event, recordIds: ["rec_2"] })).toBe(false);
  });
});

describe("chat continuation notices", () => {
  it("keeps failures isolated by session and ChangeRequest", () => {
    const store = createStore();
    store.setResumeNotice({
      sessionId: "session_a",
      changeRequestId: "crqa",
      message: "A failed",
    });
    store.setResumeNotice({
      sessionId: "session_b",
      changeRequestId: "crqb",
      message: "B failed",
    });

    store.clearResumeNotice("session_b", "crqb");

    expect(store.resumeNotice("session_a", "crqa")?.message).toBe("A failed");
    expect(store.resumeNotice("session_b", "crqb")).toBeUndefined();
  });
});

describe("ChangeRequest actions", () => {
  it("starts Busabase before submitting an approval", async () => {
    let finishStart!: () => void;
    const startServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const store = createStore(false, fakeClient(), startServer);
    store.selectPreview(changeRequest());
    vi.mocked(store.client.changeRequests.review).mockResolvedValue({
      id: "cr_1",
      status: "approved",
    } as never);
    vi.spyOn(store, "refresh").mockResolvedValue();
    const review = store.review("approved");
    expect(startServer).toHaveBeenCalledOnce();
    expect(store.client.changeRequests.review).not.toHaveBeenCalled();
    finishStart();
    await review;
    expect(store.client.changeRequests.review).toHaveBeenCalledOnce();
  });

  it("shares one server startup across concurrent refreshes", async () => {
    let finishStart!: () => void;
    const startServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const store = createStore(false, fakeClient(), startServer);
    store.selectPreview(changeRequest());
    vi.mocked(store.client.changeRequests.get).mockResolvedValue({
      id: "cr_1",
      status: "in_review",
    } as never);
    const first = store.refresh();
    const second = store.refresh();
    expect(startServer).toHaveBeenCalledOnce();
    finishStart();
    await Promise.all([first, second]);
  });

  it("refreshes the selected ChangeRequest with its proposed node name", async () => {
    const store = createStore();
    vi.mocked(store.client.changeRequests.get).mockResolvedValue({
      id: "cr_1",
      status: "merged",
      operations: [],
      primaryOperation: {
        headCommit: {
          message: "Create base CRM",
          payload: { kind: "create", nodeType: "base", name: "CRM" },
        },
      },
    } as never);
    store.select(changeRequest());
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({
        phase: "ready",
        selected: { title: "CRM", status: "merged" },
      }),
    );
  });

  it("surfaces server startup failures before sending a mutation", async () => {
    const store = createStore(
      false,
      fakeClient(),
      vi.fn().mockRejectedValue(new Error("Busabase failed to start")),
    );
    store.selectPreview(changeRequest());
    await expect(store.review("approved")).rejects.toThrow("Busabase failed to start");
    expect(store.client.changeRequests.review).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      phase: "error",
      error: "Busabase failed to start",
    });
  });

  it.each([
    ["approved", undefined, { changeRequestId: "cr_1", verdict: "approved" }],
    [
      "rejected",
      "Needs revision",
      { changeRequestId: "cr_1", verdict: "rejected", reason: "Needs revision" },
    ],
  ] as const)(
    "submits a %s review through the SDK and reads the ChangeRequest back",
    async (verdict, reason, input) => {
      const store = createStore();
      vi.mocked(store.client.changeRequests.review).mockResolvedValue({
        id: "cr_1",
        status: verdict,
      } as never);
      const refresh = vi.spyOn(store, "refresh").mockResolvedValue();
      store.select(changeRequest());
      await store.review(verdict, reason);
      expect(store.client.changeRequests.review).toHaveBeenCalledWith(input);
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it("closes separately with a required reason", async () => {
    const store = createStore();
    vi.mocked(store.client.changeRequests.close).mockResolvedValue({
      id: "cr_1",
      status: "abandoned",
    } as never);
    vi.spyOn(store, "refresh").mockResolvedValue();
    store.select(changeRequest());
    await store.close("Superseded");
    expect(store.client.changeRequests.close).toHaveBeenCalledWith({
      changeRequestId: "cr_1",
      reason: "Superseded",
    });
  });

  it("prevents duplicate action requests while one is pending", async () => {
    const store = createStore();
    let finish!: (value: unknown) => void;
    vi.mocked(store.client.changeRequests.review).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
    );
    vi.spyOn(store, "refresh").mockResolvedValue();
    store.select(changeRequest());
    const first = store.review("approved");
    const second = store.review("approved");
    await expect(second).resolves.toBe(false);
    await vi.waitFor(() => expect(store.client.changeRequests.review).toHaveBeenCalledTimes(1));
    finish({ id: "cr_1", status: "approved" });
    await expect(first).resolves.toBe(true);
  });

  it("surfaces conflict and stale-request responses", async () => {
    const store = createStore();
    vi.mocked(store.client.changeRequests.review).mockRejectedValue(
      new Error("409 stale ChangeRequest"),
    );
    vi.spyOn(store, "refresh").mockResolvedValue();
    store.select(changeRequest());
    await expect(store.review("approved")).rejects.toThrow("409 stale ChangeRequest");
    expect(store.getSnapshot()).toMatchObject({
      phase: "error",
      error: "409 stale ChangeRequest",
      action: null,
    });
  });

  it("reads the canonical record after merge", async () => {
    const store = createStore();
    vi.mocked(store.client.changeRequests.merge).mockResolvedValue({
      changeRequest: { id: "cr_1", status: "merged", mergeSummary: { mergedRecordId: "rec_9" } },
      record: null,
      view: null,
    } as never);
    vi.spyOn(store, "refresh").mockResolvedValue();
    vi.mocked(store.client.records.get).mockResolvedValue({
      recordId: "rec_9",
      fields: { name: "Merged" },
    } as never);
    store.select(changeRequest("approved"));
    await store.merge();
    expect(store.client.changeRequests.merge).toHaveBeenCalledWith({ changeRequestId: "cr_1" });
    expect(store.client.records.get).toHaveBeenCalledWith({ recordId: "rec_9" });
    expect(store.getSnapshot().data).toMatchObject({ canonical: { recordId: "rec_9" } });
  });

  it("creates and selects an embed preview for the canonical Node after human merge", async () => {
    const client = fakeClient();
    vi.mocked(client.changeRequests.merge).mockResolvedValue({
      changeRequest: {
        id: "cr_airapp",
        status: "merged",
        mergeSummary: { mergedNodeIds: ["nod_airapp"] },
      },
    } as never);
    vi.mocked(client.nodes.get).mockResolvedValue({
      type: "airapp",
      node: { id: "nod_airapp", type: "airapp", name: "Sales Console" },
    } as never);
    const createPreview = vi.fn().mockResolvedValue({
      id: "emb_airapp",
      type: "node",
      typeId: "nod_airapp",
      targetName: "Sales Console",
      nodeType: "airapp",
      url: "http://localhost:15419/embed/emb_airapp?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_airapp?token=secret&view=iframe",
      autoPreview: true,
    });
    const store = createStore(false, client, vi.fn().mockResolvedValue(undefined), createPreview);
    vi.spyOn(store, "refresh").mockResolvedValue();
    store.selectPreview(changeRequest("approved"), "session_1");

    await store.merge();

    expect(createPreview).toHaveBeenCalledWith("nod_airapp");
    expect(store.getSnapshot()).toMatchObject({
      selected: {
        type: "embed",
        id: "emb_airapp",
        href: "http://localhost:15419/embed/emb_airapp?token=secret&view=iframe",
      },
      selectedSessionId: "session_1",
      phase: "ready",
    });
  });

  it("keeps a successful merge when canonical preview issuance fails", async () => {
    const client = fakeClient();
    vi.mocked(client.changeRequests.merge).mockResolvedValue({
      changeRequest: {
        id: "cr_airapp",
        status: "merged",
        mergeSummary: { mergedNodeIds: ["nod_airapp"] },
      },
    } as never);
    vi.mocked(client.nodes.get).mockResolvedValue({
      type: "airapp",
      node: { id: "nod_airapp", type: "airapp", name: "Sales Console" },
    } as never);
    vi.mocked(client.embedLinks.create).mockRejectedValue(new Error("manage unavailable"));
    const store = createStore(false, client);
    vi.spyOn(store, "refresh").mockResolvedValue();
    store.selectPreview(changeRequest("approved"));

    await expect(store.merge()).resolves.toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({
      selected: { type: "change-request", id: "cr_1" },
      data: { canonical: { type: "airapp" } },
      phase: "ready",
      error: null,
    });
  });

  it("reads a canonical AirApp when a manually merged ChangeRequest refreshes", async () => {
    const client = fakeClient();
    vi.mocked(client.changeRequests.get).mockResolvedValue({
      id: "cr_airapp",
      status: "merged",
      mergeSummary: { mergedNodeIds: ["nod_airapp"] },
      operations: [{ nodeId: null, operation: "node_create", status: "merged" }],
    } as never);
    vi.mocked(client.nodes.get).mockResolvedValue({
      type: "airapp",
      node: { id: "nod_airapp", type: "airapp", slug: "sales-console", name: "Sales Console" },
      files: [],
    } as never);
    const store = createStore(false, client);
    store.select({
      type: "change-request",
      id: "cr_airapp",
      changeRequestId: "cr_airapp",
      title: "Create Sales Console",
      status: "merged",
      metadata: {},
      raw: {},
    });
    await vi.waitFor(() =>
      expect(store.getSnapshot().data).toMatchObject({
        changeRequest: { id: "cr_airapp", status: "merged" },
        canonical: { type: "airapp", node: { id: "nod_airapp", slug: "sales-console" } },
      }),
    );
    expect(client.nodes.get).toHaveBeenCalledWith(
      { nodeId: "nod_airapp" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("Node URLs", () => {
  it("returns undefined for direct Base and record refs without a server-supplied URL", () => {
    const store = createStore();
    expect(
      store.nodeUrl({
        type: "base",
        id: "bse_1",
        slug: "customers",
        title: "Customers",
        metadata: {},
        raw: {},
      }),
    ).toBeUndefined();
    expect(
      store.nodeUrl({
        type: "record",
        id: "rec_1",
        title: "Customer",
        metadata: {},
        raw: {},
      }),
    ).toBeUndefined();
  });

  it("rejects foreign-origin, protocol-relative, non-http(s), and malformed result hrefs", () => {
    const store = createStore();
    const ref = {
      type: "base",
      id: "bse_1",
      slug: "customers",
      title: "Customers",
      metadata: {},
      raw: {},
    } satisfies BusabaseEntityRef;
    for (const href of [
      "https://evil.example/base/customers",
      "//evil.example/base/customers",
      "javascript:alert(1)",
      "http://[",
    ]) {
      expect(store.nodeUrl({ ...ref, href })).toBeUndefined();
    }
  });

  it("accepts an equivalent localhost embed returned for a configured IPv4 loopback server", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "http://127.0.0.1:15419" }),
      fakeClient(),
    );
    expect(
      store.embedUrl({
        type: "embed",
        id: "emb_1",
        title: "Preview",
        href: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
        metadata: {},
        raw: {},
      }),
    ).toBe("http://localhost:15419/embed/emb_1?token=secret&view=iframe");
  });

  it("still rejects loopback URLs with a different scheme or port", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "http://127.0.0.1:15419" }),
      fakeClient(),
    );
    for (const href of [
      "http://localhost:15420/embed/emb_1?token=secret",
      "https://localhost:15419/embed/emb_1?token=secret",
    ]) {
      expect(
        store.embedUrl({
          type: "embed",
          id: "emb_1",
          title: "Preview",
          href,
          metadata: {},
          raw: {},
        }),
      ).toBeUndefined();
    }
  });

  it("accepts a dynamic-origin preview only when the trusted Host marked it automatic", () => {
    const store = createStore();
    const ref = {
      type: "embed",
      id: "emb_dynamic",
      title: "Preview",
      href: "http://127.0.0.1:40393/embed/emb_dynamic?token=secret&view=iframe",
      metadata: {},
      raw: {},
    } satisfies BusabaseEntityRef;
    expect(store.embedUrl(ref)).toBeUndefined();
    expect(store.embedUrl({ ...ref, metadata: { autoPreview: true } })).toBe(ref.href);
    expect(
      store.embedUrl({ ...ref, href: "javascript:alert(1)", metadata: { autoPreview: true } }),
    ).toBeUndefined();
  });

  it("accepts a Cloud MCP embed link only when it matches the configured Cloud origin", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "https://busabase.example" }),
      fakeClient(),
    );
    const ref = {
      type: "embed",
      id: "emb_cloud",
      title: "Cloud preview",
      href: "https://busabase.example/embed/emb_cloud?token=secret&view=iframe",
      metadata: { openUrl: "https://busabase.example/embed/emb_cloud?token=secret" },
      raw: {},
    } satisfies BusabaseEntityRef;
    expect(store.embedUrl(ref)).toBe(ref.href);
  });

  it("rejects a foreign-origin embed link from a Cloud MCP result even when marked automatic", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "https://busabase.example" }),
      fakeClient(),
    );
    const ref = {
      type: "embed",
      id: "emb_cloud",
      title: "Cloud preview",
      href: "https://attacker.example/embed/emb_cloud?token=secret&view=iframe",
      metadata: { autoPreview: true },
      raw: {},
    } satisfies BusabaseEntityRef;
    expect(store.embedUrl(ref)).toBeUndefined();
  });

  it("rejects a javascript: embed link from a Cloud MCP result even when marked automatic", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "https://busabase.example" }),
      fakeClient(),
    );
    const ref = {
      type: "embed",
      id: "emb_cloud",
      title: "Cloud preview",
      href: "javascript:alert(1)",
      metadata: { autoPreview: true },
      raw: {},
    } satisfies BusabaseEntityRef;
    expect(store.embedUrl(ref)).toBeUndefined();
  });
});

describe("ChangeRequest URLs", () => {
  it("returns undefined for a direct ChangeRequest ref without a server-supplied URL", () => {
    const store = createStore();
    expect(store.nodeUrl(changeRequest())).toBeUndefined();
    expect(store.changeRequestEmbedUrl(changeRequest())).toBeUndefined();
  });

  it("prefers the openUrl/previewUrl supplied by the MCP result", () => {
    const store = createStore();
    const ref = changeRequest();
    ref.metadata = {
      openUrl: "http://localhost:15419/dashboard/local/inbox/cr_1",
      previewUrl: "http://localhost:15419/embed/change-request/cr_1",
    };
    expect(store.nodeUrl(ref)).toBe("http://localhost:15419/dashboard/local/inbox/cr_1");
    expect(store.changeRequestEmbedUrl(ref)).toBe(
      "http://localhost:15419/embed/change-request/cr_1",
    );
  });

  it("resolves a relative result link against the configured Busabase origin", () => {
    const store = createStore();
    const ref = changeRequest();
    ref.metadata = { openUrl: "/dashboard/local/inbox/cr_1" };
    expect(store.nodeUrl(ref)).toBe("http://localhost:15419/dashboard/local/inbox/cr_1");
  });

  it("resolves a real search-result href under the configured dashboard, including the Desktop /local space", () => {
    const store = createStore();
    const ref = changeRequest();
    ref.href = "/inbox/cr_1";
    ref.metadata = {};
    expect(store.nodeUrl(ref)).toBe("http://localhost:15419/dashboard/local/inbox/cr_1");
  });

  it("resolves a root-host Cloud search href under its configured space", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "https://busabase.example", spaceId: "org_1" }),
      fakeClient(),
    );
    const ref = changeRequest();
    ref.href = "/inbox/cr_1";
    expect(store.nodeUrl(ref)).toBe("https://busabase.example/dashboard/org_1/inbox/cr_1");
  });

  it("recognizes bracketed IPv6 loopback as the Desktop local space", () => {
    const store = new BusabaseInspectorStore(
      resolveConfig({ baseUrl: "http://[::1]:15419" }),
      fakeClient(),
    );
    const ref = changeRequest();
    ref.href = "/inbox/cr_1";
    expect(store.nodeUrl(ref)).toBe("http://[::1]:15419/dashboard/local/inbox/cr_1");
  });

  it("ignores an empty, foreign-origin, or non-http(s) openUrl and returns undefined without a usable href", () => {
    const store = createStore();
    expect(store.nodeUrl({ ...changeRequest(), metadata: { openUrl: "" } })).toBeUndefined();
    expect(
      store.nodeUrl({
        ...changeRequest(),
        metadata: { openUrl: "https://evil.example/inbox/cr_1" },
      }),
    ).toBeUndefined();
    expect(
      store.nodeUrl({
        ...changeRequest(),
        metadata: { openUrl: "javascript:alert(1)" },
      }),
    ).toBeUndefined();
  });

  it("ignores a malformed or foreign-origin previewUrl and returns undefined", () => {
    const store = createStore();
    for (const previewUrl of ["https://evil.example/embed/change-request/cr_1", "http://["]) {
      expect(
        store.changeRequestEmbedUrl({
          ...changeRequest(),
          metadata: { previewUrl },
        }),
      ).toBeUndefined();
    }
  });

  it("accepts a dynamic ChangeRequest capability only when the trusted Host marked it automatic", () => {
    const store = createStore();
    const ref = {
      ...changeRequest(),
      metadata: {
        previewUrl: "http://127.0.0.1:40393/embed/emb_cr?token=secret&view=iframe",
      },
    } satisfies BusabaseEntityRef;
    expect(store.changeRequestEmbedUrl(ref)).toBeUndefined();
    expect(
      store.changeRequestEmbedUrl({
        ...ref,
        metadata: { ...ref.metadata, autoPreview: true },
      }),
    ).toBe(ref.metadata.previewUrl);
    expect(
      store.changeRequestEmbedUrl({
        ...ref,
        metadata: { previewUrl: "javascript:alert(1)", autoPreview: true },
      }),
    ).toBeUndefined();
    expect(
      store.changeRequestEmbedUrl({
        ...ref,
        metadata: {
          previewUrl: "https://attacker.example/embed/emb_cr?token=secret",
          autoPreview: true,
        },
      }),
    ).toBeUndefined();
  });
});

describe("AirApp URLs", () => {
  it("returns undefined for a direct AirApp ref without a server-supplied URL or href", () => {
    const store = createStore();
    expect(
      store.airAppUrl({
        type: "airapp",
        id: "nod_airapp",
        slug: "sales-console",
        title: "Sales Console",
        metadata: {},
        raw: {},
      }),
    ).toBeUndefined();
  });

  it("resolves a real search-result href for a Base, record, and AirApp under the configured dashboard", () => {
    const store = createStore();
    expect(
      store.nodeUrl({
        type: "base",
        id: "bse_1",
        slug: "customers",
        title: "Customers",
        href: "/base/customers",
        metadata: {},
        raw: {},
      }),
    ).toBe("http://localhost:15419/dashboard/local/base/customers");
    expect(
      store.nodeUrl({
        type: "record",
        id: "rec_1",
        title: "Record",
        href: "/base/customers/rec_1",
        metadata: {},
        raw: {},
      }),
    ).toBe("http://localhost:15419/dashboard/local/base/customers/rec_1");
    expect(
      store.airAppUrl({
        type: "airapp",
        id: "nod_airapp",
        slug: "sales-console",
        title: "Sales Console",
        href: "/airapp/sales-console",
        metadata: {},
        raw: {},
      }),
    ).toBe("http://localhost:15419/dashboard/local/airapp/sales-console");
  });

  it("ignores a foreign-origin AirApp previewUrl and falls through to a valid href", () => {
    const store = createStore();
    expect(
      store.airAppUrl({
        type: "airapp",
        id: "nod_airapp",
        slug: "sales-console",
        title: "Sales Console",
        href: "/airapp/sales-console",
        metadata: { previewUrl: "https://evil.example/airapp/sales-console" },
        raw: {},
      }),
    ).toBe("http://localhost:15419/dashboard/local/airapp/sales-console");
  });

  it("returns undefined for a foreign-origin AirApp previewUrl with no href to fall back to", () => {
    const store = createStore();
    expect(
      store.airAppUrl({
        type: "airapp",
        id: "nod_airapp",
        slug: "sales-console",
        title: "Sales Console",
        metadata: { previewUrl: "https://evil.example/airapp/sales-console" },
        raw: {},
      }),
    ).toBeUndefined();
  });

  it("resolves an AirApp dashboard link by slug and preserves its fullscreen preview", async () => {
    const client = fakeClient();
    vi.mocked(client.nodes.searchByName).mockResolvedValue([
      {
        id: "nod_airapp",
        type: "airapp",
        slug: "sales-console",
        name: "Sales Console",
        path: "/airapp/sales-console",
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    ] as never);
    vi.mocked(client.nodes.get).mockResolvedValue({
      id: "nod_airapp",
      type: "airapp",
      slug: "sales-console",
      name: "Sales Console",
      description: "Live app",
      metadata: { version: "0.1.0" },
    } as never);
    const store = createStore(false, client);
    store.select({
      type: "airapp",
      slug: "sales-console",
      title: "Open Sales Console",
      href: "http://localhost:15419/dashboard/local/airapp/sales-console?fullscreen=1",
      metadata: {
        linkPreview: true,
        openUrl: "http://localhost:15419/dashboard/local/airapp/sales-console",
        previewUrl: "http://localhost:15419/dashboard/local/airapp/sales-console?fullscreen=1",
      },
      raw: {},
    });

    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({
        phase: "ready",
        selected: { id: "nod_airapp", title: "Sales Console", slug: "sales-console" },
      }),
    );
    expect(client.nodes.searchByName).toHaveBeenCalledWith(
      { query: "sales-console", limit: 20 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.nodes.get).toHaveBeenCalledWith(
      { nodeId: "nod_airapp" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(store.airAppUrl()).toBe(
      "http://localhost:15419/dashboard/local/airapp/sales-console?fullscreen=1",
    );
    expect(store.nodeUrl()).toBe("http://localhost:15419/dashboard/local/airapp/sales-console");
  });
});

describe("request lifecycle", () => {
  it("cancels stale entity reads when selection changes", async () => {
    const store = createStore();
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    vi.mocked(store.client.records.get)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }) as never,
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }) as never,
      );
    store.select({ type: "record", id: "rec_1", title: "First", metadata: {}, raw: {} });
    store.select({ type: "record", id: "rec_2", title: "Second", metadata: {}, raw: {} });
    await vi.waitFor(() => expect(resolveSecond).toBeTypeOf("function"));
    resolveSecond({ recordId: "rec_2" });
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({ phase: "ready", data: { recordId: "rec_2" } }),
    );
    resolveFirst({ recordId: "rec_1" });
    await Promise.resolve();
    expect(store.getSnapshot().data).toEqual({ recordId: "rec_2" });
  });

  it("falls back to bounded visible polling when live subscribe fails", async () => {
    vi.useFakeTimers();
    const store = createStore(true);
    vi.mocked(store.client.client.live.subscribe).mockRejectedValue(new Error("offline") as never);
    const refresh = vi.spyOn(store, "refresh").mockResolvedValue();
    store.select({ type: "unknown", title: "Unknown", metadata: {}, raw: {} });
    await vi.waitFor(() => expect(store.getSnapshot().live).toBe("polling"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    store.dispose();
    vi.useRealTimers();
  });
});

describe("remote (Cloud) mode never falls back to unauthenticated browser requests", () => {
  it("does not fetch or read when selecting an entity", async () => {
    const client = fakeClient();
    const store = createRemoteStore(client);
    store.select(changeRequest());
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toMatchObject({ phase: "error", error: expect.any(String) }),
    );
    expect(client.changeRequests.get).not.toHaveBeenCalled();
    expect(client.nodes.get).not.toHaveBeenCalled();
    expect(client.records.get).not.toHaveBeenCalled();
  });

  it("rejects review, merge, and close without calling the SDK client", async () => {
    const client = fakeClient();
    const store = createRemoteStore(client);
    store.selectPreview(changeRequest());
    await expect(store.review("approved")).rejects.toThrow(/local-only/);
    await expect(store.merge()).rejects.toThrow(/local-only/);
    await expect(store.close("reason")).rejects.toThrow(/local-only/);
    expect(client.changeRequests.review).not.toHaveBeenCalled();
    expect(client.changeRequests.merge).not.toHaveBeenCalled();
    expect(client.changeRequests.close).not.toHaveBeenCalled();
  });

  it("never starts a live subscription even when liveRefresh is enabled", () => {
    const client = fakeClient();
    const store = new BusabaseInspectorStore(
      resolveConfig({
        baseUrl: "https://busabase.example",
        liveRefresh: { enabled: true },
      }),
      client,
    );
    store.select(changeRequest());
    expect(store.getSnapshot().live).toBe("stopped");
    expect(client.client.live.subscribe).not.toHaveBeenCalled();
    store.dispose();
  });

  it("still resolves canonical Cloud links without any network call", () => {
    const store = createRemoteStore();
    const ref = changeRequest();
    ref.metadata = { openUrl: "https://busabase.example/dashboard/org_1/inbox/cr_1" };
    expect(store.nodeUrl(ref)).toBe("https://busabase.example/dashboard/org_1/inbox/cr_1");
  });
});
