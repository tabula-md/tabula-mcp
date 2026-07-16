import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { positiveIntegerFromEnv } from "../env.js";
import {
  checkDocumentStoreReadiness,
  createDefaultDocumentStore,
  resolveDocumentStoreDeploymentMode,
  type DocumentStore,
  type DocumentStoreDeploymentMode,
  type DocumentStoreKind,
} from "../documents/store.js";
import { createTabulaMcpServer, type TabulaMcpServerInstance } from "./create-server.js";
import { TABULA_MCP_VERSION } from "../version.js";
import {
  authorizeBearerToken,
  errorMessageForLog,
  errorMessageForClient,
  FixedWindowRateLimiter,
  logOperationalError,
  logRequest,
  RequestTimeoutError,
  RequestTooLargeError,
  resolveOperationalPolicy,
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

export type TabulaMcpHttpServerOptions = {
  allowedOrigins?: string[] | null;
  authToken?: string | null;
  deploymentMode?: DocumentStoreDeploymentMode;
  documentStore?: DocumentStore;
  host?: string;
  maxActiveSessions?: number;
  maxRequestBytes?: number;
  port?: number;
  production?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  requestTimeoutMs?: number;
  sessionIdleTtlMs?: number;
  statelessHttp?: boolean;
  writeEnabled?: boolean;
};

export type TabulaMcpHttpServer = {
  close(): Promise<void>;
  deploymentMode: DocumentStoreDeploymentMode;
  documentStoreKind: DocumentStoreKind;
  host: string;
  listen(): Promise<void>;
  port: number;
  server: http.Server;
  version: string;
  writeAccess: "enabled" | "read-only";
};

type ActiveSession = {
  createdAt: number;
  instance: TabulaMcpServerInstance;
  lastSeenAt: number;
  transport: StreamableHTTPServerTransport;
};

const defaultHttpPort = 3005;

const httpJson = (
  response: ServerResponse,
  statusCode: number,
  value: Record<string, unknown>,
  headers?: Record<string, string>,
) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [key, headerValue] of Object.entries(headers ?? {})) {
    response.setHeader(key, headerValue);
  }
  response.end(`${JSON.stringify(value)}\n`);
};

const jsonRpcError = (
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
) =>
  httpJson(response, statusCode, {
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id: null,
  }, headers);

const requestOrigin = (request: IncomingMessage) => {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
};

const applyCors = (request: IncomingMessage, response: ServerResponse, originPolicy: OriginPolicy) => {
  for (const [key, value] of corsHeadersForOrigin(requestOrigin(request), originPolicy)) {
    response.setHeader(key, value);
  }
};

const requestPathname = (request: IncomingMessage) => {
  const host = request.headers.host || "localhost";
  return new URL(request.url || "/", `http://${host}`).pathname;
};

const readJsonBody = async (request: IncomingMessage, maxBytes: number) => {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      throw new RequestTooLargeError();
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as unknown;
};

const closeActiveSession = async (active: ActiveSession) => {
  active.instance.registry.clear();
  await active.transport.close();
  await active.instance.server.close();
};

const cleanupSession = (sessions: Map<string, ActiveSession>, sessionId: string) => {
  const active = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (active) {
    void closeActiveSession(active).catch(() => undefined);
  }
};

const pruneIdleSessions = (sessions: Map<string, ActiveSession>, sessionIdleTtlMs: number) => {
  const now = Date.now();
  for (const [sessionId, active] of sessions.entries()) {
    if (now - active.lastSeenAt > sessionIdleTtlMs) {
      cleanupSession(sessions, sessionId);
    }
  }
};

const clientIdentityFromRequest = (request: IncomingMessage) => {
  const forwarded = request.headers["cf-connecting-ip"] ?? request.headers["x-real-ip"] ?? request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
};

