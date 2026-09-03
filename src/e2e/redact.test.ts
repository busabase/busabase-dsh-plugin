import { describe, expect, it } from "vitest";
import { createSecretRedactor } from "./redact.js";

describe("createSecretRedactor", () => {
  it("replaces every occurrence of a secret value", () => {
    const redact = createSecretRedactor(["sk-super-secret-key"]);
    expect(redact("key=sk-super-secret-key and again sk-super-secret-key")).toBe(
      "key=[REDACTED] and again [REDACTED]",
    );
  });

  it("ignores undefined and too-short values instead of over-redacting", () => {
    const redact = createSecretRedactor([undefined, "", "ab"]);
    expect(redact("ab normal text ab")).toBe("ab normal text ab");
  });

  it("redacts multiple distinct secrets in one pass", () => {
    const redact = createSecretRedactor(["secret-one", "secret-two"]);
    expect(redact("secret-one then secret-two")).toBe("[REDACTED] then [REDACTED]");
  });

  it("leaves unrelated text untouched", () => {
    const redact = createSecretRedactor(["sk-super-secret-key"]);
    expect(redact("no secrets in this line")).toBe("no secrets in this line");
  });
});
