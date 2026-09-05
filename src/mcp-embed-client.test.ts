import { cloudContract } from "busabase-sdk";
import { describe, expect, it, vi } from "vitest";
import { createMcpEmbedClient } from "./mcp-embed-client.js";

const input = {
  type: "change-request" as const,
  typeId: "crq_reading",
  framePolicy: { mode: "origins" as const, allowedOrigins: ["http://localhost:3080"] },
};
const link = {
  id: "embed_reading",
  type: input.type,
  typeId: input.typeId,
  targetName: "Reading Progress",
  nodeType: null,
  createdAt: "2026-09-05T00:00:00.000Z",
  expiresAt: "2026-09-05T00:15:00.000Z",
  revokedAt: null,
  active: true,
  framePolicy: input.framePolicy,
  url: "https://busabase.example/embed/reading",
  iframeUrl: "https://busabase.example/embed/reading?view=iframe",
};

describe("SDK contract-backed MCP embed client", () => {
  it.each(["structured", "content"])(
    "validates %s results and preserves SDK metadata",
    async (format) => {
      const callTool = vi
        .fn()
        .mockResolvedValue(
          format === "structured"
            ? { content: [], structuredContent: link }
            : { content: [{ type: "text", text: JSON.stringify(link) }] },
        );
      const client = createMcpEmbedClient({ callTool }, "selected-space");
      const signal = new AbortController().signal;
      await expect(client.embedLinks.create(input, { signal })).resolves.toEqual(link);
      expect(callTool).toHaveBeenCalledWith(
        {
          name: "embed_links_create",
          arguments: {
            ...cloudContract.embedLinks.create["~orpc"].inputSchema.parse(input),
            targetSpaceId: "selected-space",
          },
        },
        undefined,
        { signal, timeout: 60_000 },
      );
    },
  );

  it("omits absent space headers and forwards an explicit expiry", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: link });
    await createMcpEmbedClient({ callTool }).embedLinks.create({ ...input, expiresInMinutes: 5 });
    expect(callTool.mock.calls[0]?.[0].arguments).toMatchObject({ expiresInMinutes: 5 });
    expect(callTool.mock.calls[0]?.[0].arguments).not.toHaveProperty("targetSpaceId");
  });

  it("rejects invalid inputs before invoking MCP using SDK validation", async () => {
    const callTool = vi.fn();
    await expect(
      createMcpEmbedClient({ callTool }).embedLinks.create({ ...input, expiresInMinutes: -1 }),
    ).rejects.toThrow("could not create the preview link");
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(["missing-metadata", "mcp-error", "transport-error"])(
    "sanitizes %s failures",
    async (failure) => {
      const callTool = vi.fn();
      if (failure === "transport-error")
        callTool.mockRejectedValue(new Error("private-oauth-token"));
      else
        callTool.mockResolvedValue({
          content: [{ type: "text", text: "private-oauth-token" }],
          structuredContent:
            failure === "missing-metadata"
              ? { id: link.id, url: link.url, iframeUrl: link.iframeUrl }
              : link,
          ...(failure === "mcp-error" ? { isError: true } : {}),
        });
      await expect(createMcpEmbedClient({ callTool }).embedLinks.create(input)).rejects.toThrow(
        "Busabase Cloud could not create the preview link",
      );
    },
  );
});
