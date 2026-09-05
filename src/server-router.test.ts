import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createBusabaseServerRouter, isAllowedInspectorRequest } from "./server-router.js";

function responseRecorder() {
  const response = new EventEmitter() as EventEmitter & {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    writeHead: (status: number, headers?: Record<string, string>) => void;
    end: (body?: string) => void;
  };
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers;
  };
  response.end = (body) => {
    response.body = body;
    response.emit("finish");
  };
  return response;
}

describe("Busabase server router", () => {
  it("does not expose local server controls or the API proxy through a Cloud-only router", async () => {
    const previewClient = vi.fn();
    const router = createBusabaseServerRouter({ previewClient });
    for (const [method, url, status] of [
      ["GET", "/busabase-api/server/status", 404],
      ["POST", "/busabase-api/server/start", 404],
      ["POST", "/busabase-api/proxy/api/v1/change-requests/merge", 403],
      ["GET", "/busabase-api/previews/change-requests/cr_1", 404],
    ] as const) {
      const response = responseRecorder();
      await router(
        {
          method,
          url,
          headers: {
            host: "localhost:3080",
            origin: "http://localhost:3080",
            "sec-fetch-site": "same-origin",
          },
        } as never,
        response as never,
      );
      expect(response.status).toBe(status);
    }
    expect(previewClient).not.toHaveBeenCalled();
  });
  it("restricts Cloud preview creation to same-origin POST and preserves the selected Space", async () => {
    const create = vi.fn().mockResolvedValue({ type: "change-request", typeId: "cr_1" });
    const previewClient = vi.fn(() => ({ embedLinks: { create } }));
    const router = createBusabaseServerRouter({ previewClient });
    for (const site of [undefined, "cross-site", "same-origin"]) {
      const response = responseRecorder();
      await router(
        {
          method: "POST",
          url: "/busabase-api/previews/change-requests/cr_1?spaceId=org_selected",
          headers: {
            host: "localhost:3080",
            origin: "http://localhost:3080",
            "sec-fetch-site": site,
          },
        } as never,
        response as never,
      );
      expect(response.status).toBe(site === "same-origin" ? 200 : 403);
    }
    expect(previewClient).toHaveBeenCalledExactlyOnceWith("org_selected");
    expect(create).toHaveBeenCalledExactlyOnceWith({
      type: "change-request",
      typeId: "cr_1",
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
    });
    create.mockRejectedValue(new Error("private credential details"));
    const response = responseRecorder();
    await router(
      {
        method: "POST",
        url: "/busabase-api/previews/change-requests/cr_1",
        headers: {
          host: "localhost:3080",
          origin: "http://localhost:3080",
          "sec-fetch-site": "same-origin",
        },
      } as never,
      response as never,
    );
    expect(response.status).toBe(502);
    expect(response.body).not.toContain("private credential");
  });
  it("exposes status and start without accepting launch input", async () => {
    const supervisor = {
      status: vi
        .fn()
        .mockResolvedValue({ phase: "stopped", baseUrl: "http://localhost:15419", owned: false }),
      ensure: vi.fn().mockResolvedValue({
        ok: true,
        baseUrl: "http://localhost:15419",
        owned: true,
        reused: false,
      }),
    };
    const router = createBusabaseServerRouter({ supervisor: supervisor as never });

    const statusResponse = responseRecorder();
    await router(
      { method: "GET", url: "/busabase-api/server/status" } as never,
      statusResponse as never,
    );
    expect(statusResponse.status).toBe(200);
    expect(JSON.parse(statusResponse.body ?? "{}")).toMatchObject({ phase: "stopped" });

    const startResponse = responseRecorder();
    await router(
      { method: "POST", url: "/busabase-api/server/start", body: { command: "evil" } } as never,
      startResponse as never,
    );
    expect(startResponse.status).toBe(200);
    expect(supervisor.ensure).toHaveBeenCalledWith();
  });

  it("returns 503 when startup fails", async () => {
    const router = createBusabaseServerRouter({
      supervisor: {
        status: vi.fn(),
        ensure: vi.fn().mockResolvedValue({
          ok: false,
          baseUrl: "http://localhost:15419",
          owned: false,
          reason: "failed",
        }),
      } as never,
    });
    const response = responseRecorder();
    await router({ method: "POST", url: "/busabase-api/server/start" } as never, response as never);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({ ok: false, reason: "failed" });
  });

  it("proxies only same-origin Inspector API routes to the managed Busabase origin", async () => {
    const ensure = vi.fn().mockResolvedValue({ ok: true });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "cr_1", status: "approved" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const router = createBusabaseServerRouter({
      supervisor: { ensure } as never,
      baseUrl: "http://127.0.0.1:15419",
    });
    const request = Readable.from([JSON.stringify({ verdict: "approved" })]) as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      url: "/busabase-api/proxy/api/v1/change-requests/reviews?space=local",
      headers: {
        host: "127.0.0.1:4010",
        origin: "http://127.0.0.1:4010",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    });
    const response = fakeResponse();

    await router(request, response.value);

    expect(ensure).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:15419/api/v1/change-requests/reviews?space=local"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ verdict: "approved" }) }),
    );
    expect(response.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "content-type": "application/json" }),
    );
  });

  it("accepts same-origin Inspector reads without an Origin header", async () => {
    const ensure = vi.fn().mockResolvedValue({ ok: true });
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ id: "cr_1", status: "approved" }));
    vi.stubGlobal("fetch", fetchSpy);
    const router = createBusabaseServerRouter({
      supervisor: { ensure } as never,
      baseUrl: "http://127.0.0.1:15419",
    });
    const response = fakeResponse();

    await router(
      {
        method: "GET",
        url: "/busabase-api/proxy/api/v1/change-requests/cr_1",
        headers: { host: "127.0.0.1:4010", "sec-fetch-site": "same-origin" },
      } as never,
      response.value,
    );

    expect(ensure).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:15419/api/v1/change-requests/cr_1"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects same-origin mutations without an Origin header", async () => {
    const ensure = vi.fn();
    const router = createBusabaseServerRouter({
      supervisor: { ensure } as never,
      baseUrl: "http://127.0.0.1:15419",
    });
    const response = fakeResponse();

    await router(
      {
        method: "POST",
        url: "/busabase-api/proxy/api/v1/change-requests/reviews",
        headers: { host: "127.0.0.1:4010", "sec-fetch-site": "same-origin" },
      } as never,
      response.value,
    );

    expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(ensure).not.toHaveBeenCalled();
  });

  it("rejects cross-site and non-allowlisted Inspector proxy requests", async () => {
    const ensure = vi.fn();
    const router = createBusabaseServerRouter({
      supervisor: { ensure } as never,
      baseUrl: "http://127.0.0.1:15419",
    });
    const request = {
      method: "POST",
      url: "/busabase-api/proxy/api/v1/change-requests/reviews",
      headers: { "sec-fetch-site": "cross-site" },
    } as IncomingMessage;
    const response = fakeResponse();
    await router(request, response.value);
    expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(ensure).not.toHaveBeenCalled();
    expect(isAllowedInspectorRequest("DELETE", "/api/v1/nodes/nod_1")).toBe(false);
    expect(isAllowedInspectorRequest("POST", "/api/v1/nodes/purge")).toBe(false);
  });

  it("creates a Node preview through the trusted Host client", async () => {
    const ensure = vi.fn().mockResolvedValue({ ok: true });
    const create = vi.fn().mockResolvedValue({
      id: "emb_1",
      type: "node",
      typeId: "nod_1",
      url: "http://localhost:15419/embed/emb_1?token=secret",
      iframeUrl: "http://localhost:15419/embed/emb_1?token=secret&view=iframe",
    });
    const router = createBusabaseServerRouter({
      supervisor: { ensure } as never,
      baseUrl: "http://localhost:15419",
      previewClient: () => ({ embedLinks: { create } }),
    });
    const response = responseRecorder();
    await router(
      {
        method: "POST",
        url: "/busabase-api/previews/nodes/nod_1",
        headers: {
          host: "localhost:4010",
          origin: "http://localhost:4010",
          "sec-fetch-site": "same-origin",
        },
      } as never,
      response as never,
    );
    expect(create).toHaveBeenCalledWith({
      type: "node",
      typeId: "nod_1",
      framePolicy: { mode: "anywhere", allowedOrigins: [] },
    });
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({
      id: "emb_1",
      autoPreview: true,
    });
  });
});

function fakeResponse() {
  const writeHead = vi.fn();
  const end = vi.fn();
  return { writeHead, end, value: { writeHead, end } as unknown as ServerResponse };
}
