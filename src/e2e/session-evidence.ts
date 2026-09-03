import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionEvidence {
  usedSkillTool: boolean;
  loadedBusabaseAppCreatorSkill: boolean;
  calledBusabaseMcpTool: boolean;
  calledChangeRequestMutationTool: boolean;
  mcpAirAppCreateSlugs: string[];
  mcpChangeRequestIds: string[];
  mcpPreviewProvenance: McpPreviewProvenance[];
  sessionFiles: string[];
}

export interface McpPreviewProvenance {
  toolName: string;
  callId: string;
  changeRequestId: string;
  embedLinkId: string;
  iframeUrl: string;
}

const NO_EVIDENCE: SessionEvidence = {
  usedSkillTool: false,
  loadedBusabaseAppCreatorSkill: false,
  calledBusabaseMcpTool: false,
  calledChangeRequestMutationTool: false,
  mcpAirAppCreateSlugs: [],
  mcpChangeRequestIds: [],
  mcpPreviewProvenance: [],
  sessionFiles: [],
};
const REVIEWABLE_CHANGE_REQUEST_STATUSES = new Set([
  "in_review",
  "changes_requested",
  "approved",
  "conflict",
]);

/**
 * Scans every `session*.jsonl(.zstd)` file under a DSH session root for
 * durable, harness-recorded proof that the model actually invoked the
 * `skill` tool naming `busabase-app-creator` and at least one
 * `mcp__<serverName>__*` tool. Deliberately a raw substring/regex scan of the
 * persisted event log rather than a parse of its internal event schema: tool
 * names are stable literal strings in the log line regardless of envelope
 * shape, and this is strictly stronger evidence than trusting the model's
 * final prose summary, which is the point.
 */
export async function collectSessionEvidence(
  sessionRoot: string,
  serverName: string,
): Promise<SessionEvidence> {
  const files = await findSessionFiles(sessionRoot);
  if (files.length === 0) return { ...NO_EVIDENCE, sessionFiles: [] };

  let usedSkillTool = false;
  let loadedBusabaseAppCreatorSkill = false;
  let calledBusabaseMcpTool = false;
  let calledChangeRequestMutationTool = false;
  const mcpAirAppCreateSlugs = new Set<string>();
  const mcpChangeRequestIds = new Set<string>();
  const mcpToolNamesByCallId = new Map<string, string>();
  const mcpResultValuesByCallId = new Map<string, Record<string, unknown>[]>();
  const mcpPrefix = `mcp__${serverName}__`;

  for (const file of files) {
    if (file.endsWith(".zstd")) {
      throw new Error(
        `cannot verify DSH tool evidence from compressed session ${file}; the E2E profile must set session-persistence-jsonl compression to none`,
      );
    }
    const text = await readFile(file, "utf8");
    if (/"name"\s*:\s*"skill"/.test(text)) usedSkillTool = true;
    if (text.includes("busabase-app-creator")) loadedBusabaseAppCreatorSkill = true;
    if (text.includes(mcpPrefix)) calledBusabaseMcpTool = true;
    if (
      new RegExp(
        `${mcpPrefix}(?:node_create|nodes_create_change_request|bases_create_change_request|bases_create_bulk_change_request)`,
        "i",
      ).test(text)
    )
      calledChangeRequestMutationTool = true;
    for (const line of text.split("\n")) {
      const event = parseRecord(line);
      if (!event) continue;
      if (
        event.type === "tool/call" &&
        new RegExp(`^${mcpPrefix}(?:node_create|nodes_create_change_request)$`, "i").test(
          event.data.name ?? "",
        )
      ) {
        const args = parseJsonObject(event.data.arguments);
        if (args?.type === "airapp" && typeof args.slug === "string")
          mcpAirAppCreateSlugs.add(args.slug);
      }
      if (
        event.type === "tool/call" &&
        typeof event.data.callId === "string" &&
        typeof event.data.name === "string" &&
        event.data.name.startsWith(mcpPrefix)
      ) {
        mcpToolNamesByCallId.set(event.data.callId, event.data.name);
      }
      if (event.type === "tool/result") {
        const callId = toolResultCallId(event.data);
        for (const resultText of toolResultTexts(event.data)) {
          const result = parseJsonObject(resultText);
          if (typeof result?.id === "string" && result.id.startsWith("crq"))
            mcpChangeRequestIds.add(result.id);
          if (callId && result) {
            const values = mcpResultValuesByCallId.get(callId) ?? [];
            values.push(result);
            mcpResultValuesByCallId.set(callId, values);
          }
        }
      }
    }
  }

  return {
    usedSkillTool,
    loadedBusabaseAppCreatorSkill,
    calledBusabaseMcpTool,
    calledChangeRequestMutationTool,
    mcpAirAppCreateSlugs: [...mcpAirAppCreateSlugs],
    mcpChangeRequestIds: [...mcpChangeRequestIds],
    mcpPreviewProvenance: collectPreviewProvenance(mcpToolNamesByCallId, mcpResultValuesByCallId),
    sessionFiles: files,
  };
}

