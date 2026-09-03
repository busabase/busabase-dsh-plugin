import { createServer } from "node:net";

/**
 * Binds to loopback on port 0 to obtain a kernel-assigned free port, then
 * releases the socket immediately so the caller's own process can use it.
 * Small race window (TOCTOU) is inherent to this technique; acceptable for
 * spawning a short-lived local test server, never for security boundaries.
 */
export async function allocateLoopbackPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close((closeError?: Error) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}
