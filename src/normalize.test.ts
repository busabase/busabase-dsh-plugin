import { describe, expect, it } from "vitest";
import { BUILT_IN_NODE_TYPES, normalizeBusabaseResult, VIEW_TYPES } from "./normalize.js";

describe("normalizeBusabaseResult", () => {
  it.each([...BUILT_IN_NODE_TYPES, ...VIEW_TYPES])("normalizes %s entities", (type) => {
    const [ref] = normalizeBusabaseResult({
      id: `${type}_1`,
      type,
      name: `${type} title`,
      status: "active",
    });
    expect(ref).toMatchObject({ type, id: `${type}_1`, title: `${type} title`, status: "active" });
  });

  it("normalizes records and rich payloads without changing raw data", () => {
    const raw = {
      recordId: "rec_1",
      baseId: "bse_1",
      type: "record",
      fields: { title: "Post", body: "# Article" },
    };
    const [ref] = normalizeBusabaseResult(raw);
    expect(ref).toMatchObject({ type: "record", id: "rec_1", baseId: "bse_1" });
    expect(ref.raw).toBe(raw);
  });

  it("infers a Base from the real bases.get shape when type is omitted", () => {
    const raw = {
      id: "bse_1",
      nodeId: "nod_1",
      slug: "customers",
      name: "Customers",
      description: "",
      reviewPolicy: { kind: "single", requiredApprovals: 1 },
      fields: [],
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    expect(normalizeBusabaseResult(raw)[0]).toMatchObject({
      type: "base",
      id: "bse_1",
      nodeId: "nod_1",
      slug: "customers",
      title: "Customers",
      raw,
    });
  });

  it("normalizes the real nested AirApp detail envelope", () => {
    const raw = {
      type: "airapp",
      node: {
        id: "nod_airapp",
        type: "airapp",
        slug: "sales-console",
        name: "Sales Console",
        description: "Live workspace app",
      },
      entryFile: "server.js",
      visibility: "private",
      version: "0.1.0",
      files: [{ path: "server.js", name: "server.js" }],
    };
    expect(normalizeBusabaseResult(raw)[0]).toMatchObject({
      type: "airapp",
      id: "nod_airapp",
      nodeId: "nod_airapp",
      slug: "sales-console",
      title: "Sales Console",
      metadata: { description: "Live workspace app" },
      raw,
    });
  });

  it("unwraps MCP text content and arrays", () => {
    const refs = normalizeBusabaseResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({ bases: [{ id: "bse_1", type: "base", name: "CRM" }] }),
        },
      ],
    });
    expect(refs[0]).toMatchObject({ type: "base", id: "bse_1", title: "CRM" });
  });

  it("renders an explicit empty-result card", () => {
    expect(normalizeBusabaseResult([])[0]).toMatchObject({
      type: "search-result",
      title: "No Busabase results",
      metadata: { count: 0 },
    });
  });

  it("preserves malformed and future payloads as generic cards", () => {
    const raw = { type: "quantum-board", payload: { value: 42 } };
    const [ref] = normalizeBusabaseResult(raw);
    expect(ref).toMatchObject({ type: "unknown", title: "Busabase result", raw });
  });

  it.each([
    [
      { id: "cr_pending", type: "change_request", status: "in_review", operations: [{}] },
      "in_review",
    ],
    [{ id: "cr_merged", type: "change_request", status: "merged", operations: [{}, {}] }, "merged"],
  ])("normalizes ChangeRequest state", (raw, status) => {
    expect(normalizeBusabaseResult(raw)[0]).toMatchObject({
      type: "change-request",
      status,
      changeRequestId: raw.id,
    });
  });

  it("uses the primary operation node name for a ChangeRequest title", () => {
    expect(
      normalizeBusabaseResult({
        id: "cr_named",
        status: "merged",
        operations: [],
        primaryOperation: {
          headCommit: {
            message: "Create base CRM",
            payload: { kind: "create", nodeType: "base", name: "CRM" },
          },
        },
      })[0],
    ).toMatchObject({
      type: "change-request",
      id: "cr_named",
      title: "CRM",
      status: "merged",
    });
  });

  it("normalizes a real CreatedEmbedLinkVO for a ChangeRequest, using typeId as identity and url/iframeUrl as open/preview links", () => {
    const raw = {
      id: "emb_1",
      type: "change-request",
      typeId: "cr_1",
      targetName: "Review CR",
      nodeType: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-25T00:00:00.000Z",
      revokedAt: null,
      active: true,
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
      url: "http://localhost:15419/embed/emb_1?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
    };
    expect(normalizeBusabaseResult(raw)[0]).toMatchObject({
      type: "change-request",
      id: "cr_1",
      changeRequestId: "cr_1",
      title: "Review CR",
      href: "http://localhost:15419/embed/emb_1?token=secret",
      metadata: {
        openUrl: "http://localhost:15419/embed/emb_1?token=secret",
        previewUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
      },
      raw,
    });
  });

  it("merges an automatic embed into its authoritative ChangeRequest", () => {
    const refs = normalizeBusabaseResult([
      { id: "crq_1", type: "change_request", status: "in_review", operations: [] },
      {
        id: "emb_cr",
        type: "change-request",
        typeId: "crq_1",
        targetName: "Review CR",
        url: "http://localhost:15419/embed/emb_cr?token=secret",
        iframeUrl: "http://localhost:15419/embed/emb_cr?token=secret&view=iframe",
        autoPreview: true,
      },
    ]);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: "change-request",
      id: "crq_1",
      status: "in_review",
      metadata: {
        autoPreview: true,
        previewUrl: "http://localhost:15419/embed/emb_cr?token=secret&view=iframe",
      },
    });
  });

  it("normalizes a real CreatedEmbedLinkVO for a node target as a generic embed ref", () => {
    const raw = {
      id: "emb_2",
      type: "node",
      typeId: "nod_1",
      targetName: "Sales Console",
      nodeType: "airapp",
      createdAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-25T00:00:00.000Z",
      revokedAt: null,
      active: true,
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
      url: "http://localhost:15419/embed/emb_2?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_2?token=secret&view=iframe",
    };
    expect(normalizeBusabaseResult(raw)[0]).toMatchObject({
      type: "embed",
      id: "emb_2",
      title: "Sales Console",
      href: "http://localhost:15419/embed/emb_2?token=secret&view=iframe",
      metadata: { openUrl: "http://localhost:15419/embed/emb_2?token=secret" },
      raw,
    });
  });

  it("normalizes a record-detail embed link as an embed capability", () => {
    const raw = {
      id: "emb_3",
      type: "record-detail",
      typeId: "rec_1",
      targetName: "Customer record",
      url: "http://localhost:15419/embed/emb_3?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_3?token=secret&view=iframe",
    };
    expect(normalizeBusabaseResult(raw)[0]).toMatchObject({
      type: "embed",
      id: "emb_3",
      title: "Customer record",
      href: "http://localhost:15419/embed/emb_3?token=secret&view=iframe",
      raw,
    });
  });
});
