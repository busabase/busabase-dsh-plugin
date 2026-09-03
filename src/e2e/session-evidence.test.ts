import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSessionEvidence } from "./session-evidence.js";

describe("collectSessionEvidence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "session-evidence-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports no evidence for an empty session root", async () => {
    await expect(collectSessionEvidence(root, "busabase")).resolves.toMatchObject({
      usedSkillTool: false,
      loadedBusabaseAppCreatorSkill: false,
      calledBusabaseMcpTool: false,
      calledChangeRequestMutationTool: false,
      mcpAirAppCreateSlugs: [],
      mcpChangeRequestIds: [],
      mcpPreviewProvenance: [],
      sessionFiles: [],
    });
  });

  it("detects skill usage, MCP tool calls, and CR mutation calls across nested session directories", async () => {
    const sessionDir = join(root, "project-a", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "tool/call",
          data: { name: "skill", arguments: { name: "busabase-app-creator" } },
        }),
        JSON.stringify({ type: "tool/call", data: { name: "mcp__busabase__busabase_guide" } }),
        JSON.stringify({
          type: "tool/call",
          data: {
            name: "mcp__busabase__node_create",
            callId: "call_node_create",
            arguments: JSON.stringify({ type: "airapp", slug: "dsh-e2e-1" }),
          },
        }),
        JSON.stringify({
          type: "tool/result",
          data: {
            message: {
              source: { kind: "tool", callId: "call_node_create" },
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call_node_create",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ id: "crq_1", status: "in_review" }),
                    },
                    {
                      type: "text",
                      text: JSON.stringify({
                        id: "emb_1",
                        type: "change-request",
                        typeId: "crq_1",
                        active: true,
                        iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
                        autoPreview: true,
                      }),
                    },
                  ],
                },
              ],
            },
          },
        }),
      ].join("\n"),
    );

    const evidence = await collectSessionEvidence(root, "busabase");
    expect(evidence.usedSkillTool).toBe(true);
    expect(evidence.loadedBusabaseAppCreatorSkill).toBe(true);
    expect(evidence.calledBusabaseMcpTool).toBe(true);
    expect(evidence.calledChangeRequestMutationTool).toBe(true);
    expect(evidence.mcpAirAppCreateSlugs).toEqual(["dsh-e2e-1"]);
    expect(evidence.mcpChangeRequestIds).toEqual(["crq_1"]);
    expect(evidence.mcpPreviewProvenance).toEqual([
      {
        toolName: "mcp__busabase__node_create",
        callId: "call_node_create",
        changeRequestId: "crq_1",
        embedLinkId: "emb_1",
        iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
      },
    ]);
    expect(evidence.sessionFiles).toHaveLength(1);
  });

  it("does not claim provenance when the embed belongs to another ChangeRequest", async () => {
    const sessionDir = join(root, "project-a", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "tool/call",
          data: { name: "mcp__busabase__bases_create_change_request", callId: "call_base" },
        }),
        JSON.stringify({
          type: "tool/result",
          data: {
            message: {
              source: { kind: "tool", callId: "call_base" },
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call_base",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ id: "crq_record", status: "in_review" }),
                    },
                    {
                      type: "text",
                      text: JSON.stringify({
                        id: "emb_wrong",
                        type: "change-request",
                        typeId: "crq_other",
                        active: true,
                        iframeUrl: "http://localhost/embed/emb_wrong?token=secret&view=iframe",
                        autoPreview: true,
                      }),
                    },
                  ],
                },
              ],
            },
          },
        }),
      ].join("\n"),
    );

    await expect(collectSessionEvidence(root, "busabase")).resolves.toMatchObject({
      mcpChangeRequestIds: ["crq_record"],
      mcpPreviewProvenance: [],
    });
  });

  it("does not flag MCP evidence for a differently-named server", async () => {
    const sessionDir = join(root, "project-a", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.jsonl"),
      JSON.stringify({ type: "tool/call", data: { name: "mcp__other__search" } }),
    );

    const evidence = await collectSessionEvidence(root, "busabase");
    expect(evidence.calledBusabaseMcpTool).toBe(false);
  });

  it("fails clearly when the profile wrote compressed evidence", async () => {
    const sessionDir = join(root, "project-a", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.jsonl.zstd"), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));

    await expect(collectSessionEvidence(root, "busabase")).rejects.toThrow(
      /cannot verify DSH tool evidence from compressed session/,
    );
  });
});
