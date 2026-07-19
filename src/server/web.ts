import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RuntimeEnvironment } from "../env.js";
import { resolveDeploymentMode, type DeploymentMode } from "../deployment.js";
import { TABULA_MCP_VERSION } from "../version.js";
import { createTabulaMcpServer, type TabulaMcpServerInstance } from "./create-server.js";
import {
  authorizeBearerToken,
  errorMessageForLog,
  errorMessageForClient,
  FixedWindowRateLimiter,
  logOperationalError,
  logRequest,
  RequestTimeoutError,
  shouldCleanupTimedOutSession,
  RequestTooLargeError,
  resolveOperationalPolicy,
  timeoutErrorData,
  withTimeout,
  type OperationalPolicyOptions,
} from "./operational-policy.js";
import {
  corsHeadersForOrigin,
  isAllowedOrigin,
  resolveOriginPolicy,
  type OriginPolicy,
} from "./origin-policy.js";
import { resolveWriteEnabled } from "./write-access.js";
import { TABULA_MCP_PRODUCT_DESCRIPTION } from "../public-copy.js";
import { runWithOperationSignal } from "./operation-context.js";
import type { SessionRegistryLifecycle } from "../registry.js";

export type WebEnvironment = RuntimeEnvironment;

export type TabulaMcpWebHandlerOptions = {
  allowedOrigins?: string[] | null;
  authToken?: string | null;
  deploymentMode?: DeploymentMode;
  documentAppHtml?: string;
  env?: WebEnvironment;
  maxActiveSessions?: number;
  maxRequestBytes?: number;
  production?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  requestTimeoutMs?: number;
  roomSessionLifecycle?: SessionRegistryLifecycle;
  sessionIdleTtlMs?: number;
  sessionIdGenerator?: () => string;
  statelessHttp?: boolean;
  writeEnabled?: boolean;
};

export type TabulaMcpWebHandler = {
  close(): Promise<void>;
  deploymentMode: DeploymentMode;
  version: string;
  writeAccess: "enabled" | "read-only";
  fetch(request: Request): Promise<Response>;
};

type ActiveWebSession = {
  createdAt: number;
  instance: TabulaMcpServerInstance;
  lastSeenAt: number;
  transport: WebStandardStreamableHTTPServerTransport;
};

const defaultEnv = (): WebEnvironment => {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env;
};

const requestPathname = (request: Request) => new URL(request.url).pathname;

const corsHeaders = (origin: string | null, originPolicy: OriginPolicy) =>
  corsHeadersForOrigin(origin, originPolicy);

const withCors = (response: Response, request: Request, originPolicy: OriginPolicy) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request.headers.get("origin"), originPolicy)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const jsonResponse = (
  request: Request,
  originPolicy: OriginPolicy,
  status: number,
  value: Record<string, unknown>,
  headers?: HeadersInit,
) =>
  withCors(
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        ...headers,
      },
    }),
    request,
    originPolicy,
  );

const jsonRpcError = (
  request: Request,
  originPolicy: OriginPolicy,
  status: number,
  code: number,
  message: string,
  headers?: HeadersInit,
  data?: Record<string, unknown>,
) =>
  jsonResponse(request, originPolicy, status, {
    jsonrpc: "2.0",
    error: { code, message, ...(data ? { data } : {}) },
    id: null,
  }, headers);

const sessionIdFromRequest = (request: Request) => request.headers.get("mcp-session-id") ?? undefined;

const clientIdentityFromRequest = (request: Request) =>
  request.headers.get("cf-connecting-ip") ??
  request.headers.get("x-real-ip") ??
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";

