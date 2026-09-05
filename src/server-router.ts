import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createChangeRequestPreviewLink,
  createNodePreviewLink,
  type EmbedLinksClient,
} from "./preview-link.js";
import type { BusabaseServerSupervisor } from "./server-supervisor.js";

const PROXY_PREFIX = "/busabase-api/proxy";

interface BusabaseServerRouterOptions {
  supervisor?: BusabaseServerSupervisor;
  baseUrl?: string;
  previewClient?: (spaceId?: string) => EmbedLinksClient;
}

export function createBusabaseServerRouter({
  supervisor,
  baseUrl,
  previewClient,
}: BusabaseServerRouterOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    if (supervisor && request.method === "GET" && pathname === "/busabase-api/server/status") {
      sendJson(response, 200, await supervisor.status());
      return;
    }
    if (supervisor && request.method === "POST" && pathname === "/busabase-api/server/start") {
      const result = await supervisor.ensure();
      sendJson(response, result.ok ? 200 : 503, result);
      return;
    }
    const previewMatch = pathname.match(
      /^\/busabase-api\/previews\/(nodes|change-requests)\/([^/]+)$/,
    );
    if (request.method === "POST" && previewMatch) {
      if (!previewClient || !isSameOriginBrowserRequest(request)) {
        sendJson(response, 403, { error: "Inspector preview request rejected" });
        return;
      }
      try {
        const ready = await supervisor?.ensure();
        if (ready && !ready.ok) {
          sendJson(response, 503, ready);
          return;
        }
        const id = decodeURIComponent(previewMatch[2] ?? "");
        const client = previewClient(url.searchParams.get("spaceId") ?? undefined);
        const create =
          previewMatch[1] === "nodes" ? createNodePreviewLink : createChangeRequestPreviewLink;
        sendJson(response, 200, await create(client, id));
      } catch {
        sendJson(response, 502, {
          error:
            "Could not create the Busabase preview. Check the connection and Space permissions.",
        });
      }
      return;
    }
    if (pathname.startsWith(`${PROXY_PREFIX}/`)) {
      if (!supervisor || !baseUrl || !isSameOriginBrowserRequest(request)) {
        sendJson(response, 403, { error: "Inspector proxy request rejected" });
        return;
      }
      const targetPath = pathname.slice(PROXY_PREFIX.length);
      if (!isAllowedInspectorRequest(request.method, targetPath)) {
        sendJson(response, 404, { error: "Inspector proxy route not found" });
        return;
      }
      const ready = await supervisor.ensure();
      if (!ready.ok) {
        sendJson(response, 503, ready);
        return;
      }
      await proxyInspectorRequest(request, response, baseUrl, targetPath);
      return;
    }
    response.writeHead(404);
    response.end();
  };
}

export function isAllowedInspectorRequest(method: string | undefined, pathname: string): boolean {
  if (method === "GET")
    return [
      /^\/api\/v1\/change-requests\/[^/]+$/,
      /^\/api\/v1\/(?:nodes|bases|records)\/[^/]+$/,
      /^\/api\/v1\/forms\/[^/]+$/,
      /^\/api\/v1\/nodes\/search$/,
    ].some((pattern) => pattern.test(pathname));
  if (method === "POST")
    return (
      ["/api/v1/change-requests/reviews", "/api/v1/change-requests/merge"].includes(pathname) ||
      /^\/api\/v1\/change-requests\/[^/]+\/close$/.test(pathname)
    );
  return false;
}

function isSameOriginBrowserRequest(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== "same-origin") return false;
  const origin = request.headers.origin;
  const host = request.headers.host;
  // Fetch does not normally send Origin on same-origin GET/HEAD requests.
  // Sec-Fetch-Site is the browser-authenticated signal for those safe reads;
  // mutations still require an exact Origin/Host match for CSRF protection.
  if (!origin) return request.method === "GET" || request.method === "HEAD";
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function proxyInspectorRequest(
  request: IncomingMessage,
  response: ServerResponse,
  busabaseBaseUrl: string,
  targetPath: string,
): Promise<void> {
  const sourceUrl = new URL(request.url ?? "/", "http://localhost");
  const target = new URL(targetPath, busabaseBaseUrl);
  target.search = sourceUrl.search;
  const body = request.method === "GET" ? undefined : await readBody(request);
  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      accept:
        typeof request.headers.accept === "string" ? request.headers.accept : "application/json",
      ...(typeof request.headers["content-type"] === "string"
        ? { "content-type": request.headers["content-type"] }
        : {}),
    },
    body: body?.toString("utf8"),
  });
  const contentType = upstream.headers.get("content-type");
  response.writeHead(upstream.status, {
    ...(contentType ? { "content-type": contentType } : {}),
    "cache-control": "no-store",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_000_000) {
        reject(new Error("Inspector proxy body exceeds 1 MB"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
