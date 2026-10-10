import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { cloudContract } from "busabase-sdk";
import { unwrapMcpResult } from "./normalize.js";
import type { EmbedLinksClient } from "./preview-link.js";

const embedContract = cloudContract.embedLinks.create["~orpc"];
// The narrow preview endpoint uses the existing embed response schema.

/** The OAuth grant targets MCP, while the SDK supplies the canonical embed contract. */
export function createMcpEmbedClient(
  client: Pick<Client, "callTool">,
  targetSpaceId?: string | null,
): EmbedLinksClient {
  return {
    async createChangeRequestPreviewLink(input, options) {
      try {
        const { outputSchema } = embedContract;
        if (
          !outputSchema ||
          typeof input.changeRequestId !== "string" ||
          !input.changeRequestId.trim()
        )
          throw new Error("Preview contract is unavailable");
        const validatedInput = { changeRequestId: input.changeRequestId };
        const result = await client.callTool(
          {
            name: "change_requests_create_preview_link",
            arguments: { ...validatedInput, ...(targetSpaceId ? { targetSpaceId } : {}) },
          },
          undefined,
          { signal: options?.signal, timeout: 60_000 },
        );
        if (result.isError) throw new Error("Preview creation failed");
        return outputSchema.parse(unwrapMcpResult(result));
      } catch {
        throw new Error("Busabase Cloud could not create the preview link");
      }
    },
    embedLinks: {
      async create(input, options) {
        try {
          const { inputSchema, outputSchema } = embedContract;
          if (!inputSchema || !outputSchema) throw new Error("Embed contract is unavailable");
          const validatedInput = inputSchema.parse(input);
          const result = await client.callTool(
            {
              name: "embed_links_create",
              arguments: {
                ...validatedInput,
                ...(targetSpaceId ? { targetSpaceId } : {}),
              },
            },
            undefined,
            { signal: options?.signal, timeout: 60_000 },
          );
          if (result.isError) throw new Error("Embed creation failed");
          return outputSchema.parse(unwrapMcpResult(result));
        } catch {
          throw new Error("Busabase Cloud could not create the preview link");
        }
      },
    },
  };
}
