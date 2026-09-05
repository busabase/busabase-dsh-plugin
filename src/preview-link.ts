import type { Busabase } from "busabase-sdk";
import {
  BUILT_IN_NODE_TYPES,
  type BusabaseEntityRef,
  normalizeBusabaseResult,
} from "./normalize.js";

export interface CreatedPreviewLink {
  id: string;
  type: "node";
  typeId: string;
  targetName?: string;
  nodeType?: string | null;
  url: string;
  iframeUrl: string;
  autoPreview: true;
}

export interface CreatedChangeRequestPreviewLink {
  id: string;
  type: "change-request";
  typeId: string;
  targetName?: string;
  url: string;
  iframeUrl: string;
  autoPreview: true;
}

type EmbedLinksClient = Pick<Busabase, "embedLinks">;

const REVIEWABLE_CHANGE_REQUEST_STATUSES = [
  "in_review",
  "changes_requested",
  "approved",
  "conflict",
];

export function createdNodeId(toolName: string, value: unknown, serverName: string): string | null {
  if (toolName !== `mcp__${serverName}__node_create`) return null;
  return canonicalNodeId(value);
}

export function canonicalNodeId(value: unknown): string | null {
  const ref = normalizeBusabaseResult(value).find(isCanonicalNodeRef);
  return ref?.nodeId ?? ref?.id ?? null;
}

const CHANGE_REQUEST_PREVIEW_TOOLS = [
  "node_create",
  "base_field_change_request",
  "bases_create_bulk_change_request",
  "bases_create_change_request",
  "bases_lifecycle_change_request",
  "node_files_change_request",
  "nodes_create_change_request",
  "record_change_request",
  "view_change_request",
  "change_requests_get",
  "embed_links_create",
] as const;

/**
 * Resolves the id of a single pending ChangeRequest from an exact MCP result:
 * `node_create` returning a CR instead of a canonical node, any `*_change_request`
 * creation tool, or `change_requests_get`. Ambiguous or already-resolved results
 * (multiple refs, merged/rejected/closed) are left alone.
 */
export function createdChangeRequestId(
  toolName: string,
  value: unknown,
  serverName: string,
): string | null {
  if (!isAutoPreviewToolName(toolName, serverName)) return null;
  const refs = normalizeBusabaseResult(value);
  if (refs.length !== 1) return null;
  const [ref] = refs;
  if (
    ref.type !== "change-request" ||
    !REVIEWABLE_CHANGE_REQUEST_STATUSES.includes(ref.status ?? "")
  )
    return null;
  return ref.changeRequestId ?? ref.id ?? null;
}

export function isAutoPreviewToolName(toolName: string, serverName: string): boolean {
  return CHANGE_REQUEST_PREVIEW_TOOLS.some((tool) => toolName === `mcp__${serverName}__${tool}`);
}

export async function createNodePreviewLink(
  client: EmbedLinksClient,
  nodeId: string,
): Promise<CreatedPreviewLink> {
  const link = await client.embedLinks.create({
    type: "node",
    typeId: nodeId,
    framePolicy: { mode: "anywhere", allowedOrigins: [] },
  });
  return { ...link, type: "node", typeId: nodeId, autoPreview: true };
}

export async function createChangeRequestPreviewLink(
  client: EmbedLinksClient,
  changeRequestId: string,
): Promise<CreatedChangeRequestPreviewLink> {
  const link = await client.embedLinks.create({
    type: "change-request",
    typeId: changeRequestId,
    framePolicy: { mode: "anywhere", allowedOrigins: [] },
  });
  return { ...link, type: "change-request", typeId: changeRequestId, autoPreview: true };
}

export function autoPreviewRef(value: unknown): BusabaseEntityRef | null {
  const ref = normalizeBusabaseResult(value).find(
    (candidate) =>
      (candidate.type === "embed" || candidate.type === "change-request") &&
      candidate.metadata.autoPreview === true,
  );
  return ref ?? null;
}

function isCanonicalNodeRef(ref: BusabaseEntityRef): boolean {
  return (BUILT_IN_NODE_TYPES as readonly string[]).includes(ref.type);
}
