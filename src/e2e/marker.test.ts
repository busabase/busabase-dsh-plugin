import { describe, expect, it } from "vitest";
import {
  formatChangeRequestMarker,
  generateRunSlug,
  MARKER_SLUG_PREFIX,
  parseChangeRequestMarker,
  parseChangeRequestMarkerFromJsonl,
} from "./marker.js";

describe("generateRunSlug", () => {
  it("uses the deterministic prefix and stays unique across calls", () => {
    const slugs = new Set(Array.from({ length: 20 }, () => generateRunSlug()));
    expect(slugs.size).toBe(20);
    for (const slug of slugs) expect(slug.startsWith(MARKER_SLUG_PREFIX)).toBe(true);
  });

  it("accepts an injected random source for deterministic tests", () => {
    expect(generateRunSlug(() => "fixed")).toMatch(/^dsh-e2e-[0-9a-z]+-fixed$/);
  });
});

describe("marker format/parse round trip", () => {
  it("formats a single-line marker with both fields", () => {
    const line = formatChangeRequestMarker({ changeRequestId: "cr_123", slug: "dsh-e2e-abc" });
    expect(line).toBe("BUSABASE_E2E_CHANGE_REQUEST changeRequestId=cr_123 slug=dsh-e2e-abc");
  });

  it("parses the marker back out of surrounding model prose", () => {
    const output = [
      "I created the AirApp and submitted it for review.",
      "BUSABASE_E2E_CHANGE_REQUEST changeRequestId=cr_9f8 slug=dsh-e2e-19x-ab12",
      "Let me know once it is merged.",
    ].join("\n");
    expect(parseChangeRequestMarker(output)).toEqual({
      changeRequestId: "cr_9f8",
      slug: "dsh-e2e-19x-ab12",
    });
  });

  it("returns undefined when the marker is absent", () => {
    expect(parseChangeRequestMarker("no marker here")).toBeUndefined();
  });

  it("returns undefined for a malformed marker line", () => {
    expect(
      parseChangeRequestMarker("BUSABASE_E2E_CHANGE_REQUEST changeRequestId=only"),
    ).toBeUndefined();
  });

  it("extracts a marker from a persisted assistant message JSONL event", () => {
    const marker = "BUSABASE_E2E_CHANGE_REQUEST changeRequestId=crq_123 slug=dsh-e2e-run";
    const jsonl = [
      JSON.stringify({ type: "user/message", data: { message: { content: marker } } }),
      JSON.stringify({
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: `Done\n${marker}` }] } },
      }),
    ].join("\n");

    expect(parseChangeRequestMarkerFromJsonl(jsonl)).toEqual({
      changeRequestId: "crq_123",
      slug: "dsh-e2e-run",
    });
  });

  it("ignores malformed JSONL and markers outside assistant text blocks", () => {
    const marker = "BUSABASE_E2E_CHANGE_REQUEST changeRequestId=crq_123 slug=dsh-e2e-run";
    const jsonl = [
      "not json",
      JSON.stringify({ type: "user/message", data: { message: { content: marker } } }),
      JSON.stringify({
        type: "assistant/message",
        data: { message: { content: [{ type: "tool-call", text: marker }] } },
      }),
    ].join("\n");

    expect(parseChangeRequestMarkerFromJsonl(jsonl)).toBeUndefined();
  });

  it("returns the most recent persisted assistant marker", () => {
    const event = (changeRequestId: string) =>
      JSON.stringify({
        type: "assistant/message",
        data: {
          message: {
            content: [
              {
                type: "text",
                text: `BUSABASE_E2E_CHANGE_REQUEST changeRequestId=${changeRequestId} slug=dsh-e2e-run`,
              },
            ],
          },
        },
      });

    expect(
      parseChangeRequestMarkerFromJsonl([event("crq_old"), event("crq_new")].join("\n")),
    ).toEqual({ changeRequestId: "crq_new", slug: "dsh-e2e-run" });
  });
});
