import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialKey, CredentialRecord } from "@deepseek-ai/dsh-credentials";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import type { JsonValue, ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedBusabasePluginConfig } from "./config.js";
import { createMcpEmbedClient } from "./mcp-embed-client.js";
import {
  createChangeRequestPreviewLink,
  createdChangeRequestId,
  type EmbedLinksClient,
} from "./preview-link.js";

/**
 * The version this plugin reports to an MCP server as its `clientInfo`.
 *
 * Kept as a literal rather than read from `package.json`: this file is bundled
 * by tsdown, and a runtime read of a path relative to the source would not
 * survive that. `oauth-mcp-client.test.ts` asserts it equals the manifest's
 * `version`, so the pair cannot drift silently — which it already had, the
 * manifest saying 0.1.1 while this said 0.1.0 and npm had shipped 0.1.5.
 */
export const PLUGIN_VERSION = "0.1.8";

// The OAuth flow follows the MIT-licensed MCP TypeScript SDK example and the
// architecture proven by springbrand-lab/dsh-oauth-mcp-client. DSH's built-in
// MCP bridge has no OAuth provider hook, so remote mode owns its transport and
// tool registrations while preserving the same public naming/result contract.

const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = Number.MAX_SAFE_INTEGER;
const AUTH_TIMEOUT_MS = 5 * 60_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

export interface McpResult<Structured extends JsonValue = JsonValue> {
  content: JsonValue[];
  structuredContent?: Structured;
}

