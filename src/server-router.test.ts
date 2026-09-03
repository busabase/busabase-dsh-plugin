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
    const router = createBusabaseServerRouter(supervisor as never);

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
      status: vi.fn(),
      ensure: vi.fn().mockResolvedValue({
        ok: false,
        baseUrl: "http://localhost:15419",
        owned: false,
        reason: "failed",
      }),
    } as never);
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
    const router = createBusabaseServerRouter({ ensure } as never, "http://127.0.0.1:15419");
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
    const router = createBusabaseServerRouter({ ensure } as never, "http://127.0.0.1:15419");
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
    const router = createBusabaseServerRouter({ ensure } as never, "http://127.0.0.1:15419");
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
    const router = createBusabaseServerRouter({ ensure } as never, "http://127.0.0.1:15419");
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
    const router = createBusabaseServerRouter({ ensure } as never, "http://localhost:15419", {
      embedLinks: { create } as never,
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
