import documentAppHtml from "../dist/document-app.html";
import { tabulaMcpPrivacyPolicyHtml } from "../src/privacy-policy.js";
import { createTabulaMcpWebHandler, type TabulaMcpWebHandler, type WebEnvironment } from "../src/server/web.js";
import {
  quotaClientKey,
  TabulaMcpQuotaDurableObject,
  type QuotaDecision,
} from "../src/server/cloudflare-quota.js";
import {
  createTabulaMcpSessionDurableObject,
  forcedSessionIdHeader,
  internalClientKeyHeader,
  internalSessionIdHeader,
  quotaStub,
  releaseQuotaSession,
  type WorkerEnv,
} from "./tabula-mcp-session-do.js";

export { TabulaMcpQuotaDurableObject };
export const TabulaMcpSessionDurableObject = createTabulaMcpSessionDurableObject(documentAppHtml);

let handler: TabulaMcpWebHandler | null = null;

const defaultMaxRequestBytes = 6 * 1024 * 1024;

const stringEnv = (env: Record<string, unknown>): WebEnvironment =>
  Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, value]),
  );

const requestPathname = (request: Request) => new URL(request.url).pathname;

const isPrivacyRequest = (request: Request) => requestPathname(request) === "/privacy";

const isMcpRequest = (request: Request) => {
  const pathname = requestPathname(request);
  return pathname === "/mcp" || pathname === "/api/mcp" || pathname === "/sse" || pathname === "/message";
};

const sessionIdFromRequest = (request: Request) => request.headers.get("mcp-session-id") ?? undefined;

const clientIdentityFromRequest = (request: Request) =>
  request.headers.get("cf-connecting-ip") ??
  request.headers.get("x-real-ip") ??
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";

const requestForSession = (
  request: Request,
  { clientKey, forceSessionId, sessionId }: { clientKey: string; forceSessionId: boolean; sessionId: string },
) => {
  const headers = new Headers(request.headers);
  headers.delete(forcedSessionIdHeader);
  headers.set(internalClientKeyHeader, clientKey);
  headers.set(internalSessionIdHeader, sessionId);
  if (forceSessionId) headers.set(forcedSessionIdHeader, sessionId);
  return new Request(request, { headers });
};

const quotaRejectedResponse = (decision: QuotaDecision) => Response.json({
  jsonrpc: "2.0",
  error: {
    code: -32000,
    message: decision.reason === "client_session_limit"
      ? "Too many Tabula MCP sessions are active for this client."
      : "The Tabula MCP usage limit was reached for this client.",
    data: {
      code: "rate_limited",
      reason: decision.reason,
      retryAfterSeconds: decision.retryAfterSeconds ?? 30,
      retry: "Wait for the indicated interval before retrying.",
    },
  },
  id: null,
}, {
  status: 429,
  headers: {
    "cache-control": "no-store",
    "retry-after": String(decision.retryAfterSeconds ?? 30),
  },
});

const mutationTools = new Set([
  "start_session",
  "join_room",
  "leave_session",
  "write_file",
  "write_files",
  "edit_file",
  "create_directory",
  "move_file",
  "delete_path",
]);

class EdgeRequestTooLargeError extends Error {}

const boundedRequestText = async (request: Request, maxBytes: number) => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new EdgeRequestTooLargeError();
  const reader = request.clone().body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new EdgeRequestTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

const quotaUsageForRequest = async (request: Request, maxRequestBytes: number) => {
  if (request.method !== "POST") return { operation: "request" as const, units: 1 };
  let text = "";
  try {
    text = await boundedRequestText(request, maxRequestBytes);
    const body = JSON.parse(text) as { method?: string; params?: { name?: string } };
    const toolName = body.method === "tools/call" ? body.params?.name : undefined;
    if (toolName === "export_copy") {
      return { operation: "export" as const, units: Math.max(1, new TextEncoder().encode(text).byteLength) };
    }
    if (toolName && mutationTools.has(toolName)) return { operation: "mutation" as const, units: 1 };
  } catch (error) {
    if (error instanceof EdgeRequestTooLargeError) throw error;
    // The MCP handler owns JSON validation. Quota accounting remains request-based.
  }
  return { operation: "request" as const, units: 1 };
};

export const routeMcpRequestToSession = async (request: Request, env: WorkerEnv) => {
  const sessions = env.TABULA_MCP_SESSIONS;
  if (!sessions) {
    throw new Error("TABULA_MCP_SESSIONS Durable Object binding is required.");
  }

  const existingSessionId = sessionIdFromRequest(request);
  const sessionId = existingSessionId ?? crypto.randomUUID();
  const quotaSecret = env.TABULA_MCP_QUOTA_HASH_SECRET?.trim();
  if (!quotaSecret) {
    return Response.json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Tabula MCP quota protection is not configured." },
      id: null,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const clientKey = await quotaClientKey(clientIdentityFromRequest(request), quotaSecret);
  const configuredMaxRequestBytes = Number(env.TABULA_MCP_HTTP_MAX_REQUEST_BYTES);
  const maxRequestBytes = Number.isSafeInteger(configuredMaxRequestBytes) && configuredMaxRequestBytes > 0
    ? configuredMaxRequestBytes
    : defaultMaxRequestBytes;
  let usage: Awaited<ReturnType<typeof quotaUsageForRequest>>;
  try {
    usage = await quotaUsageForRequest(request, maxRequestBytes);
  } catch (error) {
    if (!(error instanceof EdgeRequestTooLargeError)) throw error;
    return Response.json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Request body is too large." },
      id: null,
    }, { status: 413, headers: { "cache-control": "no-store" } });
  }
  const quotaResponse = await quotaStub(env, clientKey).fetch(new Request("https://tabula.internal/quota", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...usage }),
  }));
  if (!quotaResponse.ok) return new Response("Quota service unavailable", { status: 503 });
  const decision = await quotaResponse.json() as QuotaDecision;
  if (!decision.allowed) return quotaRejectedResponse(decision);

  let response: Response;
  try {
    response = await sessions.getByName(sessionId).fetch(requestForSession(request, {
      clientKey,
      forceSessionId: !existingSessionId,
      sessionId,
    }));
  } catch (error) {
    if (!existingSessionId) await releaseQuotaSession(env, clientKey, sessionId).catch(() => undefined);
    throw error;
  }
  const initialized = existingSessionId || response.headers.get("mcp-session-id") === sessionId;
  if (request.method === "DELETE" || !initialized) {
    await releaseQuotaSession(env, clientKey, sessionId).catch(() => undefined);
  }
  return response;
};

export default {
  async fetch(request: Request, env: WorkerEnv) {
    if (isPrivacyRequest(request)) {
      return new Response(tabulaMcpPrivacyPolicyHtml, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    if (isMcpRequest(request)) {
      return routeMcpRequestToSession(request, env);
    }

    handler ??= createTabulaMcpWebHandler({
      deploymentMode: "remote",
      documentAppHtml,
      env: stringEnv(env),
    });
    return handler.fetch(request);
  },
};