const operationalPolicyOptions = (options: TabulaMcpHttpServerOptions): OperationalPolicyOptions => ({
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

const httpErrorStatus = (error: unknown) => {
  if (error instanceof SyntaxError) {
    return 400;
  }
  if (error instanceof RequestTooLargeError) {
    return 413;
  }
  if (error instanceof RequestTimeoutError) {
    return 504;
  }
  return 500;
};

export const resolveHttpServerOptions = (
  options: TabulaMcpHttpServerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
) => {
  const deploymentMode = resolveDocumentStoreDeploymentMode({
    deploymentMode: options.deploymentMode,
    env,
    defaultDeploymentMode: "remote",
  });
  return {
    deploymentMode,
    host: options.host ?? (env.TABULA_MCP_HTTP_HOST?.trim() || "127.0.0.1"),
    port: options.port ?? positiveIntegerFromEnv(env.TABULA_MCP_HTTP_PORT?.trim() || env.PORT, defaultHttpPort),
  };
};

export const createTabulaMcpHttpServer = (options: TabulaMcpHttpServerOptions = {}): TabulaMcpHttpServer => {
  const resolved = resolveHttpServerOptions(options);
  const policy = resolveOperationalPolicy({
    deploymentMode: resolved.deploymentMode,
    env: process.env,
    options: operationalPolicyOptions(options),
  });
  const originPolicy = resolveOriginPolicy({
    allowedOrigins: options.allowedOrigins,
    env: process.env,
    production: policy.production,
  });
  const sharedDocumentStore =
    options.documentStore ??
    createDefaultDocumentStore({
      deploymentMode: resolved.deploymentMode,
      defaultDeploymentMode: "remote",
      production: policy.production,
    });
  const writeEnabled = options.writeEnabled ?? resolveWriteEnabled({ env: process.env });
  const writeAccess = writeEnabled ? "enabled" : "read-only";
  const sessions = new Map<string, ActiveSession>();
  const rateLimiter = new FixedWindowRateLimiter({
    maxRequests: policy.rateLimitMax,
    windowMs: policy.rateLimitWindowMs,
  });

  const createServerInstance = () =>
    createTabulaMcpServer({
      deploymentMode: resolved.deploymentMode,
      documentStore: sharedDocumentStore,
      allowRoomTools: policy.allowRemoteRoomConnections,
      forceDocumentAppTools: policy.statelessHttp,
      writeEnabled,
      env: process.env,
    });

  const createStatefulTransport = async () => {
    let transport: StreamableHTTPServerTransport;
    const instance = createServerInstance();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
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

  const handleStatelessMcpRequest = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" || request.method === "DELETE") {
      response.statusCode = 405;
      response.setHeader("allow", "POST,OPTIONS");
      response.end("Method Not Allowed");
      return;
    }

    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("allow", "POST,OPTIONS");
      response.end("Method Not Allowed");
      return;
    }

    const body = await readJsonBody(request, policy.maxRequestBytes);
    const instance = createServerInstance();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    await instance.server.connect(transport);
    try {
      await withTimeout(transport.handleRequest(request, response, body), policy.requestTimeoutMs);
    } finally {
      await closeActiveSession({ createdAt: Date.now(), instance, lastSeenAt: Date.now(), transport });
    }
  };

  const handleMcpRequest = async (request: IncomingMessage, response: ServerResponse) => {
    applyCors(request, response, originPolicy);

    if (!isAllowedOrigin(requestOrigin(request), originPolicy)) {
      httpJson(response, 403, { error: "Origin is not allowed" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    try {
      if (!authorizeBearerToken(Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization, policy.authToken)) {
        httpJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": 'Bearer realm="tabula-mcp"' });
        return;
      }

      const rateLimit = rateLimiter.check(clientIdentityFromRequest(request));
      if (!rateLimit.allowed) {
        jsonRpcError(response, 429, -32000, "Too many requests.", {
          "retry-after": String(Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))),
        });
        return;
      }

      pruneIdleSessions(sessions, policy.sessionIdleTtlMs);
      if (policy.statelessHttp) {
        await handleStatelessMcpRequest(request, response);
        return;
      }

      const sessionId = request.headers["mcp-session-id"];
      const resolvedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      if (request.method === "POST") {
        const body = await readJsonBody(request, policy.maxRequestBytes);
        const activeSession = resolvedSessionId ? sessions.get(resolvedSessionId) : undefined;
        if (activeSession) {
          activeSession.lastSeenAt = Date.now();
          await withTimeout(activeSession.transport.handleRequest(request, response, body), policy.requestTimeoutMs);
          return;
        }

        if (resolvedSessionId) {
          jsonRpcError(response, 404, -32001, "Session not found.");
          return;
        }

        if (!resolvedSessionId && isInitializeRequest(body)) {
          if (sessions.size >= policy.maxActiveSessions) {
            jsonRpcError(response, 503, -32000, "Too many active MCP sessions.");
            return;
          }
          const { transport } = await createStatefulTransport();
          await withTimeout(transport.handleRequest(request, response, body), policy.requestTimeoutMs);
          return;
        }

        jsonRpcError(response, 400, -32000, "Bad Request: No valid MCP session ID provided.");
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        if (!resolvedSessionId) {
          jsonRpcError(response, 400, -32000, "Bad Request: No valid MCP session ID provided.");
          return;
        }
        if (!sessions.has(resolvedSessionId)) {
          jsonRpcError(response, 404, -32001, "Session not found.");
          return;
        }
        const activeSession = sessions.get(resolvedSessionId);
        if (activeSession) {
          activeSession.lastSeenAt = Date.now();
          await withTimeout(activeSession.transport.handleRequest(request, response), policy.requestTimeoutMs);
        }
        return;
      }

      response.statusCode = 405;
      response.setHeader("allow", "GET,POST,DELETE,OPTIONS");
      response.end("Method Not Allowed");
    } catch (error) {
      if (!response.headersSent) {
        const status = httpErrorStatus(error);
        jsonRpcError(
          response,
          status,
          error instanceof SyntaxError ? -32700 : -32603,
          errorMessageForClient(error, policy.production),
        );
      }
    }
  };

  const server = http.createServer((request, response) => {
    const pathname = requestPathname(request);
    const startedAt = Date.now();
    response.once("finish", () => {
      logRequest(policy, {
        durationMs: Date.now() - startedAt,
        method: request.method ?? "GET",
        path: pathname,
        sessionPresent: request.headers["mcp-session-id"] !== undefined,
        status: response.statusCode,
      });
    });
    if (pathname === "/mcp" || pathname === "/api/mcp" || pathname === "/sse" || pathname === "/message") {
      void handleMcpRequest(request, response);
      return;
    }

    applyCors(request, response, originPolicy);
    if (pathname === "/health") {
      httpJson(response, 200, {
        ok: true,
        service: "tabula-mcp",
        version: TABULA_MCP_VERSION,
        writeAccess,
        deploymentMode: resolved.deploymentMode,
        documentStore: sharedDocumentStore.kind,
        publicUnauthenticated: policy.publicUnauthenticated,
        statelessHttp: policy.statelessHttp,
      });
      return;
    }

    if (pathname === "/ready") {
      void (async () => {
        try {
          await checkDocumentStoreReadiness(sharedDocumentStore);
          httpJson(response, 200, {
            ok: true,
            service: "tabula-mcp",
            version: TABULA_MCP_VERSION,
            writeAccess,
            deploymentMode: resolved.deploymentMode,
            documentStore: sharedDocumentStore.kind,
            publicUnauthenticated: policy.publicUnauthenticated,
            statelessHttp: policy.statelessHttp,
          });
        } catch (error) {
          logOperationalError(policy, "tabula_mcp_readiness_failed", {
            deploymentMode: resolved.deploymentMode,
            documentStore: sharedDocumentStore.kind,
            error: errorMessageForLog(error),
            errorName: error instanceof Error ? error.name : typeof error,
          });
          httpJson(response, 503, {
            ok: false,
            service: "tabula-mcp",
            version: TABULA_MCP_VERSION,
            writeAccess,
            deploymentMode: resolved.deploymentMode,
            documentStore: sharedDocumentStore.kind,
          });
        }
      })();
      return;
    }

    if (pathname === "/") {
      httpJson(response, 200, {
        ok: true,
        service: "tabula-mcp",
        version: TABULA_MCP_VERSION,
        writeAccess,
        description: TABULA_MCP_PRODUCT_DESCRIPTION,
        mcp: "/mcp",
        health: "/health",
        ready: "/ready",
        deploymentMode: resolved.deploymentMode,
        documentStore: sharedDocumentStore.kind,
        publicUnauthenticated: policy.publicUnauthenticated,
        statelessHttp: policy.statelessHttp,
      });
      return;
    }

    httpJson(response, 404, { error: "Not found" });
  });

  return {
    server,
    port: resolved.port,
    host: resolved.host,
    deploymentMode: resolved.deploymentMode,
    documentStoreKind: sharedDocumentStore.kind,
    version: TABULA_MCP_VERSION,
    writeAccess,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolved.port, resolved.host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: async () => {
      const activeSessions = [...sessions.values()];
      sessions.clear();
      await Promise.all(activeSessions.map((active) => closeActiveSession(active)));
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
  };
};
