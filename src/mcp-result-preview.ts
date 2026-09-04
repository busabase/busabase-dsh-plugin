import type { Context } from "@deepseek-ai/cordis";
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { Busabase } from "busabase-sdk";
import {
  createChangeRequestPreviewLink,
  createdChangeRequestId,
  createdNodeId,
  createNodePreviewLink,
} from "./preview-link.js";

interface PreviewContext {
  on(
    event: "tools/post-execute",
    listener: (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ) => Promise<PostToolDecision>,
  ): unknown;
  logger: Pick<Context["logger"], "warn">;
}

export function registerMcpResultPreview(
  ctx: PreviewContext,
  client: Pick<Busabase, "embedLinks">,
  serverName: string,
): void {
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== "accept" || "value" in decision || result.isError) return decision;

    const nodeId = createdNodeId(exec.name, result.value, serverName);
    if (nodeId)
      return appendLink(
        ctx,
        decision,
        result,
        () => createNodePreviewLink(client, nodeId),
        nodeId,
        "node",
      );

    const changeRequestId = createdChangeRequestId(exec.name, result.value, serverName);
    if (changeRequestId)
      return appendLink(
        ctx,
        decision,
        result,
        () => createChangeRequestPreviewLink(client, changeRequestId),
        changeRequestId,
        "ChangeRequest",
      );

    return decision;
  });
}

/**
 * Cloud has no local trusted-Host step, so it mints the same ChangeRequest
 * preview via a raw authenticated `embed_links_create` call instead of the
 * REST SDK. Only ChangeRequest previews are minted here — node/record
 * capabilities are never reachable through this path.
 */
export function registerRemoteChangeRequestPreview(
  ctx: PreviewContext,
  serverName: string,
  createEmbedLink: (
    changeRequestId: string,
    targetSpaceId: string | undefined,
    signal: AbortSignal,
  ) => Promise<unknown>,
): void {
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== "accept" || "value" in decision || result.isError) return decision;

    const changeRequestId = createdChangeRequestId(exec.name, result.value, serverName);
    if (!changeRequestId) return decision;

    return appendLink(
      ctx,
      decision,
      result,
      () => createEmbedLink(changeRequestId, targetSpaceIdFrom(exec.arguments), exec.signal),
      changeRequestId,
      "ChangeRequest",
    );
  });
}

function targetSpaceIdFrom(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).targetSpaceId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function appendLink(
  ctx: PreviewContext,
  decision: PostToolDecision & { kind: "accept" },
  result: Readonly<ToolExecutionResult>,
  create: () => Promise<unknown>,
  entityId: string,
  entityLabel: "node" | "ChangeRequest",
): Promise<PostToolDecision> {
  try {
    const link = await create();
    return {
      kind: "accept",
      content: appendPreviewContent(decision.content ?? result.content, link),
      ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
    };
  } catch (error) {
    ctx.logger.warn(
      `busabase preview: could not create an embed link for ${entityLabel} ${entityId}; preserving the original MCP result: ${String(error)}`,
    );
    return decision;
  }
}

function appendPreviewContent(
  content: ToolExecutionResult["content"],
  link: unknown,
): ToolExecutionResult["content"] {
  return [...content, { type: "text", text: JSON.stringify(link) }];
}
