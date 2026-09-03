export const BUILT_IN_NODE_TYPES = [
  "folder",
  "base",
  "skill",
  "drive",
  "airapp",
  "file",
  "doc",
  "form",
  "whiteboard",
  "workflow",
  "html",
] as const;
export const VIEW_TYPES = ["table", "gallery", "kanban", "calendar", "gantt"] as const;

export type BuiltInNodeType = (typeof BUILT_IN_NODE_TYPES)[number];
export type ViewType = (typeof VIEW_TYPES)[number];
export type BusabaseEntityType =
  | BuiltInNodeType
  | ViewType
  | "field"
  | "record"
  | "change-request"
  | "search-result"
  | "operation"
  | "embed"
  | "unknown";

export interface BusabaseEntityRef {
  type: BusabaseEntityType;
  id?: string;
  slug?: string;
  title: string;
  status?: string;
  baseId?: string;
  nodeId?: string;
  changeRequestId?: string;
  href?: string;
  metadata: Record<string, unknown>;
  raw: unknown;
}

const TITLE_KEYS = ["title", "name", "label", "slug", "path", "id"];

export function normalizeBusabaseResult(input: unknown): BusabaseEntityRef[] {
  const value = unwrapMcpResult(input);
  const candidates = collectCandidates(value);
  if (candidates.length === 0) {
    if (Array.isArray(value))
      return [
        { type: "search-result", title: "No Busabase results", metadata: { count: 0 }, raw: value },
      ];
    return [unknownRef(value)];
  }
  return mergeChangeRequestPreviewRefs(candidates.map(toEntityRef));
}

function mergeChangeRequestPreviewRefs(refs: BusabaseEntityRef[]): BusabaseEntityRef[] {
  const merged: BusabaseEntityRef[] = [];
  for (const ref of refs) {
    const changeRequestId =
      ref.type === "change-request" ? (ref.changeRequestId ?? ref.id) : undefined;
    const index = changeRequestId
      ? merged.findIndex(
          (candidate) =>
            candidate.type === "change-request" &&
            (candidate.changeRequestId ?? candidate.id) === changeRequestId,
        )
      : -1;
    if (index < 0) {
      merged.push(ref);
      continue;
    }

    const current = merged[index];
    const preview = ref.metadata.autoPreview === true ? ref : current;
    const authoritative = ref.metadata.autoPreview === true ? current : ref;
    merged[index] = {
      ...authoritative,
      href: preview.href ?? authoritative.href,
      metadata: {
        ...authoritative.metadata,
        ...(typeof preview.metadata.openUrl === "string"
          ? { openUrl: preview.metadata.openUrl }
          : {}),
        ...(typeof preview.metadata.previewUrl === "string"
          ? { previewUrl: preview.metadata.previewUrl }
          : {}),
        autoPreview: true,
      },
    };
  }
  return merged;
}

export function unwrapMcpResult(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if ("structuredContent" in input && input.structuredContent != null)
    return input.structuredContent;
  if (Array.isArray(input.content)) {
    for (const block of input.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        try {
          return JSON.parse(block.text);
        } catch {
          /* preserve text */
        }
      }
    }
  }
  return input;
}

function collectCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of [
    "items",
    "nodes",
    "bases",
    "records",
    "views",
    "forms",
    "results",
    "changeRequests",
    "data",
  ]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

function toEntityRef(value: unknown): BusabaseEntityRef {
  if (!isRecord(value)) return unknownRef(value);
  if (isCreatedEmbedLink(value)) return embedLinkRef(value);
  const type = inferType(value);
  const identity = nestedNode(value) ?? value;
  const id = entityId(identity, type);
  const slug = firstString(identity, ["slug"]);
  const title =
    (type === "change-request" ? changeRequestTitle(value) : undefined) ??
    firstString(identity, TITLE_KEYS) ??
    titleForType(type);
  const status = firstString(value, ["status", "state", "reviewStatus", "runtimeStatus"]);
  const metadata = { ...pickMetadata(identity), ...pickMetadata(value) };
  return {
    type,
    id,
    slug,
    title,
    status,
    baseId: firstString(value, ["baseId"]) ?? firstString(identity, ["baseId"]),
    nodeId:
      firstString(value, ["nodeId"]) ??
      (type === "base"
        ? firstString(identity, ["nodeId"])
        : firstString(identity, ["nodeId", "id"])),
    changeRequestId:
      firstString(value, ["changeRequestId"]) ?? (type === "change-request" ? id : undefined),
    href: firstString(value, ["href", "url"]),
    metadata,
    raw: value,
  };
}

