import { describe, expect, it } from "vitest";
import { buildMinimalAirAppFiles, checkCanonicalAirAppShape } from "./airapp-fixture.js";

describe("buildMinimalAirAppFiles", () => {
  it("produces a package.json with a plain-node dev script and no dependencies", () => {
    const files = buildMinimalAirAppFiles("dsh-e2e-abc123");
    const packageJson = files.find((file) => file.path === "package.json");
    if (!packageJson) throw new Error("fixture did not include package.json");
    const parsed = JSON.parse(packageJson.content) as Record<string, unknown>;
    expect(parsed.name).toBe("dsh-e2e-abc123");
    expect((parsed.scripts as Record<string, string>).dev).toBe("node server.js");
    expect(parsed.dependencies).toBeUndefined();
  });

  it("produces a server.js that boots a plain node:http server on process.env.PORT", () => {
    const files = buildMinimalAirAppFiles("dsh-e2e-abc123");
    const serverJs = files.find((file) => file.path === "server.js");
    expect(serverJs?.content).toContain('from "node:http"');
    expect(serverJs?.content).toContain("process.env.PORT");
    expect(serverJs?.content).toContain('"content-type": "text/html; charset=utf-8"');
    expect(serverJs?.content).toContain("AirApp is running.");
    expect(serverJs?.content).not.toMatch(/vite|next|react-native/i);
  });

  it("satisfies its own canonical-shape check", () => {
    const files = buildMinimalAirAppFiles("dsh-e2e-abc123");
    const packageJson = files.find((file) => file.path === "package.json");
    if (!packageJson) throw new Error("fixture did not include package.json");
    expect(checkCanonicalAirAppShape(packageJson.content)).toMatchObject({ ok: true, reasons: [] });
  });
});

describe("checkCanonicalAirAppShape", () => {
  it("rejects a Vite/Next-based package.json", () => {
    const result = checkCanonicalAirAppShape(
      JSON.stringify({
        scripts: { dev: "vite" },
        dependencies: { vite: "5.0.0", react: "18.0.0" },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/plain Node server/);
    expect(result.reasons.join(" ")).toMatch(/vite/);
  });

  it("rejects a package.json with a native dependency", () => {
    const result = checkCanonicalAirAppShape(
      JSON.stringify({
        scripts: { dev: "node server.js" },
        dependencies: { "node-gyp-build": "1.0.0" },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/disallowed dependencies/);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(checkCanonicalAirAppShape("not json").ok).toBe(false);
  });

  it("accepts a minimal plain-node package.json", () => {
    const result = checkCanonicalAirAppShape(
      JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: {} }),
    );
    expect(result).toEqual({ ok: true, reasons: [] });
  });
});
