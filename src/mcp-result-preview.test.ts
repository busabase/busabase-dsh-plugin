// @vitest-environment node

import type { PostToolDecision } from "@deepseek-ai/dsh-tools";
import type { Busabase } from "busabase-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  registerMcpResultPreview,
  registerRemoteChangeRequestPreview,
} from "./mcp-result-preview.js";

const success = (value: unknown) => ({
  isError: false as const,
  value,
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

function setup(create = vi.fn()) {
  let listener!: (
    exec: { name: string },
    result: ReturnType<typeof success>,
    next: () => Promise<PostToolDecision>,
  ) => Promise<PostToolDecision>;
  const warn = vi.fn();
  registerMcpResultPreview(
    {
      on: (_event, callback) => {
        listener = callback as typeof listener;
      },
      logger: { warn },
    },
    { embedLinks: { create } as unknown as Busabase["embedLinks"] },
    "busabase",
  );
  return { listener, create, warn };
}

function setupRemote(createEmbedLink = vi.fn()) {
  let listener!: (
    exec: { name: string; arguments: unknown; signal: AbortSignal },
    result: ReturnType<typeof success>,
    next: () => Promise<PostToolDecision>,
  ) => Promise<PostToolDecision>;
  const warn = vi.fn();
  registerRemoteChangeRequestPreview(
    {
      on: (_event, callback) => {
        listener = callback as typeof listener;
      },
      logger: { warn },
    },
    "busabase",
    createEmbedLink,
  );
  return { listener, createEmbedLink, warn };
}

describe("MCP result preview augmentation", () => {
  it("appends an embed link after a successful canonical node creation", async () => {
    const { listener, create } = setup(
      vi.fn().mockResolvedValue({
        id: "emb_1",
        type: "node",
        typeId: "nod_1",
        url: "http://localhost:15419/embed/emb_1?token=secret",
        iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
      }),
    );
    const result = success({ type: "airapp", id: "nod_1", name: "Sales Console" });
    const decision = await listener({ name: "mcp__busabase__node_create" }, result, async () => ({
      kind: "accept",
    }));
    expect(create).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ kind: "accept" });
    expect(
      decision.kind === "accept" && "content" in decision ? decision.content : [],
    ).toHaveLength(2);
  });

  it("preserves the original decision when preview creation fails", async () => {
    const { listener, warn } = setup(vi.fn().mockRejectedValue(new Error("not authorized")));
    const original = { kind: "accept" as const };
    const decision = await listener(
      { name: "mcp__busabase__node_create" },
      success({ type: "doc", id: "nod_1" }),
      async () => original,
    );
    expect(decision).toBe(original);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not recurse for embed tools or override another listener's value decision", async () => {
    const { listener, create } = setup();
    await listener(
      { name: "mcp__busabase__embed_links_create" },
      success({ type: "airapp", id: "nod_1" }),
      async () => ({ kind: "accept" }),
    );
    const replacement = { kind: "accept" as const, value: { replaced: true } };
    const decision = await listener(
      { name: "mcp__busabase__node_create" },
      success({ type: "airapp", id: "nod_1" }),
      async () => replacement,
    );
    expect(create).not.toHaveBeenCalled();
    expect(decision).toBe(replacement);
  });

  it("appends an embed link after a *_change_request tool creates a single pending ChangeRequest", async () => {
    const { listener, create } = setup(
      vi.fn().mockResolvedValue({
        id: "emb_1",
        type: "change-request",
        typeId: "crq_1",
        url: "http://localhost:15419/embed/emb_1?token=secret",
        iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
      }),
    );
    const result = success({ id: "crq_1", type: "change_request", status: "in_review" });
    const decision = await listener(
      { name: "mcp__busabase__bases_create_change_request" },
      result,
      async () => ({ kind: "accept" }),
    );
    expect(create).toHaveBeenCalledWith({
      type: "change-request",
      typeId: "crq_1",
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
    });
    expect(decision).toMatchObject({ kind: "accept" });
    expect(
      decision.kind === "accept" && "content" in decision ? decision.content : [],
    ).toHaveLength(2);
  });

  it("appends an embed link after change_requests_get returns a single pending ChangeRequest", async () => {
    const { listener, create } = setup(
      vi.fn().mockResolvedValue({
        id: "emb_2",
        type: "change-request",
        typeId: "crq_2",
        url: "http://localhost:15419/embed/emb_2?token=secret",
        iframeUrl: "http://localhost:15419/embed/emb_2?token=secret&view=iframe",
      }),
    );
    const result = success({ id: "crq_2", type: "change_request", status: "changes_requested" });
    const decision = await listener(
      { name: "mcp__busabase__change_requests_get" },
      result,
      async () => ({ kind: "accept" }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ kind: "accept" });
  });

  it("does not enrich a merged ChangeRequest or an ambiguous multi-ChangeRequest page", async () => {
    const { listener, create } = setup();
    const merged = await listener(
      { name: "mcp__busabase__change_requests_get" },
      success({ id: "crq_3", type: "change_request", status: "merged" }),
      async () => ({ kind: "accept" }),
    );
    const page = await listener(
      { name: "mcp__busabase__change_requests_list_page" },
      success({
        changeRequests: [
          { id: "crq_4", type: "change_request", status: "in_review" },
          { id: "crq_5", type: "change_request", status: "in_review" },
        ],
      }),
      async () => ({ kind: "accept" }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(merged).toMatchObject({ kind: "accept" });
    expect(page).toMatchObject({ kind: "accept" });
  });

  it("preserves the original decision when ChangeRequest embed creation fails", async () => {
    const { listener, warn } = setup(vi.fn().mockRejectedValue(new Error("not authorized")));
    const original = { kind: "accept" as const };
    const decision = await listener(
      { name: "mcp__busabase__bases_create_change_request" },
      success({ id: "crq_6", type: "change_request", status: "in_review" }),
      async () => original,
    );
    expect(decision).toBe(original);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("remote ChangeRequest preview augmentation", () => {
  it("mints a ChangeRequest embed link after a pending create, preserving targetSpaceId and cancellation", async () => {
    const createEmbedLink = vi.fn().mockResolvedValue({
      id: "emb_1",
      type: "change-request",
      typeId: "crq_1",
      url: "https://busabase.example/embed/emb_1",
      iframeUrl: "https://busabase.example/embed/emb_1?view=iframe",
      autoPreview: true,
    });
    const { listener } = setupRemote(createEmbedLink);
    const signal = new AbortController().signal;
    const result = success({ id: "crq_1", type: "change_request", status: "in_review" });
    const decision = await listener(
      { name: "mcp__busabase__node_create", arguments: { targetSpaceId: "spc_1" }, signal },
      result,
      async () => ({ kind: "accept" }),
    );
    expect(createEmbedLink).toHaveBeenCalledWith("crq_1", "spc_1", signal);
    expect(decision).toMatchObject({ kind: "accept" });
    expect(
      decision.kind === "accept" && "content" in decision ? decision.content : [],
    ).toHaveLength(2);
  });

  it("omits targetSpaceId when the tool call did not include one", async () => {
    const createEmbedLink = vi.fn().mockResolvedValue({});
    const { listener } = setupRemote(createEmbedLink);
    const signal = new AbortController().signal;
    await listener(
      { name: "mcp__busabase__bases_create_change_request", arguments: {}, signal },
      success({ id: "crq_2", type: "change_request", status: "in_review" }),
      async () => ({ kind: "accept" }),
    );
    expect(createEmbedLink).toHaveBeenCalledWith("crq_2", undefined, signal);
  });

  it("never mints a node or record capability, only ChangeRequest previews", async () => {
    const createEmbedLink = vi.fn();
    const { listener } = setupRemote(createEmbedLink);
    const signal = new AbortController().signal;
    await listener(
      { name: "mcp__busabase__node_create", arguments: {}, signal },
      success({ type: "airapp", id: "nod_1", name: "Sales Console" }),
      async () => ({ kind: "accept" }),
    );
    await listener(
      { name: "mcp__busabase__embed_links_create", arguments: {}, signal },
      success({ type: "airapp", id: "nod_1" }),
      async () => ({ kind: "accept" }),
    );
    expect(createEmbedLink).not.toHaveBeenCalled();
  });

  it("preserves the original result and only warns when minting the embed link fails", async () => {
    const createEmbedLink = vi.fn().mockRejectedValue(new Error("Forbidden"));
    const { listener, warn } = setupRemote(createEmbedLink);
    const original = { kind: "accept" as const };
    const decision = await listener(
      { name: "mcp__busabase__node_create", arguments: {}, signal: new AbortController().signal },
      success({ id: "crq_3", type: "change_request", status: "in_review" }),
      async () => original,
    );
    expect(decision).toBe(original);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not recurse for embed tools or override another listener's value decision", async () => {
    const createEmbedLink = vi.fn();
    const { listener } = setupRemote(createEmbedLink);
    const replacement = { kind: "accept" as const, value: { replaced: true } };
    const decision = await listener(
      { name: "mcp__busabase__node_create", arguments: {}, signal: new AbortController().signal },
      success({ id: "crq_4", type: "change_request", status: "in_review" }),
      async () => replacement,
    );
    expect(createEmbedLink).not.toHaveBeenCalled();
    expect(decision).toBe(replacement);
  });
});
