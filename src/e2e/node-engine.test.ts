import { describe, expect, it } from "vitest";
import { checkNodeEngine } from "./node-engine.js";

describe("checkNodeEngine", () => {
  it("passes when the running version satisfies the minimum", () => {
    expect(checkNodeEngine(">=24.18.0", "v24.18.0")).toMatchObject({ ok: true });
    expect(checkNodeEngine(">=24.18.0", "v24.19.2")).toMatchObject({ ok: true });
    expect(checkNodeEngine(">=24.18.0", "v25.0.0")).toMatchObject({ ok: true });
  });

  it("fails with an explicit reason when the running version is older", () => {
    const result = checkNodeEngine(">=24.18.0", "v24.15.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/24\.15\.0/);
    expect(result.reason).toMatch(/>=24\.18\.0/);
  });

  it("fails on an unparseable actual version instead of throwing", () => {
    const result = checkNodeEngine(">=24.18.0", "not-a-version");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unparseable/);
  });

  it("fails on an unsupported requirement syntax instead of throwing", () => {
    const result = checkNodeEngine("^24.18.0", "v24.18.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsupported/);
  });

  it("compares patch versions correctly at equal minor/major", () => {
    expect(checkNodeEngine(">=24.18.9", "v24.18.8").ok).toBe(false);
    expect(checkNodeEngine(">=24.18.9", "v24.18.9").ok).toBe(true);
  });
});