const concatChunks = (chunks: Uint8Array[], byteLength: number) => {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const requestWithLimitedBody = async (request: Request, maxBytes: number) => {
  if (request.method !== "POST" || !request.body) {
    return request;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength?.trim()) {
    const parsedContentLength = Number(contentLength);
    if (Number.isFinite(parsedContentLength) && parsedContentLength > maxBytes) {
      throw new RequestTooLargeError();
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  return new Request(request, {
    body: concatChunks(chunks, byteLength),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
};

const closeActiveSession = async (active: ActiveWebSession) => {
  await active.instance.registry.clear();
  await active.transport.close();
  await active.instance.server.close();
};

const cleanupSession = (sessions: Map<string, ActiveWebSession>, sessionId: string) => {
  const active = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (active) {
    void closeActiveSession(active).catch(() => undefined);
  }
};

const pruneIdleSessions = (sessions: Map<string, ActiveWebSession>, sessionIdleTtlMs: number) => {
  const now = Date.now();
  for (const [sessionId, active] of sessions.entries()) {
    if (now - active.lastSeenAt > sessionIdleTtlMs) {
      cleanupSession(sessions, sessionId);
    }
  }
};

const operationalPolicyOptions = (options: TabulaMcpWebHandlerOptions): OperationalPolicyOptions => ({
  authToken: options.authToken,
  maxActiveSessions: options.maxActiveSessions,
  maxRequestBytes: options.maxRequestBytes,
  production: options.production,
  rateLimitMax: options.rateLimitMax,
  rateLimitWindowMs: options.rateLimitWindowMs,
  requestTimeoutMs: options.requestTimeoutMs,
  sessionIdleTtlMs: options.sessionIdleTtlMs,
  statelessHttp: options.statelessHttp,
});

export const createTabulaMcpWebHandler = (options: TabulaMcpWebHandlerOptions = {}): TabulaMcpWebHandler => {
  const env = options.env ?? defaultEnv();
  const deploymentMode = resolveDeploymentMode({
    deploymentMode: options.deploymentMode,
    env: env as NodeJS.ProcessEnv,
    defaultDeploymentMode: "remote",
  });
  const policy = resolveOperationalPolicy({
    deploymentMode,
    env,
    options: operationalPolicyOptions(options),
  });
  const originPolicy = resolveOriginPolicy({
    allowedOrigins: options.allowedOrigins,
    env,
    production: policy.production,
  });
  const writeEnabled = options.writeEnabled ?? resolveWriteEnabled({
    env: env as NodeJS.ProcessEnv,
  });
  const writeAccess = writeEnabled ? "enabled" : "read-only";
  const sessions = new Map<string, ActiveWebSession>();
  const rateLimiter = new FixedWindowRateLimiter({
    maxRequests: policy.rateLimitMax,
    windowMs: policy.rateLimitWindowMs,
  });

  const createServerInstance = () =>
    createTabulaMcpServer({
      deploymentMode,
      documentAppHtml: options.documentAppHtml,
      allowRoomTools: policy.allowRemoteRoomConnections,
      forceDocumentAppTools: policy.statelessHttp,
      writeEnabled,
      env,
      roomSessionLifecycle: options.roomSessionLifecycle,
      sessionIdleTtlMs: policy.sessionIdleTtlMs,
    });

  const createStatefulSession = async () => {
    let transport: WebStandardStreamableHTTPServerTransport;
    const instance = createServerInstance();

    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: options.sessionIdGenerator ?? (() => randomUUID()),
      onsessioninitialized: (newSessionId) => {
        const now = Date.now();
        sessions.set(newSessionId, { createdAt: now, instance, lastSeenAt: now, transport });
      },
      onsessionclosed: (closedSessionId) => cleanupSession(sessions, closedSessionId),
    });
    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) {
        cleanupSession(sessions, closedSessionId);
      }
    };

    await instance.server.connect(transport);
    return { instance, transport };
  };

  const handleStatelessMcpRequest = async (request: Request) => {
    if (request.method === "GET" || request.method === "DELETE") {
      return jsonRpcError(request, originPolicy, 405, -32000, "Method Not Allowed.", {
        allow: "POST,OPTIONS",
      });
    }

    if (request.method !== "POST") {
      return jsonRpcError(request, originPolicy, 405, -32000, "Method Not Allowed.", {
        allow: "POST,OPTIONS",
      });
    }

    const instance = createServerInstance();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    await instance.server.connect(transport);
    try {
      const response = await withTimeout(
        (signal) => runWithOperationSignal(signal, () => transport.handleRequest(new Request(request, { signal }))),
        policy.requestTimeoutMs,
      );
      return withCors(response, request, originPolicy);
    } finally {
      await closeActiveSession({ createdAt: Date.now(), instance, lastSeenAt: Date.now(), transport });
    }
  };

  const handleMcpRequest = async (request: Request) => {
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin, originPolicy)) {
      return jsonResponse(request, originPolicy, 403, { error: "Origin is not allowed" });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, originPolicy),
      });
    }

    try {
      if (!authorizeBearerToken(request.headers.get("authorization"), policy.authToken)) {
        return jsonResponse(request, originPolicy, 401, { error: "Unauthorized" }, {
          "www-authenticate": 'Bearer realm="tabula-mcp"',
        });
      }

      const rateLimit = rateLimiter.check(clientIdentityFromRequest(request));
      if (!rateLimit.allowed) {
        return jsonRpcError(request, originPolicy, 429, -32000, "Too many requests.", {
          "retry-after": String(Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))),
        });
      }

      pruneIdleSessions(sessions, policy.sessionIdleTtlMs);
      const limitedRequest = await requestWithLimitedBody(request, policy.maxRequestBytes);
      if (policy.statelessHttp) {
        return handleStatelessMcpRequest(limitedRequest);
      }

      const sessionId = sessionIdFromRequest(limitedRequest);
      if (sessionId) {
        const active = sessions.get(sessionId);
        if (!active) {
          return jsonRpcError(limitedRequest, originPolicy, 404, -32001, "Session not found.");
        }

        active.lastSeenAt = Date.now();
        try {
          return withCors(await withTimeout(
            (signal) => runWithOperationSignal(
              signal,
              () => active.transport.handleRequest(new Request(limitedRequest, { signal })),
            ),
            policy.requestTimeoutMs,
          ), limitedRequest, originPolicy);
        } catch (error) {
          if (error instanceof RequestTimeoutError && shouldCleanupTimedOutSession(error)) {
            cleanupSession(sessions, sessionId);
          }
          throw error;
        }
      }

      if (limitedRequest.method === "POST") {
        if (sessions.size >= policy.maxActiveSessions) {
          return jsonRpcError(limitedRequest, originPolicy, 503, -32000, "Too many active MCP sessions.");
        }
        const active = await createStatefulSession();
        let response: Response;
        try {
          response = await withTimeout(
            (signal) => runWithOperationSignal(
              signal,
              () => active.transport.handleRequest(new Request(limitedRequest, { signal })),
            ),
            policy.requestTimeoutMs,
          );
        } catch (error) {
          const initializedSessionId = active.transport.sessionId;
          if (initializedSessionId) cleanupSession(sessions, initializedSessionId);
          else await closeActiveSession({ ...active, createdAt: Date.now(), lastSeenAt: Date.now() });
          throw error;
        }
        if (!active.transport.sessionId) {
          await closeActiveSession({ ...active, createdAt: Date.now(), lastSeenAt: Date.now() });
        }
        return withCors(response, limitedRequest, originPolicy);
      }

      return jsonRpcError(request, originPolicy, 400, -32000, "Bad Request: No valid MCP session ID provided.");
    } catch (error) {
      const status = error instanceof RequestTooLargeError ? 413 : error instanceof RequestTimeoutError ? 504 : 500;
      return jsonRpcError(
        request,
        originPolicy,
        status,
        -32603,
        errorMessageForClient(error, policy.production),
        undefined,
        error instanceof RequestTimeoutError ? timeoutErrorData(error) : undefined,
      );
    }
  };

  return {
    async close() {
      const activeSessions = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(activeSessions.map((active) => closeActiveSession(active)));
    },
    deploymentMode,
    version: TABULA_MCP_VERSION,
    writeAccess,
    async fetch(request: Request) {
      const startedAt = Date.now();
      const pathname = requestPathname(request);
      let response: Response | undefined;
      try {
        if (pathname === "/mcp" || pathname === "/api/mcp" || pathname === "/sse" || pathname === "/message") {
          response = await handleMcpRequest(request);
          return response;
        }

        if (pathname === "/health") {
          response = jsonResponse(request, originPolicy, 200, {
            ok: true,
            service: "tabula-mcp",
            version: TABULA_MCP_VERSION,
            writeAccess,
            deploymentMode,
            publicUnauthenticated: policy.publicUnauthenticated,
            statelessHttp: policy.statelessHttp,
          });
          return response;
        }

        if (pathname === "/ready") {
          response = jsonResponse(request, originPolicy, 200, {
            ok: true,
            service: "tabula-mcp",
            version: TABULA_MCP_VERSION,
            writeAccess,
            deploymentMode,
            publicUnauthenticated: policy.publicUnauthenticated,
            statelessHttp: policy.statelessHttp,
          });
          return response;
        }

        if (pathname === "/") {
          response = jsonResponse(request, originPolicy, 200, {
            ok: true,
            service: "tabula-mcp",
            version: TABULA_MCP_VERSION,
            writeAccess,
            description: TABULA_MCP_PRODUCT_DESCRIPTION,
            mcp: "/mcp",
            health: "/health",
            ready: "/ready",
            deploymentMode,
            publicUnauthenticated: policy.publicUnauthenticated,
            statelessHttp: policy.statelessHttp,
          });
          return response;
        }

        response = jsonResponse(request, originPolicy, 404, { error: "Not found" });
        return response;
      } finally {
        logRequest(policy, {
          durationMs: Date.now() - startedAt,
          method: request.method,
          path: pathname,
          sessionPresent: request.headers.has("mcp-session-id"),
          status: response?.status ?? 500,
        });
      }
    },
  };
};