interface OAuthGrantPayload {
  resourceUrl: string;
  callbackPort: number;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

interface CredentialStore {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>;
  deleteRecord(key: CredentialKey): Promise<void>;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  execution?: { taskSupport?: string };
}

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

interface OAuthCallbackServer {
  redirectUrl: string;
  port: number;
  waitForCode(expectedState: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

type AuthorizationUrlPreflight = (authorizationUrl: URL) => Promise<"accepted" | "invalid-client">;

/** Derive the model-facing name using DSH's `mcp__server__tool` contract. */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256")
    .update(`${serverName}\0${rawName}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** Scope durable OAuth state to one DSH namespace and exact MCP resource URL. */
export function busabaseOAuthCredentialKey(mcpUrl: string, serverName = "busabase"): CredentialKey {
  const resourceUrl = new URL(mcpUrl).toString();
  const resourceHash = createHash("sha256")
    .update(`${serverName}\0${resourceUrl}`)
    .digest("hex")
    .slice(0, 16);
  return credentialKey("busabase-dsh-plugin", `cloud-${resourceHash}`);
}

function grantPayload(
  record: CredentialRecord | undefined,
  resourceUrl: string,
): OAuthGrantPayload | undefined {
  if (record?.kind !== "grant" || !record.payload || typeof record.payload !== "object") return;
  const payload = record.payload as Partial<OAuthGrantPayload>;
  if (payload.resourceUrl !== resourceUrl || !Number.isInteger(payload.callbackPort)) return;
  return payload as OAuthGrantPayload;
}

/** OAuth provider backed by DSH's atomic, durable grant-record store. */
export class DshCredentialOAuthClientProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined;
  private pendingAuthorizationUrl: URL | undefined;
  private stateValue: string | undefined;

  constructor(
    private readonly credentials: CredentialStore,
    private readonly key: CredentialKey,
    private readonly resourceUrl: string,
    private readonly callbackPort: number,
    private readonly clientName: string,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${String(this.callbackPort)}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.stateValue = randomUUID();
    return this.stateValue;
  }

  matchesState(candidate: string | undefined): boolean {
    if (!candidate || !this.stateValue) return false;
    const expected = Buffer.from(this.stateValue);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return grantPayload(await this.credentials.readRecord(this.key), this.resourceUrl)
      ?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.updatePayload({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return grantPayload(await this.credentials.readRecord(this.key), this.resourceUrl)?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.updatePayload({ tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizationUrl = authorizationUrl;
  }

  takePendingAuthorizationUrl(): URL | undefined {
    const url = this.pendingAuthorizationUrl;
    this.pendingAuthorizationUrl = undefined;
    return url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error("no PKCE code verifier saved");
    return this.codeVerifierValue;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "verifier") {
      this.codeVerifierValue = undefined;
      return;
    }
    if (scope === "all") {
      await this.credentials.deleteRecord(this.key);
      this.codeVerifierValue = undefined;
      return;
    }
    await this.credentials.modifyRecord(this.key, async (current) => {
      const payload = grantPayload(current, this.resourceUrl);
      if (!payload) return current;
      const next = { ...payload };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      return { kind: "grant", payload: next };
    });
  }

  async invalidateClientRegistration(): Promise<void> {
    await this.credentials.modifyRecord(this.key, async (current) => {
      const payload = grantPayload(current, this.resourceUrl);
      if (!payload) return current;
      const next = { ...payload };
      delete next.clientInformation;
      delete next.tokens;
      return { kind: "grant", payload: next };
    });
  }

  private async updatePayload(update: Partial<OAuthGrantPayload>): Promise<void> {
    await this.credentials.modifyRecord(this.key, async (current) => ({
      kind: "grant",
      payload: {
        ...(grantPayload(current, this.resourceUrl) ?? {
          resourceUrl: this.resourceUrl,
          callbackPort: this.callbackPort,
        }),
        ...update,
      } satisfies OAuthGrantPayload,
    }));
  }
}

async function listenCallbackServer(preferredPort: number): Promise<OAuthCallbackServer> {
  let resolveResult!: (value: CallbackResult) => void;
  const result = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });
  let received = false;
  let closed = false;
  let callbackState: string | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    const callback = {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
    };
    const accepted =
      callbackState !== undefined &&
      !callback.error &&
      callback.code !== undefined &&
      constantTimeEqual(callback.state, callbackState);
    response.writeHead(accepted ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(
      accepted
        ? "<html><body>Busabase sign-in complete. You can close this window.</body></html>"
        : "<html><body>Busabase sign-in failed. You can close this window.</body></html>",
    );
    if (received) return;
    received = true;
    resolveResult(callback);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a loopback callback port");
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    await closeServer(server);
  };
  return {
    port: address.port,
    redirectUrl: `http://127.0.0.1:${String(address.port)}/callback`,
    async waitForCode(expectedState, signal) {
      callbackState = expectedState;
      if (signal.aborted) resolveResult({ error: "cancelled" });
      const timeout = setTimeout(() => resolveResult({ error: "timeout" }), AUTH_TIMEOUT_MS);
      timeout.unref?.();
      const abort = () => resolveResult({ error: "cancelled" });
      signal.addEventListener("abort", abort, { once: true });
      try {
        const callback = await result;
        if (callback.error === "timeout")
          throw new Error(`Busabase Cloud sign-in timed out after ${String(AUTH_TIMEOUT_MS)}ms`);
        if (callback.error === "cancelled") throw new Error("Busabase Cloud sign-in was cancelled");
        if (callback.error) throw new Error("Busabase Cloud sign-in was denied");
        if (!constantTimeEqual(callback.state, expectedState))
          throw new Error("Busabase Cloud sign-in returned an invalid OAuth state");
        if (!callback.code)
          throw new Error("Busabase Cloud sign-in returned no authorization code");
        return callback.code;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        await close();
      }
    },
    close,
  };
}

async function createCallbackServer(preferredPort: number): Promise<OAuthCallbackServer> {
  try {
    return await listenCallbackServer(preferredPort);
  } catch (error) {
    if (preferredPort === 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return listenCallbackServer(0);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function constantTimeEqual(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function preferredCallbackPort(
  credentials: CredentialStore,
  key: CredentialKey,
  resourceUrl: string,
): Promise<number> {
  return grantPayload(await credentials.readRecord(key), resourceUrl)?.callbackPort ?? 0;
}

async function openAuthorization(
  ctx: Pick<Context, "logger">,
  authorizationUrl: URL,
): Promise<void> {
  const open = (await import("open")).default;
  try {
    await open(authorizationUrl.toString());
  } catch (error) {
    ctx.logger.warn(
      `busabase cloud oauth: could not open a browser automatically (${String(error)}); open this URL to sign in: ${authorizationUrl.toString()}`,
    );
  }
}

async function preflightAuthorizationUrl(
  authorizationUrl: URL,
): Promise<"accepted" | "invalid-client"> {
  let response: Response;
  try {
    response = await fetch(authorizationUrl, {
      redirect: "manual",
      headers: { accept: "application/json, text/html;q=0.9" },
    });
  } catch {
    return "accepted";
  }
  if (response.status < 400) return "accepted";
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (
    response.status === 400 &&
    payload?.error === "invalid_request" &&
    payload.error_description === "Invalid OAuth authorization request"
  ) {
    return "invalid-client";
  }
  throw new Error(`Busabase Cloud rejected the OAuth authorization request (${response.status})`);
}

export interface RemoteMcpHandle {
  ready: Promise<{ error?: unknown }>;
  previewClient(targetSpaceId?: string): EmbedLinksClient;
  dispose(): Promise<void>;
}

/** Connect a remote Busabase MCP resource and keep its DSH tool generation live. */
export function connectRemoteMcp(
  ctx: Context,
  config: ResolvedBusabasePluginConfig,
  credentials: CredentialStore,
  callbackServerFactory: (
    preferredPort: number,
  ) => Promise<OAuthCallbackServer> = createCallbackServer,
  authorizationUrlPreflight: AuthorizationUrlPreflight = preflightAuthorizationUrl,
): RemoteMcpHandle {
  const label = `busabase-cloud-mcp(${config.serverName})`;
  const resourceUrl = new URL(config.mcpUrl).toString();
  const key = busabaseOAuthCredentialKey(resourceUrl, config.serverName);
  let disposed = false;
  let disposers = new Map<string, () => void>();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let failedAttempts = 0;
  let connectedAt: number | undefined;
  let firstAttemptError: unknown;
  let currentClient: Client | undefined;
  let currentAbort: AbortController | undefined;
  let suppressClose = false;
  let syncChain = Promise.resolve();

  const isCurrent = (client: Client): boolean => !disposed && currentClient === client;

  function generationDown(client: Client): void {
    if (!isCurrent(client)) return;
    currentClient = undefined;
    currentAbort = undefined;
    scheduleReconnect();
  }

  function observeCloseDuringConnect(client: Client): () => void {
    let connectSettled = false;
    let closeObserved = false;
    client.onclose = () => {
      closeObserved = true;
      if (connectSettled && !suppressClose) generationDown(client);
    };
    return () => {
      connectSettled = true;
      if (closeObserved && !suppressClose) generationDown(client);
    };
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return;
    const lostEstablishedConnection = connectedAt !== undefined;
    if (connectedAt !== undefined && Date.now() - connectedAt >= RECONNECT_MAX_DELAY_MS)
      failedAttempts = 0;
    connectedAt = undefined;
    failedAttempts += 1;
    if (failedAttempts > RECONNECT_MAX_ATTEMPTS) {
      for (const dispose of disposers.values()) dispose();
      disposers = new Map();
      ctx.logger.error(`${label}: giving up after ${String(RECONNECT_MAX_ATTEMPTS)} attempts`);
      return;
    }
    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_INITIAL_DELAY_MS * 2 ** (failedAttempts - 1),
    );
    ctx.logger.warn(
      `${label}: ${lostEstablishedConnection ? "connection lost; reconnecting" : "connection failed; retrying"} in ${String(delayMs)}ms`,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      settling = connectGeneration();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function enqueueSync(client: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(client)) return;
      const next = await syncTools(client, ctx, config, disposers, () => {
        if (isCurrent(client)) void client.close();
      });
      if (!isCurrent(client)) {
        for (const dispose of next.values()) dispose();
        disposers = new Map();
        return;
      }
      disposers = next;
    });
    syncChain = run.catch(() => undefined);
    return run;
  }

  async function connectGeneration(): Promise<void> {
    const abort = new AbortController();
    currentAbort = abort;
    let callback: OAuthCallbackServer | undefined;
    let client: Client | undefined;
    suppressClose = false;
    try {
      const preferredPort = await preferredCallbackPort(credentials, key, resourceUrl);
      callback = await callbackServerFactory(preferredPort);
      if (preferredPort !== 0 && callback.port !== preferredPort)
        await credentials.deleteRecord(key);
      const provider = new DshCredentialOAuthClientProvider(
        credentials,
        key,
        resourceUrl,
        callback.port,
        `Busabase (${config.serverName})`,
      );

      const createClientAndTransport = () => {
        const nextClient = new Client(
          { name: "busabase-dsh-plugin", version: PLUGIN_VERSION },
          { capabilities: {} },
        );
        const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
          authProvider: provider,
          requestInit: {
            headers: { "x-busabase-relay-permission-level": "changeRequest" },
          },
        });
        return { client: nextClient, transport };
      };

      for (let registrationAttempt = 0; ; registrationAttempt += 1) {
        let connection = createClientAndTransport();
        client = connection.client;
        currentClient = client;
        let connectSettled = observeCloseDuringConnect(client);
        try {
          await client.connect(connection.transport);
          connectSettled();
          break;
        } catch (error) {
          if (!(error instanceof UnauthorizedError)) throw error;
          const authorizationUrl = provider.takePendingAuthorizationUrl();
          if (!authorizationUrl)
            throw new Error("Busabase Cloud did not provide an authorization URL");
          const expectedState = authorizationUrl.searchParams.get("state");
          if (!expectedState || !provider.matchesState(expectedState))
            throw new Error("Busabase Cloud authorization URL did not preserve OAuth state");
          const preflight = await authorizationUrlPreflight(authorizationUrl);
          if (preflight === "invalid-client") {
            if (registrationAttempt > 0)
              throw new Error("Busabase Cloud rejected a newly registered OAuth client");
            await provider.invalidateClientRegistration();
            ctx.logger.info(`${label}: saved OAuth client is no longer valid; registering again`);
            suppressClose = true;
            await client.close().catch(() => undefined);
            if (disposed || abort.signal.aborted) return;
            suppressClose = false;
            continue;
          }
          const [code] = await Promise.all([
            callback.waitForCode(expectedState, abort.signal),
            openAuthorization(ctx, authorizationUrl),
          ]);
          await connection.transport.finishAuth(code);
          suppressClose = true;
          await client.close().catch(() => undefined);
          if (disposed || abort.signal.aborted) return;
          connection = createClientAndTransport();
          client = connection.client;
          currentClient = client;
          suppressClose = false;
          connectSettled = observeCloseDuringConnect(client);
          await client.connect(connection.transport);
          connectSettled();
          break;
        }
      }
      if (!isCurrent(client)) return;
      await callback.close();
      callback = undefined;
      if (!isCurrent(client)) return;
      const connectedClient = client;
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (!isCurrent(connectedClient)) return;
        try {
          await enqueueSync(connectedClient);
        } catch (error) {
          if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`);
        }
      });
      await enqueueSync(client);
      if (!isCurrent(client)) return;
      connectedAt = Date.now();
      if (failedAttempts > 0)
        ctx.logger.info(`${label}: reconnected after ${String(failedAttempts)} attempt(s)`);
      failedAttempts = 0;
    } catch (error) {
      firstAttemptError ??= error;
      if (client && isCurrent(client))
        ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`);
      suppressClose = true;
      await client?.close().catch(() => undefined);
      if (!disposed && (!client || isCurrent(client))) {
        currentClient = undefined;
        currentAbort = undefined;
        scheduleReconnect();
      }
    } finally {
      await callback?.close();
    }
  }

  let settling = connectGeneration();

  return {
    previewClient(targetSpaceId) {
      if (!currentClient || disposed) throw new Error("Busabase Cloud MCP is not connected");
      return createMcpEmbedClient(currentClient, targetSpaceId ?? config.spaceId);
    },
    ready: settling.then(() =>
      currentClient
        ? {}
        : { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) },
    ),
    async dispose(): Promise<void> {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      currentAbort?.abort();
      const client = currentClient;
      currentClient = undefined;
      currentAbort = undefined;
      suppressClose = true;
      await client?.close().catch(() => undefined);
      await settling.catch(() => undefined);
      await syncChain;
      for (const dispose of disposers.values()) dispose();
      disposers = new Map();
    },
  };
}

async function listRemoteTools(client: Client): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  const rawNames = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of response.tools) {
      if (rawNames.has(tool.name)) throw new Error(`remote MCP listed tool ${tool.name} twice`);
      rawNames.add(tool.name);
      tools.push(tool as RemoteTool);
    }
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

