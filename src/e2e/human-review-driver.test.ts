import type { Busabase } from "busabase-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  approveAndMergeChangeRequest,
  createAnywhereEmbedLink,
  findPendingChangeRequest,
  readCanonicalAirApp,
  retrieveActiveEmbedLink,
  verifyEmbedUrlResolves,
} from "./human-review-driver.js";

function fakeClient(overrides: Partial<Busabase> = {}): Busabase {
  return {
    changeRequests: {
      list: vi.fn(),
      get: vi.fn(),
      review: vi.fn(),
      merge: vi.fn(),
    },
    fileTrees: {
      readFile: vi.fn(),
    },
    embedLinks: {
      create: vi.fn(),
      list: vi.fn(),
    },
    ...overrides,
  } as unknown as Busabase;
}

describe("findPendingChangeRequest", () => {
  it("returns the matching pending CR", async () => {
    const client = fakeClient({
      changeRequests: {
        list: vi.fn().mockResolvedValue({
          changeRequests: [{ id: "cr_1", nodeId: "node_1", status: "in_review" }],
        }),
        get: vi.fn().mockResolvedValue({
          sourceAttribution: { channel: "mcp" },
          operations: [
            {
              operation: "node_create",
              headCommit: { payload: { nodeType: "airapp", slug: "dsh-e2e-1" } },
            },
          ],
        }),
      } as unknown as Busabase["changeRequests"],
    });
    await expect(
      findPendingChangeRequest(client, { changeRequestId: "cr_1", slug: "dsh-e2e-1" }),
    ).resolves.toEqual({ id: "cr_1", nodeId: "node_1", status: "in_review" });
  });

  it("throws when the CR id is not found", async () => {
    const client = fakeClient({
      changeRequests: {
        list: vi.fn().mockResolvedValue({ changeRequests: [] }),
      } as unknown as Busabase["changeRequests"],
    });
    await expect(
      findPendingChangeRequest(client, { changeRequestId: "cr_missing", slug: "dsh-e2e-1" }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses to act on a CR that is not pending", async () => {
    const client = fakeClient({
      changeRequests: {
        list: vi.fn().mockResolvedValue({
          changeRequests: [{ id: "cr_1", nodeId: "node_1", status: "merged" }],
        }),
      } as unknown as Busabase["changeRequests"],
    });
    await expect(
      findPendingChangeRequest(client, { changeRequestId: "cr_1", slug: "dsh-e2e-1" }),
    ).rejects.toThrow(/not pending/);
  });

  it("refuses a pending CR for a different node or slug", async () => {
    const client = fakeClient({
      changeRequests: {
        list: vi.fn().mockResolvedValue({
          changeRequests: [{ id: "cr_1", nodeId: null, status: "in_review" }],
        }),
        get: vi.fn().mockResolvedValue({
          sourceAttribution: { channel: "mcp" },
          operations: [
            {
              operation: "node_create",
              headCommit: { payload: { nodeType: "doc", slug: "other" } },
            },
          ],
        }),
      } as unknown as Busabase["changeRequests"],
    });

    await expect(
      findPendingChangeRequest(client, { changeRequestId: "cr_1", slug: "dsh-e2e-1" }),
    ).rejects.toThrow(/not the expected AirApp create/);
  });
});

describe("approveAndMergeChangeRequest", () => {
  it("reviews with an approved verdict then merges, returning the merged node id", async () => {
    const review = vi.fn().mockResolvedValue({ results: [{ changeRequestId: "cr_1", ok: true }] });
    const merge = vi.fn().mockResolvedValue({
      results: [
        {
          changeRequestId: "cr_1",
          ok: true,
          changeRequest: { nodeId: null, mergeSummary: { mergedNodeIds: ["node_1"] } },
        },
      ],
    });
    const client = fakeClient({
      changeRequests: { review, merge } as unknown as Busabase["changeRequests"],
    });

    await expect(approveAndMergeChangeRequest(client, "cr_1")).resolves.toEqual({
      nodeId: "node_1",
    });
    expect(review).toHaveBeenCalledWith({ changeRequestIds: ["cr_1"], verdict: "approved" });
    expect(merge).toHaveBeenCalledWith({ changeRequestIds: ["cr_1"] });
  });

  it("throws when the server reports the review failed", async () => {
    const review = vi
      .fn()
      .mockResolvedValue({ results: [{ changeRequestId: "cr_1", ok: false, error: "conflict" }] });
    const merge = vi.fn();
    const client = fakeClient({
      changeRequests: { review, merge } as unknown as Busabase["changeRequests"],
    });

    await expect(approveAndMergeChangeRequest(client, "cr_1")).rejects.toThrow(
      /review of cr_1 failed: conflict/,
    );
    expect(merge).not.toHaveBeenCalled();
  });

  it("throws when the server reports the merge failed", async () => {
    const review = vi.fn().mockResolvedValue({ results: [{ changeRequestId: "cr_1", ok: true }] });
    const merge = vi.fn().mockResolvedValue({
      results: [{ changeRequestId: "cr_1", ok: false, error: "stale base" }],
    });
    const client = fakeClient({
      changeRequests: { review, merge } as unknown as Busabase["changeRequests"],
    });

    await expect(approveAndMergeChangeRequest(client, "cr_1")).rejects.toThrow(
      /merge of cr_1 failed: stale base/,
    );
  });
});

describe("readCanonicalAirApp", () => {
  it("reads package.json from the merged node and reports its shape", async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue({ content: JSON.stringify({ scripts: { dev: "node server.js" } }) });
    const client = fakeClient({ fileTrees: { readFile } as unknown as Busabase["fileTrees"] });

    const result = await readCanonicalAirApp(client, "node_1");
    expect(readFile).toHaveBeenCalledWith({
      nodeId: "node_1",
      type: "airapp",
      filePath: "package.json",
    });
    expect(result.shapeCheck.ok).toBe(true);
  });
});

describe("createAnywhereEmbedLink", () => {
  it("requests an anywhere frame policy with no allowed-origin restriction", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "emb_1",
      url: "https://busabase.example/embed/1",
      iframeUrl: "https://busabase.example/embed/1?iframe=1",
    });
    const client = fakeClient({ embedLinks: { create } as unknown as Busabase["embedLinks"] });

    const result = await createAnywhereEmbedLink(client, "node_1");
    expect(create).toHaveBeenCalledWith({
      type: "node",
      typeId: "node_1",
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
    });
    expect(result).toEqual({
      id: "emb_1",
      url: "https://busabase.example/embed/1",
      iframeUrl: "https://busabase.example/embed/1?iframe=1",
    });
  });

  it("retrieves the active link by canonical node id", async () => {
    const list = vi
      .fn()
      .mockResolvedValue([{ id: "emb_1", active: true, type: "node", typeId: "node_1" }]);
    const client = fakeClient({ embedLinks: { list } as unknown as Busabase["embedLinks"] });

    await expect(retrieveActiveEmbedLink(client, "node_1", "emb_1")).resolves.toEqual({
      id: "emb_1",
      active: true,
      typeId: "node_1",
    });
    expect(list).toHaveBeenCalledWith({ type: "node", typeId: "node_1" });
  });
});

describe("verifyEmbedUrlResolves", () => {
  it("fetches the URL and reports ok/status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    await expect(
      verifyEmbedUrlResolves("https://busabase.example/embed/1", fetchImpl),
    ).resolves.toEqual({ ok: true, status: 200, location: null });
    expect(fetchImpl).toHaveBeenCalledWith("https://busabase.example/embed/1", {
      redirect: "manual",
    });
  });

  it("rejects a non-HTTP embed URL before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      verifyEmbedUrlResolves("ftp://busabase.example/embed/1", fetchImpl),
    ).rejects.toThrow(/not HTTP/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
