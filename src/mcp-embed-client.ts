import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { cloudContract } from "busabase-sdk";
import { unwrapMcpResult } from "./normalize.js";
import type { EmbedLinksClient } from "./preview-link.js";

const embedContract = cloudContract.embedLinks.create["~orpc"];

/** The OAuth grant targets MCP, while the SDK supplies the canonical embed contract. */
export function createMcpEmbedClient(
  client: Pick<Client, "callTool">,
  targetSpaceId?: string | null,
): EmbedLinksClient {
  return {
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
