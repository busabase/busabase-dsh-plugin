import { describe, expect, it } from "vitest";
import { BUSABASE_SYSTEM_PROMPT } from "./prompt.js";

/**
 * The system prompt is the first thing a DeepSeek Harness agent reads about Busabase, so it has to
 * say what Busabase is with the same category line as the bundled skill and the MCP instructions.
 * The shared parity test lives in an open-source package that cannot import this app, so the
 * plugin carries its own copy of the check.
 */
describe("BUSABASE_SYSTEM_PROMPT", () => {
  it("says what Busabase is with the category line", () => {
    expect(BUSABASE_SYSTEM_PROMPT).toContain("open-source database and workspace for AI agents");
  });

  it("no longer carries the superseded framing", () => {
    expect(BUSABASE_SYSTEM_PROMPT).not.toMatch(/apps? library|skills? registry/i);
    expect(BUSABASE_SYSTEM_PROMPT).not.toMatch(/approval[- ]first/i);
    expect(BUSABASE_SYSTEM_PROMPT).not.toMatch(/a workspace for structured data/i);
  });

  it("still tells the agent it can only propose", () => {
    expect(BUSABASE_SYSTEM_PROMPT).toContain("propose but never merge");
  });
});
