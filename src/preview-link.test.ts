// @vitest-environment node

import type { Busabase } from "busabase-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  autoPreviewRef,
  createChangeRequestPreviewLink,
  createdChangeRequestId,
  createdNodeId,
  createNodePreviewLink,
  isAutoPreviewToolName,
} from "./preview-link.js";

describe("preview links", () => {
  it("resolves a canonical node only from the node_create MCP result", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ id: "nod_1", type: "airapp" }) }],
    };
    expect(createdNodeId("mcp__busabase__node_create", result, "busabase")).toBe("nod_1");
    expect(createdNodeId("mcp__busabase__nodes_get", result, "busabase")).toBeNull();
  });

  it("does not treat a proposed ChangeRequest as a created node", () => {
    const result = {
      structuredContent: {
        id: "cr_1",
        type: "change-request",
        operations: [{ nodeId: "nod_future" }],
      },
    };
    expect(createdNodeId("mcp__busabase__node_create", result, "busabase")).toBeNull();
  });

  it("asks Busabase for an authoritative anywhere embed and marks it for auto-preview", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "emb_1",
      type: "node",
      typeId: "nod_1",
      targetName: "Sales Console",
      nodeType: "airapp",
      url: "http://localhost:15419/embed/emb_1?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
    });
    const result = await createNodePreviewLink(
      { embedLinks: { create } as unknown as Busabase["embedLinks"] },
      "nod_1",
    );
    expect(create).toHaveBeenCalledWith({
      type: "node",
      typeId: "nod_1",
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
    });
    expect(result).toMatchObject({ id: "emb_1", typeId: "nod_1", autoPreview: true });
    expect(autoPreviewRef(result)).toMatchObject({
      type: "embed",
      id: "emb_1",
      metadata: { autoPreview: true },
    });
  });

  it("resolves a single pending ChangeRequest from a *_change_request creation tool", () => {
    const result = {
      structuredContent: { id: "crq_1", type: "change_request", status: "in_review" },
    };
    expect(
      createdChangeRequestId("mcp__busabase__bases_create_change_request", result, "busabase"),
    ).toBe("crq_1");
    expect(createdChangeRequestId("mcp__busabase__bases_get", result, "busabase")).toBeNull();
  });

  it("resolves a single pending ChangeRequest from change_requests_get", () => {
    const result = {
      structuredContent: { id: "crq_2", type: "change_request", status: "changes_requested" },
    };
    expect(createdChangeRequestId("mcp__busabase__change_requests_get", result, "busabase")).toBe(
      "crq_2",
    );
  });

  it("keeps the Host and Client preview trust boundary on exact Busabase tool names", () => {
    expect(isAutoPreviewToolName("mcp__busabase__node_create", "busabase")).toBe(true);
    expect(isAutoPreviewToolName("mcp__busabase__change_requests_get", "busabase")).toBe(true);
    expect(isAutoPreviewToolName("mcp__other__change_requests_get", "busabase")).toBe(false);
    expect(isAutoPreviewToolName("mcp__busabase__change_request_query", "busabase")).toBe(false);
  });

  it("includes approved reviews but excludes terminal ChangeRequests", () => {
    const approved = {
      structuredContent: { id: "crq_approved", type: "change_request", status: "approved" },
    };
    const merged = {
      structuredContent: { id: "crq_3", type: "change_request", status: "merged" },
    };
    const rejected = {
      structuredContent: { id: "crq_4", type: "change_request", status: "rejected" },
    };
    expect(createdChangeRequestId("mcp__busabase__change_requests_get", approved, "busabase")).toBe(
      "crq_approved",
    );
    expect(
      createdChangeRequestId("mcp__busabase__change_requests_get", merged, "busabase"),
    ).toBeNull();
    expect(
      createdChangeRequestId("mcp__busabase__change_requests_get", rejected, "busabase"),
    ).toBeNull();
  });

  it("does not resolve a ChangeRequest id when the result is ambiguous or not a CR", () => {
    const many = {
      structuredContent: {
        changeRequests: [
          { id: "crq_5", type: "change_request", status: "in_review" },
          { id: "crq_6", type: "change_request", status: "in_review" },
        ],
      },
    };
    const node = { structuredContent: { id: "nod_1", type: "airapp" } };
    expect(
      createdChangeRequestId("mcp__busabase__change_requests_get", many, "busabase"),
    ).toBeNull();
    expect(createdChangeRequestId("mcp__busabase__node_create", node, "busabase")).toBeNull();
  });

  it("asks Busabase for an authoritative anywhere embed for a ChangeRequest and marks it for auto-preview", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "emb_2",
      type: "change-request",
      typeId: "crq_1",
      targetName: "Review CR",
      url: "http://localhost:15419/embed/emb_2?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_2?token=secret&view=iframe",
    });
    const result = await createChangeRequestPreviewLink(
      { embedLinks: { create } as unknown as Busabase["embedLinks"] },
      "crq_1",
    );
    expect(create).toHaveBeenCalledWith({
      type: "change-request",
      typeId: "crq_1",
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
    });
    expect(result).toMatchObject({ id: "emb_2", typeId: "crq_1", autoPreview: true });
    expect(autoPreviewRef(result)).toMatchObject({
      type: "change-request",
      changeRequestId: "crq_1",
      metadata: { autoPreview: true },
    });
  });
});
