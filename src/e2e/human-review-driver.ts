import type { Busabase } from "busabase-sdk";
import { checkCanonicalAirAppShape } from "./airapp-fixture.js";

export interface PendingChangeRequestQuery {
  changeRequestId: string;
  slug: string;
}

/**
 * Locates the exact pending ChangeRequest the model task's marker names.
 * Refuses to proceed against a CR that is not actually pending — the model
 * printing a plausible-looking id is not itself proof the server agrees.
 */
export async function findPendingChangeRequest(
  client: Busabase,
  query: PendingChangeRequestQuery,
): Promise<{ id: string; nodeId: string | null; status: string }> {
  const page = await client.changeRequests.list({ limit: 50 });
  const match = page.changeRequests.find((cr) => cr.id === query.changeRequestId);
  if (!match) throw new Error(`change request ${query.changeRequestId} not found among recent CRs`);
  if (match.status !== "in_review") {
    throw new Error(
      `change request ${query.changeRequestId} is not pending (status=${match.status}); refusing to act on it`,
    );
  }
  const detail = await client.changeRequests.get({ changeRequestId: match.id });
  const operation = detail.operations.find((item) => item.operation === "node_create");
  if (
    !operation ||
    operation.headCommit.payload.nodeType !== "airapp" ||
    operation.headCommit.payload.slug !== query.slug
  ) {
    throw new Error(
      `change request ${query.changeRequestId} is not the expected AirApp create for ${query.slug}`,
    );
  }
  return { id: match.id, nodeId: match.nodeId, status: match.status };
}

/** Approves then merges one pending ChangeRequest as the human reviewer. */
export async function approveAndMergeChangeRequest(
  client: Busabase,
  changeRequestId: string,
): Promise<{ nodeId: string | null }> {
  const reviewed = await client.changeRequests.review({
    changeRequestIds: [changeRequestId],
    verdict: "approved",
  });
  const reviewResult = reviewed.results[0];
  if (!reviewResult?.ok) {
    throw new Error(
      `review of ${changeRequestId} failed: ${reviewResult?.error ?? "no result returned"}`,
    );
  }

  const merged = await client.changeRequests.merge({ changeRequestIds: [changeRequestId] });
  const mergeResult = merged.results[0];
  if (!mergeResult?.ok) {
    throw new Error(
      `merge of ${changeRequestId} failed: ${mergeResult?.error ?? "no result returned"}`,
    );
  }
  const mergedNodeIds = mergeResult.changeRequest.mergeSummary.mergedNodeIds;
  return {
    nodeId:
      mergeResult.changeRequest.nodeId ??
      (Array.isArray(mergedNodeIds) && typeof mergedNodeIds[0] === "string"
        ? mergedNodeIds[0]
        : null),
  };
}

export interface CanonicalAirAppReadback {
  nodeId: string;
  packageJson: string;
  shapeCheck: ReturnType<typeof checkCanonicalAirAppShape>;
}

/** Reads the merged AirApp's package.json back from canonical storage and checks its shape. */
export async function readCanonicalAirApp(
  client: Busabase,
  nodeId: string,
): Promise<CanonicalAirAppReadback> {
  const file = await client.fileTrees.readFile({
    nodeId,
    type: "airapp",
    filePath: "package.json",
  });
  return {
    nodeId,
    packageJson: file.content,
    shapeCheck: checkCanonicalAirAppShape(file.content),
  };
}

export interface EmbedLinkResult {
  id: string;
  url: string;
  iframeUrl: string;
}

/** Mints a no-login embed link for the merged AirApp node, anywhere-embeddable per the task spec. */
export async function createAnywhereEmbedLink(
  client: Busabase,
  nodeId: string,
): Promise<EmbedLinkResult> {
  const result = await client.embedLinks.create({
    type: "node",
    typeId: nodeId,
    framePolicy: { mode: "anywhere", allowedOrigins: [] },
  });
  return { id: result.id, url: result.url, iframeUrl: result.iframeUrl };
}

/** Lists the capability back through the management API; secrets are intentionally absent. */
export async function retrieveActiveEmbedLink(
  client: Busabase,
  nodeId: string,
  embedLinkId: string,
): Promise<{ id: string; active: boolean; typeId: string }> {
  const links = await client.embedLinks.list({ type: "node", typeId: nodeId });
  const link = links.find((candidate) => candidate.id === embedLinkId);
  if (!link) throw new Error(`embed link ${embedLinkId} was not returned for node ${nodeId}`);
  return { id: link.id, active: link.active, typeId: link.typeId };
}

/** Fetches the embed URL and asserts it resolves successfully over HTTP. */
export async function verifyEmbedUrlResolves(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; location: string | null }> {
  if (!/^https?:\/\//.test(url)) throw new Error(`embed URL is not HTTP(S): ${url}`);
  const response = await fetchImpl(url, { redirect: "manual" });
  const location = response.headers.get("location");
  return {
    ok: response.ok || (response.status >= 300 && response.status < 400 && location !== null),
    status: response.status,
    location,
  };
}