interface StoredEvent {
  type: string;
  data: Record<string, unknown> & { name?: string; callId?: string; arguments?: string };
}

function parseRecord(line: string): StoredEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const record = value as { type?: unknown; data?: unknown };
    if (typeof record.type !== "string" || !record.data || typeof record.data !== "object")
      return undefined;
    return { type: record.type, data: record.data as StoredEvent["data"] };
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toolResultTexts(data: Record<string, unknown>): string[] {
  const message = data.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return [];
  const texts: string[] = [];
  for (const outer of message.content) {
    const result = outer as { type?: unknown; content?: unknown };
    if (result.type !== "tool-result" || !Array.isArray(result.content)) continue;
    for (const inner of result.content) {
      const text = inner as { type?: unknown; text?: unknown };
      if (text.type === "text" && typeof text.text === "string") texts.push(text.text);
    }
  }
  return texts;
}

function toolResultCallId(data: Record<string, unknown>): string | undefined {
  const message = data.message as { source?: unknown; content?: unknown } | undefined;
  const source = message?.source as { kind?: unknown; callId?: unknown } | undefined;
  if (source?.kind === "tool" && typeof source.callId === "string") return source.callId;
  if (!Array.isArray(message?.content)) return undefined;
  for (const block of message.content) {
    const result = block as { type?: unknown; toolCallId?: unknown };
    if (result.type === "tool-result" && typeof result.toolCallId === "string")
      return result.toolCallId;
  }
  return undefined;
}

function collectPreviewProvenance(
  toolNamesByCallId: Map<string, string>,
  resultValuesByCallId: Map<string, Record<string, unknown>[]>,
): McpPreviewProvenance[] {
  const provenance: McpPreviewProvenance[] = [];
  for (const [callId, values] of resultValuesByCallId) {
    const toolName = toolNamesByCallId.get(callId);
    if (!toolName) continue;
    const changeRequests = values.filter(
      (value) =>
        typeof value.id === "string" &&
        value.id.startsWith("crq") &&
        typeof value.status === "string" &&
        REVIEWABLE_CHANGE_REQUEST_STATUSES.has(value.status),
    );
    if (changeRequests.length !== 1) continue;
    const changeRequestId = changeRequests[0].id as string;
    const links = values.filter(
      (value) =>
        value.type === "change-request" &&
        value.typeId === changeRequestId &&
        value.autoPreview === true &&
        value.active === true &&
        typeof value.id === "string" &&
        typeof value.iframeUrl === "string",
    );
    if (links.length !== 1) continue;
    provenance.push({
      toolName,
      callId,
      changeRequestId,
      embedLinkId: links[0].id as string,
      iframeUrl: links[0].iframeUrl as string,
    });
  }
  return provenance;
}

async function findSessionFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) found.push(path);
    }
  }
  await walk(root);
  return found;
}
