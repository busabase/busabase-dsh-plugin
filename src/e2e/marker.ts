import { randomBytes } from "node:crypto";

/** Deterministic prefix so a stray CR from a failed run is easy to spot and never collides across runs. */
export const MARKER_SLUG_PREFIX = "dsh-e2e-";
const MARKER_TAG = "BUSABASE_E2E_CHANGE_REQUEST";
const MARKER_LINE = new RegExp(`^${MARKER_TAG}\\s+changeRequestId=(\\S+)\\s+slug=(\\S+)\\s*$`, "m");

export interface ChangeRequestMarker {
  changeRequestId: string;
  slug: string;
}

/** Unique slug for one run's AirApp, so repeated runs never collide on an existing node. */
export function generateRunSlug(
  random: () => string = () => randomBytes(4).toString("hex"),
): string {
  return `${MARKER_SLUG_PREFIX}${Date.now().toString(36)}-${random()}`;
}

/**
 * The exact line the model task must print after submitting the AirApp
 * ChangeRequest. Kept on one line, with a fixed tag, so the driver can find
 * it by regex even inside verbose model prose instead of parsing free text.
 */
export function formatChangeRequestMarker(marker: ChangeRequestMarker): string {
  return `${MARKER_TAG} changeRequestId=${marker.changeRequestId} slug=${marker.slug}`;
}

/** Extracts the marker from arbitrary model output; returns undefined when absent or malformed. */
export function parseChangeRequestMarker(output: string): ChangeRequestMarker | undefined {
  const match = MARKER_LINE.exec(output);
  if (!match) return undefined;
  return { changeRequestId: match[1], slug: match[2] };
}

/** Extracts the marker from persisted DSH `assistant/message` JSONL events. */
export function parseChangeRequestMarkerFromJsonl(jsonl: string): ChangeRequestMarker | undefined {
  let latest: ChangeRequestMarker | undefined;
  for (const line of jsonl.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as { type?: unknown; data?: { message?: { content?: unknown } } };
    if (record.type !== "assistant/message" || !Array.isArray(record.data?.message?.content))
      continue;
    for (const block of record.data.message.content) {
      if (!block || typeof block !== "object") continue;
      const textBlock = block as { type?: unknown; text?: unknown };
      if (textBlock.type !== "text" || typeof textBlock.text !== "string") continue;
      const marker = parseChangeRequestMarker(textBlock.text);
      if (marker) latest = marker;
    }
  }
  return latest;
}
