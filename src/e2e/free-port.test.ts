import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { allocateLoopbackPort } from "./free-port.js";

describe("allocateLoopbackPort", () => {
  it("returns a bindable loopback port", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns distinct ports across concurrent calls", async () => {
    const ports = await Promise.all([
      allocateLoopbackPort(),
      allocateLoopbackPort(),
      allocateLoopbackPort(),
    ]);
    expect(new Set(ports).size).toBe(ports.length);
  });
});