async function syncTools(
  client: Client,
  ctx: Context,
  config: ResolvedBusabasePluginConfig,
  previous: Map<string, () => void>,
  onUnauthorized: () => void,
): Promise<Map<string, () => void>> {
  const { serverName } = config;
  const definitions = new Map<string, ToolDefinition>();
  for (const tool of await listRemoteTools(client)) {
    const publicName = publicToolName(serverName, tool.name);
    if (definitions.has(publicName))
      throw new Error(`remote MCP tool name collision at ${publicName}`);
    definitions.set(
      publicName,
      createRemoteToolDefinition(client, config, publicName, tool, onUnauthorized, ctx.logger),
    );
  }

  for (const dispose of previous.values()) dispose();
  const next = new Map<string, () => void>();
  try {
    for (const [name, definition] of definitions) next.set(name, ctx.tools.register(definition));
    return next;
  } catch (error) {
    for (const dispose of next.values()) dispose();
    throw error;
  }
}

function createRemoteToolDefinition(
  client: Client,
  config: ResolvedBusabasePluginConfig,
  publicName: string,
  tool: RemoteTool,
  onUnauthorized: () => void,
  logger: Pick<Context["logger"], "warn">,
): ToolDefinition {
  const { serverName } = config;
  return {
    name: publicName,
    description: tool.description ?? "",
    parameters: tool.inputSchema,
    timeoutMs: TOOL_CALL_TIMEOUT_MS,
    output: {
      schema: {
        type: "object",
        properties: { content: { type: "array", items: {} }, structuredContent: {} },
        required: ["content"],
        additionalProperties: false,
      },
      render(_args: unknown, value: JsonValue) {
        const result = value as unknown as McpResult;
        return result.content.length
          ? result.content.map((block) => ({
              type: "text" as const,
              text: renderMcpContent([block]),
            }))
          : [{ type: "text", text: `(${serverName}: ${tool.name} returned no content)` }];
      },
    },
    async execute(args: unknown, execution: ToolRunContext): Promise<McpResult> {
      if (tool.execution?.taskSupport === "required")
        throw new Error(`Tool ${tool.name} requires unsupported task-based execution`);
      try {
        const result = await client.callTool(
          {
            name: tool.name,
            arguments:
              typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
          },
          undefined,
          { signal: execution.signal, timeout: TOOL_CALL_TIMEOUT_MS },
        );
        const content = Array.isArray(result.content) ? (result.content as JsonValue[]) : [];
        if (result.isError === true)
          throw new Error(renderMcpContent(content) || `${tool.name} failed`);
        const value: McpResult = {
          content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent as JsonValue }
            : {}),
        };
        const changeRequestId = createdChangeRequestId(
          `mcp__${serverName}__${tool.name}`,
          value,
          serverName,
        );
        if (changeRequestId) {
          const targetSpaceId =
            typeof args === "object" &&
            args !== null &&
            "targetSpaceId" in args &&
            typeof args.targetSpaceId === "string"
              ? args.targetSpaceId
              : config.spaceId;
          try {
            const link = await createChangeRequestPreviewLink(
              createMcpEmbedClient(client, targetSpaceId),
              changeRequestId,
              { signal: execution.signal },
            );
            // Keep JSON payloads in separate blocks so the UI can merge the preview with its CR.
            const originalContent = content.length
              ? content
              : [{ type: "text", text: JSON.stringify(value.structuredContent) }];
            value.content = [...originalContent, { type: "text", text: JSON.stringify(link) }];
          } catch {
            logger.warn(
              `busabase preview: could not create an embed link for ChangeRequest ${changeRequestId}; preserving the original MCP result`,
            );
          }
        }
        return value;
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        throw error;
      }
    },
  };
}

function renderMcpContent(content: JsonValue[]): string {
  return content
    .map((block) => {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const text = (block as Record<string, JsonValue>).text;
        if (typeof text === "string") return text;
      }
      return JSON.stringify(block) ?? "[unsupported MCP content]";
    })
    .join("\n");
}
