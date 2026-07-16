import documentAppHtml from "../dist/document-app.html";
import { tabulaMcpPrivacyPolicyHtml } from "../src/privacy-policy.js";
import { createTabulaMcpWebHandler, type TabulaMcpWebHandler, type WebEnvironment } from "../src/server/web.js";

let handler: TabulaMcpWebHandler | null = null;

type DurableObjectStubLike = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectNamespaceLike = {
  getByName(name: string): DurableObjectStubLike;
};

type WorkerEnv = Record<string, unknown> & {
  TABULA_MCP_SESSIONS?: DurableObjectNamespaceLike;
};

const forcedSessionIdHeader = "x-tabula-mcp-forced-session-id";

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

const requestWithForcedSessionId = (request: Request, sessionId: string) => {
  const headers = new Headers(request.headers);
  headers.set(forcedSessionIdHeader, sessionId);
  return new Request(request, { headers });
};

const requestWithoutForcedSessionId = (request: Request) => {
  const headers = new Headers(request.headers);
  headers.delete(forcedSessionIdHeader);
  return new Request(request, { headers });
};

export class TabulaMcpSessionDurableObject {
  private handler: TabulaMcpWebHandler | null = null;

  constructor(
    private readonly state: unknown,
    private readonly env: WorkerEnv,
  ) {
    void this.state;
  }

  fetch(request: Request) {
    const forcedSessionId = request.headers.get(forcedSessionIdHeader) ?? undefined;
    this.handler ??= createTabulaMcpWebHandler({
      deploymentMode: "remote",
      documentAppHtml,
      env: stringEnv(this.env),
      ...(forcedSessionId ? { sessionIdGenerator: () => forcedSessionId } : {}),
    });
    return this.handler.fetch(request);
  }
}

const routeMcpRequestToSession = (request: Request, env: WorkerEnv) => {
  const sessions = env.TABULA_MCP_SESSIONS;
  if (!sessions) {
    throw new Error("TABULA_MCP_SESSIONS Durable Object binding is required.");
  }

  const existingSessionId = sessionIdFromRequest(request);
  if (existingSessionId) {
    return sessions.getByName(existingSessionId).fetch(requestWithoutForcedSessionId(request));
  }

  const newSessionId = crypto.randomUUID();
  return sessions.getByName(newSessionId).fetch(requestWithForcedSessionId(request, newSessionId));
};

export default {
  fetch(request: Request, env: WorkerEnv) {
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
