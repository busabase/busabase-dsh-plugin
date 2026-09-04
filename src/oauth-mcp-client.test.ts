// @vitest-environment node

import { createServer } from "node:http";
import {
  type CredentialKey,
  type CredentialRecord,
  credentialKey,
} from "@deepseek-ai/dsh-credentials";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.fn().mockResolvedValue(undefined);
vi.mock("open", () => ({ default: openMock }));

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setNotificationHandler: ReturnType<typeof vi.fn>;
  onclose?: () => void;
}

interface ProviderLike {
  redirectUrl: string;
  clientInformation(): Promise<unknown>;
  saveClientInformation(clientInformation: unknown): Promise<void>;
  state(): string;
  tokens(): Promise<unknown>;
  redirectToAuthorization(url: URL): void;
}

const clientInstances: FakeClient[] = [];
const transportInstances: Array<{
  authProvider: ProviderLike;
  options: Record<string, unknown>;
  finishAuth: ReturnType<typeof vi.fn>;
}> = [];

function fakeClient(): FakeClient {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    setNotificationHandler: vi.fn(),
    onclose: undefined,
  };
  clientInstances.push(client);
  return client;
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => fakeClient()),
}));

class FakeUnauthorizedError extends Error {}
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: FakeUnauthorizedError,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi
    .fn()
    .mockImplementation((_url: URL, options: Record<string, unknown>) => {
      const transport = {
        authProvider: options.authProvider as ProviderLike,
        options,
        finishAuth: vi.fn().mockResolvedValue(undefined),
      };
      transportInstances.push(transport);
      return transport;
    }),
}));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const {
  busabaseOAuthCredentialKey,
  connectRemoteMcp,
  DshCredentialOAuthClientProvider,
  publicToolName,
} = await import("./oauth-mcp-client.js");

beforeEach(() => {
  clientInstances.length = 0;
  transportInstances.length = 0;
  (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => fakeClient());
  (StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_url: URL, options: Record<string, unknown>) => {
      const transport = {
        authProvider: options.authProvider as ProviderLike,
        options,
        finishAuth: vi.fn().mockResolvedValue(undefined),
      };
      transportInstances.push(transport);
      return transport;
    },
  );
  openMock.mockResolvedValue(undefined);
});

function createFakeCredentialStore() {
  const records = new Map<CredentialKey, CredentialRecord>();
  return {
    records,
    readRecord: vi.fn(async (key: CredentialKey) => records.get(key)),
    modifyRecord: vi.fn(
      async (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const current = records.get(key);
        const next = await mutate(current);
        if (next !== undefined) records.set(key, next);
        return next ?? current;
      },
    ),
    deleteRecord: vi.fn(async (key: CredentialKey) => {
      records.delete(key);
    }),
  };
}

async function listenOnRandomLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("failed to allocate a loopback test port");
  }
  return { port: address.port, server };
}

function closeTestServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("publicToolName", () => {
  it("keeps ordinary MCP names stable", () => {
    expect(publicToolName("busabase", "search")).toBe("mcp__busabase__search");
  });

  it("adds a stable hash when normalization is lossy", () => {
    const first = publicToolName("busabase", "weird name!");
    expect(first).toMatch(/^mcp__busabase__weird_name__[0-9a-f]{12}$/);
    expect(publicToolName("busabase", "weird name!")).toBe(first);
    expect(publicToolName("busabase", "weird.name?")).not.toBe(first);
  });

  it("stays within the model's 64-character ceiling", () => {
    expect(publicToolName("busabase", "a".repeat(80))).toHaveLength(64);
  });
});