/** Real `embedLinks.create` result shape: `{id,type,typeId,targetName,url,iframeUrl,...}`. */
function isCreatedEmbedLink(value: Record<string, unknown>): boolean {
  return (
    typeof value.typeId === "string" &&
    typeof value.url === "string" &&
    typeof value.iframeUrl === "string"
  );
}

function embedLinkRef(value: Record<string, unknown>): BusabaseEntityRef {
  const typeId = value.typeId as string;
  const url = value.url as string;
  const iframeUrl = value.iframeUrl as string;
  const targetName = firstString(value, ["targetName"]);
  if (value.type === "change-request") {
    return {
      type: "change-request",
      id: typeId,
      changeRequestId: typeId,
      title: targetName ?? titleForType("change-request"),
      href: url,
      metadata: {
        openUrl: url,
        previewUrl: iframeUrl,
        ...(value.autoPreview === true ? { autoPreview: true } : {}),
      },
      raw: value,
    };
  }
  return {
    type: "embed",
    id: firstString(value, ["id"]) ?? typeId,
    title: targetName ?? titleForType("embed"),
    href: iframeUrl,
    metadata: {
      openUrl: url,
      ...(value.autoPreview === true ? { autoPreview: true } : {}),
    },
    raw: value,
  };
}

function changeRequestTitle(value: Record<string, unknown>): string | undefined {
  const primaryOperation = isRecord(value.primaryOperation)
    ? value.primaryOperation
    : Array.isArray(value.operations) && isRecord(value.operations[0])
      ? value.operations[0]
      : undefined;
  const headCommit =
    primaryOperation && isRecord(primaryOperation.headCommit)
      ? primaryOperation.headCommit
      : undefined;
  const payload = headCommit && isRecord(headCommit.payload) ? headCommit.payload : undefined;
  const node = isRecord(value.node) ? value.node : undefined;
  const base = isRecord(value.base) ? value.base : undefined;
  return (
    (payload ? firstString(payload, ["name", "title", "slug"]) : undefined) ??
    (node ? firstString(node, TITLE_KEYS) : undefined) ??
    (base ? firstString(base, TITLE_KEYS) : undefined) ??
    (headCommit ? firstString(headCommit, ["message"]) : undefined)
  );
}

function entityId(value: Record<string, unknown>, type: BusabaseEntityType): string | undefined {
  if (type === "record") return firstString(value, ["recordId", "id"]);
  if (type === "base") return firstString(value, ["baseId", "id", "nodeId"]);
  if (type === "change-request") return firstString(value, ["changeRequestId", "id"]);
  if ((VIEW_TYPES as readonly string[]).includes(type))
    return firstString(value, ["viewId", "id", "nodeId"]);
  if (type === "form") return firstString(value, ["formId", "id", "nodeId"]);
  return firstString(value, [
    "id",
    "nodeId",
    "baseId",
    "recordId",
    "viewId",
    "formId",
    "changeRequestId",
  ]);
}

function inferType(value: Record<string, unknown>): BusabaseEntityType {
  const explicit = firstString(value, [
    "entityType",
    "nodeType",
    "type",
    "viewType",
    "kind",
  ])?.toLowerCase();
  if (explicit && (BUILT_IN_NODE_TYPES as readonly string[]).includes(explicit))
    return explicit as BuiltInNodeType;
  if (explicit && (VIEW_TYPES as readonly string[]).includes(explicit)) return explicit as ViewType;
  if (explicit?.includes("change") || "changeRequestId" in value || "operations" in value)
    return "change-request";
  if ("nodeId" in value && Array.isArray(value.fields) && "reviewPolicy" in value) return "base";
  if (
    explicit?.includes("record") ||
    ("fields" in value && ("baseId" in value || "recordId" in value))
  )
    return "record";
  if (explicit?.includes("field") || ("fieldType" in value && "slug" in value)) return "field";
  if ("results" in value || "matches" in value) return "search-result";
  return "unknown";
}

function nestedNode(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(value.node) ? value.node : undefined;
}

function pickMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "description",
    "path",
    "slug",
    "baseId",
    "nodeId",
    "viewType",
    "fieldType",
    "createdAt",
    "updatedAt",
    "submittedBy",
    "operationCount",
  ]) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (Array.isArray(value.operations)) result.operationCount = value.operations.length;
  return result;
}

function unknownRef(raw: unknown): BusabaseEntityRef {
  return { type: "unknown", title: "Busabase result", metadata: {}, raw };
}

function titleForType(type: BusabaseEntityType): string {
  return type === "unknown"
    ? "Busabase result"
    : type
        .split("-")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(" ");
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