describe("busabaseOAuthCredentialKey", () => {
  it("is stable and valid for one exact MCP resource", () => {
    const key = busabaseOAuthCredentialKey("https://busabase.example/api/mcp");
    expect(key).toBe(credentialKey("busabase-dsh-plugin", key.split("/")[1] ?? ""));
    expect(key).toMatch(/^busabase-dsh-plugin\/cloud-[0-9a-f]{16}$/);
    expect(busabaseOAuthCredentialKey("https://busabase.example/api/mcp")).toBe(key);
  });

  it("does not mix credentials across resources or namespaces", () => {
    const key = busabaseOAuthCredentialKey("https://busabase.example/api/mcp");
    expect(busabaseOAuthCredentialKey("https://busabase.example/other")).not.toBe(key);
    expect(busabaseOAuthCredentialKey("https://busabase.example/api/mcp", "other")).not.toBe(key);
  });
});

describe("DshCredentialOAuthClientProvider", () => {
  const key = credentialKey("busabase-dsh-plugin", "cloud-test");
  const resourceUrl = "https://busabase.example/api/mcp";
  const callbackUrl = "http://127.0.0.1:51000/callback";

  function createProvider() {
    const store = createFakeCredentialStore();
    const provider = new DshCredentialOAuthClientProvider(
      store,
      key,
      resourceUrl,
      51000,
      "Busabase (test)",
    );
    return { store, provider };
  }

  it("declares a public authorization-code client and validates its state", () => {
    const { provider } = createProvider();
    expect(provider.redirectUrl).toBe(callbackUrl);
    expect(provider.clientMetadata).toMatchObject({
      client_name: "Busabase (test)",
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    const state = provider.state();
    expect(provider.matchesState(state)).toBe(true);
    expect(provider.matchesState("wrong-state")).toBe(false);
  });

  it("atomically round-trips client information and tokens", async () => {
    const { store, provider } = createProvider();
    const clientInformation = { client_id: "client-123", redirect_uris: [callbackUrl] } as never;
    const tokens = { access_token: "at", refresh_token: "rt", token_type: "bearer" } as never;
    await provider.saveClientInformation(clientInformation);
    await provider.saveTokens(tokens);
    expect(await provider.clientInformation()).toEqual(clientInformation);
    expect(await provider.tokens()).toEqual(tokens);
    expect(store.modifyRecord).toHaveBeenCalledTimes(2);
    expect(store.records.values().next().value).toMatchObject({
      kind: "grant",
      payload: { resourceUrl, callbackPort: 51000 },
    });
  });

  it("invalidates only the credential scope requested by the SDK", async () => {
    const { provider } = createProvider();
    const clientInformation = { client_id: "client-123" } as never;
    const tokens = { access_token: "at", token_type: "bearer" } as never;
    await provider.saveClientInformation(clientInformation);
    await provider.saveTokens(tokens);
    provider.saveCodeVerifier("verifier");

    await provider.invalidateCredentials("tokens");
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toEqual(clientInformation);
    await provider.invalidateCredentials("verifier");
    expect(() => provider.codeVerifier()).toThrow(/PKCE/);
    await provider.invalidateCredentials("all");
    expect(await provider.clientInformation()).toBeUndefined();
  });

  it("clears a rejected client registration and its tokens while preserving the callback port", async () => {
    const { store, provider } = createProvider();
    await provider.saveClientInformation({ client_id: "client-123" } as never);
    await provider.saveTokens({ access_token: "at", token_type: "bearer" } as never);

    await provider.invalidateClientRegistration();

    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
    expect(store.records.values().next().value).toMatchObject({
      kind: "grant",
      payload: { resourceUrl, callbackPort: 51000 },
    });
  });
});

describe("connectRemoteMcp", () => {
  const config = {
    serverName: "busabase",
    mcpUrl: "https://busabase.example/api/mcp",
  } as never;

  function fakeCtx() {
    const definitions: Array<Record<string, unknown>> = [];
    const activeDefinitions = new Map<string, Record<string, unknown>>();
    return {
      definitions,
      activeDefinitions,
      ctx: {
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        tools: {
          register: vi.fn((definition: Record<string, unknown>) => {
            definitions.push(definition);
            const name = String(definition.name);
            activeDefinitions.set(name, definition);
            return vi.fn(() => activeDefinitions.delete(name));
          }),
        },
      } as never,
    };
  }

  it("registers remote tools with the local result and cancellation contract", async () => {
    const { ctx, definitions } = fakeCtx();
    const client = fakeClient();
    const inputSchema = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        sources: {
          anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
        },
      },
      required: ["query"],
      additionalProperties: false,
    };
    client.listTools.mockResolvedValue({
      tools: [{ name: "search", description: "Search", inputSchema }],
    });
    client.callTool.mockResolvedValue({
      content: [{ type: "text", text: "found" }],
      structuredContent: { count: 1 },
    });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    await expect(handle.ready).resolves.toEqual({});
    expect(definitions[0]).toMatchObject({
      name: "mcp__busabase__search",
      parameters: inputSchema,
      timeoutMs: 60_000,
    });
    const signal = new AbortController().signal;
    await expect(
      (definitions[0]?.execute as (args: unknown, execution: unknown) => Promise<unknown>)(
        { query: "x" },
        { signal },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "found" }],
      structuredContent: { count: 1 },
    });
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "x" } },
      undefined,
      { signal, timeout: 60_000 },
    );
    expect(transportInstances[0]?.options).toMatchObject({
      requestInit: {
        headers: { "x-busabase-relay-permission-level": "changeRequest" },
      },
    });
    await handle.dispose();
  });

  it("mints a ChangeRequest embed link by reusing the current authenticated Client", async () => {
    const { ctx } = fakeCtx();
    const client = fakeClient();
    client.listTools.mockResolvedValue({ tools: [] });
    client.callTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        id: "emb_1",
        typeId: "crq_1",
        url: "https://busabase.example/embed/emb_1",
        iframeUrl: "https://busabase.example/embed/emb_1?view=iframe",
      },
    });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    await expect(handle.ready).resolves.toEqual({});
    const signal = new AbortController().signal;
    await expect(handle.createChangeRequestEmbedLink("crq_1", "spc_1", signal)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        id: "emb_1",
        typeId: "crq_1",
        url: "https://busabase.example/embed/emb_1",
        iframeUrl: "https://busabase.example/embed/emb_1?view=iframe",
      },
    });
    expect(client.callTool).toHaveBeenCalledWith(
      {
        name: "embed_links_create",
        arguments: {
          type: "change-request",
          typeId: "crq_1",
          framePolicy: { mode: "anywhere", allowedOrigins: [] },
          targetSpaceId: "spc_1",
        },
      },
      undefined,
      { signal, timeout: 60_000 },
    );
    await handle.dispose();
  });

  it("omits targetSpaceId from the embed link call when none is provided", async () => {
    const { ctx } = fakeCtx();
    const client = fakeClient();
    client.listTools.mockResolvedValue({ tools: [] });
    client.callTool.mockResolvedValue({ content: [], structuredContent: {} });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    await expect(handle.ready).resolves.toEqual({});
    await handle.createChangeRequestEmbedLink("crq_2", undefined, new AbortController().signal);
    expect(client.callTool).toHaveBeenCalledWith(
      {
        name: "embed_links_create",
        arguments: {
          type: "change-request",
          typeId: "crq_2",
          framePolicy: { mode: "anywhere", allowedOrigins: [] },
        },
      },
      undefined,
      expect.objectContaining({ timeout: 60_000 }),
    );
    await handle.dispose();
  });

  it("rejects minting an embed link once the handle has been disposed", async () => {
    const { ctx } = fakeCtx();
    const client = fakeClient();
    client.listTools.mockResolvedValue({ tools: [] });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    await expect(handle.ready).resolves.toEqual({});
    await handle.dispose();

    await expect(
      handle.createChangeRequestEmbedLink("crq_3", undefined, new AbortController().signal),
    ).rejects.toThrow(/no active Cloud MCP connection/);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("validates state, finishes auth, then reconnects with a fresh client and transport", async () => {
    const { ctx } = fakeCtx();
    const first = fakeClient();
    let expectedState = "";
    first.connect.mockImplementation(async () => {
      const provider = transportInstances[0]?.authProvider;
      expectedState = provider?.state() ?? "";
      provider?.redirectToAuthorization(
        new URL(`https://busabase.example/authorize?state=${encodeURIComponent(expectedState)}`),
      );
      throw new UnauthorizedError("auth required");
    });
    const second = fakeClient();
    (Client as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    openMock.mockImplementationOnce(async () => {
      const provider = transportInstances[0]?.authProvider;
      const response = await fetch(
        `${provider?.redirectUrl}?code=auth-code&state=${encodeURIComponent(expectedState)}`,
      );
      expect(response.status).toBe(200);
    });

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    await expect(handle.ready).resolves.toEqual({});
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0]?.finishAuth).toHaveBeenCalledWith("auth-code");
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.connect).toHaveBeenCalledOnce();
    await handle.dispose();
  });

  it("re-registers a persisted OAuth client when the authorization endpoint rejects it", async () => {
    const { ctx } = fakeCtx();
    const resourceUrl = new URL(config.mcpUrl).toString();
    const key = busabaseOAuthCredentialKey(resourceUrl, config.serverName);
    const callbackPort = 51_000;
    const callbackUrl = `http://127.0.0.1:${String(callbackPort)}/callback`;
    const store = createFakeCredentialStore();
    store.records.set(key, {
      kind: "grant",
      payload: {
        resourceUrl,
        callbackPort,
        clientInformation: { client_id: "forgotten-client", redirect_uris: [callbackUrl] },
        tokens: { access_token: "stale-at", token_type: "bearer" },
      },
    } as never);
    let expectedState = "";
    const staleClient = fakeClient();
    staleClient.connect.mockImplementationOnce(async () => {
      const provider = transportInstances[0]?.authProvider;
      expectedState = provider?.state() ?? "";
      provider?.redirectToAuthorization(
        new URL(`https://busabase.example/authorize?state=${encodeURIComponent(expectedState)}`),
      );
      throw new UnauthorizedError("auth required");
    });
    const registeredClient = fakeClient();
    registeredClient.connect.mockImplementationOnce(async () => {
      const provider = transportInstances[1]?.authProvider;
      await expect(provider?.clientInformation()).resolves.toBeUndefined();
      await expect(provider?.tokens()).resolves.toBeUndefined();
      await provider?.saveClientInformation({
        client_id: "fresh-client",
        redirect_uris: [callbackUrl],
      });
      expectedState = provider?.state() ?? "";
      provider?.redirectToAuthorization(
        new URL(`https://busabase.example/authorize?state=${encodeURIComponent(expectedState)}`),
      );
      throw new UnauthorizedError("auth required");
    });
    const connectedClient = fakeClient();
    (Client as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => staleClient)
      .mockImplementationOnce(() => registeredClient)
      .mockImplementationOnce(() => connectedClient);
    let resolveCallback!: (code: string) => void;
    const callbackCode = new Promise<string>((resolve) => {
      resolveCallback = resolve;
    });
    openMock.mockImplementationOnce(async () => {
      resolveCallback("auth-code");
    });
    const preflight = vi
      .fn<() => Promise<"accepted" | "invalid-client">>()
      .mockResolvedValueOnce("invalid-client")
      .mockResolvedValueOnce("accepted");

    const handle = connectRemoteMcp(
      ctx,
      config,
      store,
      async (preferredPort) => {
        expect(preferredPort).toBe(callbackPort);
        return {
          port: callbackPort,
          redirectUrl: callbackUrl,
          waitForCode: vi.fn(async (state) => {
            expect(state).toBe(expectedState);
            return callbackCode;
          }),
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
      preflight,
    );
    await expect(handle.ready).resolves.toEqual({});

    expect(preflight).toHaveBeenCalledTimes(2);
    expect(staleClient.close).toHaveBeenCalledOnce();
    expect(transportInstances[1]?.finishAuth).toHaveBeenCalledWith("auth-code");
    expect(connectedClient.connect).toHaveBeenCalledOnce();
    expect(store.records.get(key)).toMatchObject({
      payload: {
        callbackPort,
        clientInformation: { client_id: "fresh-client" },
      },
    });
    expect(store.records.get(key)).not.toMatchObject({
      payload: { tokens: { access_token: "stale-at" } },
    });
    await handle.dispose();
  });

  it("rejects a callback with the wrong OAuth state", async () => {
    const { ctx } = fakeCtx();
    const first = fakeClient();
    first.connect.mockImplementation(async () => {
      const provider = transportInstances[0]?.authProvider;
      const state = provider?.state();
      provider?.redirectToAuthorization(
        new URL(`https://busabase.example/authorize?state=${encodeURIComponent(state ?? "")}`),
      );
      throw new UnauthorizedError("auth required");
    });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => first);
    openMock.mockImplementationOnce(async () => {
      const response = await fetch(
        `${transportInstances[0]?.authProvider.redirectUrl}?code=auth-code&state=wrong`,
      );
      expect(response.status).toBe(400);
    });

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    const result = await handle.ready;
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/invalid OAuth state/);
    expect(transportInstances[0]?.finishAuth).not.toHaveBeenCalled();
    await handle.dispose();
  });

  it("loads the persisted client and tokens on the same loopback port after a DSH restart without a browser prompt", async () => {
    const { ctx } = fakeCtx();
    const resourceUrl = new URL(config.mcpUrl).toString();
    const key = busabaseOAuthCredentialKey(resourceUrl, config.serverName);
    const callbackPort = 51_000;
    const callbackUrl = `http://127.0.0.1:${String(callbackPort)}/callback`;
    const clientInformation = {
      client_id: "client-123",
      redirect_uris: [callbackUrl],
    };
    const tokens = { access_token: "at", refresh_token: "rt", token_type: "bearer" };
    const store = createFakeCredentialStore();
    store.records.set(key, {
      kind: "grant",
      payload: {
        resourceUrl,
        callbackPort,
        clientInformation,
        tokens,
      },
    } as never);

    const client = fakeClient();
    client.connect.mockImplementationOnce(async () => {
      const provider = transportInstances[0]?.authProvider;
      expect(provider?.redirectUrl).toBe(callbackUrl);
      await expect(provider?.clientInformation()).resolves.toEqual(clientInformation);
      await expect(provider?.tokens()).resolves.toEqual(tokens);
    });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);
    const closeCallback = vi.fn().mockResolvedValue(undefined);
    const createCallback = vi.fn(async (preferredPort: number) => {
      expect(preferredPort).toBe(callbackPort);
      return {
        port: callbackPort,
        redirectUrl: callbackUrl,
        waitForCode: vi.fn(),
        close: closeCallback,
      };
    });

    const handle = connectRemoteMcp(ctx, config, store, createCallback);
    await expect(handle.ready).resolves.toEqual({});

    expect(createCallback).toHaveBeenCalledOnce();
    expect(closeCallback).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(openMock).not.toHaveBeenCalled();
    expect(transportInstances).toHaveLength(1);
    expect(store.deleteRecord).not.toHaveBeenCalled();
    expect(store.modifyRecord).not.toHaveBeenCalled();
    expect(store.records.get(key)).toMatchObject({ payload: { clientInformation, tokens } });
    await handle.dispose();
  });

  it("discards the stale grant and re-registers when the preferred loopback port is unavailable", async () => {
    const { ctx } = fakeCtx();
    const resourceUrl = new URL(config.mcpUrl).toString();
    const key = busabaseOAuthCredentialKey(resourceUrl, config.serverName);
    const blocker = await listenOnRandomLoopbackPort();
    const stalePort = blocker.port;
    const store = createFakeCredentialStore();
    store.records.set(key, {
      kind: "grant",
      payload: {
        resourceUrl,
        callbackPort: stalePort,
        clientInformation: {
          client_id: "stale-client",
          redirect_uris: [`http://127.0.0.1:${String(stalePort)}/callback`],
        },
        tokens: { access_token: "stale-at", token_type: "bearer" },
      },
    } as never);

    try {
      const first = fakeClient();
      let expectedState = "";
      first.connect.mockImplementation(async () => {
        const provider = transportInstances[0]?.authProvider;
        expect(provider?.redirectUrl).not.toContain(`:${String(stalePort)}/`);
        await expect(provider?.clientInformation()).resolves.toBeUndefined();
        await expect(provider?.tokens()).resolves.toBeUndefined();
        await provider?.saveClientInformation({
          client_id: "fresh-client",
          redirect_uris: [provider.redirectUrl],
        });
        expectedState = provider?.state() ?? "";
        provider?.redirectToAuthorization(
          new URL(`https://busabase.example/authorize?state=${encodeURIComponent(expectedState)}`),
        );
        throw new UnauthorizedError("auth required");
      });
      const second = fakeClient();
      (Client as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => first)
        .mockImplementationOnce(() => second);
      openMock.mockImplementationOnce(async () => {
        const provider = transportInstances[0]?.authProvider;
        await fetch(
          `${provider?.redirectUrl}?code=fresh-code&state=${encodeURIComponent(expectedState)}`,
        );
      });

      const handle = connectRemoteMcp(ctx, config, store);
      await expect(handle.ready).resolves.toEqual({});
      expect(store.deleteRecord).toHaveBeenCalledWith(key);
      expect(openMock).toHaveBeenCalledOnce();
      expect(transportInstances).toHaveLength(2);
      expect(transportInstances[0]?.finishAuth).toHaveBeenCalledWith("fresh-code");
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.connect).toHaveBeenCalledOnce();
      expect(store.records.get(key)).toMatchObject({
        payload: {
          resourceUrl,
          callbackPort: Number(new URL(transportInstances[0]?.authProvider.redirectUrl ?? "").port),
          clientInformation: {
            client_id: "fresh-client",
            redirect_uris: [transportInstances[0]?.authProvider.redirectUrl],
          },
        },
      });
      expect(store.records.get(key)).not.toMatchObject({
        payload: { tokens: { access_token: "stale-at" } },
      });
      await handle.dispose();
    } finally {
      await closeTestServer(blocker.server);
    }
  });

  it("does not report ready when the MCP generation closes as connect settles", async () => {
    const { ctx, activeDefinitions } = fakeCtx();
    const client = fakeClient();
    client.connect.mockImplementationOnce(async () => {
      client.onclose?.();
    });
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());

    await expect(handle.ready).resolves.toEqual({ error: expect.any(Error) });
    expect(client.listTools).not.toHaveBeenCalled();
    expect(activeDefinitions.size).toBe(0);
    await handle.dispose();
  });

  it("does not leave tools registered when a generation closes during synchronization", async () => {
    const { ctx, activeDefinitions } = fakeCtx();
    const client = fakeClient();
    let resolveTools: (value: { tools: RemoteToolFixture[] }) => void = () => {};
    client.listTools.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTools = resolve;
      }),
    );
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => client);

    const handle = connectRemoteMcp(ctx, config, createFakeCredentialStore());
    await vi.waitFor(() => expect(client.listTools).toHaveBeenCalledOnce());
    client.onclose?.();
    resolveTools({
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    });

    await expect(handle.ready).resolves.toEqual({ error: expect.any(Error) });
    expect(activeDefinitions.size).toBe(0);
    await handle.dispose();
  });
});

interface RemoteToolFixture {
  name: string;
  description: string;
  inputSchema: { type: "object" };
}
