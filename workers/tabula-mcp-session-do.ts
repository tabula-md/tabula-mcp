import { TabulaCoreError } from "../src/core-errors.js";
import { positiveIntegerFromEnv } from "../src/env.js";
import type { QuotaDecision } from "../src/server/cloudflare-quota.js";
import { DEFAULT_SESSION_IDLE_TTL_MS } from "../src/session-timeouts.js";
import {
  createTabulaMcpWebHandler,
  type TabulaMcpWebHandler,
  type WebEnvironment,
} from "../src/server/web.js";

type DurableObjectStubLike = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectNamespaceLike = {
  getByName(name: string): DurableObjectStubLike;
};

type DurableObjectStorageLike = {
  delete(key: string): Promise<boolean>;
  deleteAlarm(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

type DurableObjectStateLike = {
  storage: DurableObjectStorageLike;
};

export type WorkerEnv = Record<string, unknown> & {
  TABULA_MCP_QUOTA?: DurableObjectNamespaceLike;
  TABULA_MCP_QUOTA_HASH_SECRET?: string;
  TABULA_MCP_SESSION_IDLE_TTL_MS?: string;
  TABULA_MCP_SESSIONS?: DurableObjectNamespaceLike;
};

export const forcedSessionIdHeader = "x-tabula-mcp-forced-session-id";
export const internalClientKeyHeader = "x-tabula-mcp-client-key";
export const internalSessionIdHeader = "x-tabula-mcp-session-id";

const sessionMetadataKey = "mcp-session-metadata-v1";
type SessionMetadata = { clientKey: string; sessionId: string };

const stringEnv = (env: Record<string, unknown>): WebEnvironment =>
  Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, value]),
  );

export const quotaStub = (env: WorkerEnv, clientKey: string) => {
  if (!env.TABULA_MCP_QUOTA) throw new Error("TABULA_MCP_QUOTA Durable Object binding is required.");
  return env.TABULA_MCP_QUOTA.getByName(clientKey);
};

export const releaseQuotaSession = (env: WorkerEnv, clientKey: string, sessionId: string) =>
  quotaStub(env, clientKey).fetch(new Request("https://tabula.internal/quota", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }));

const quotaRoomRequest = (
  env: WorkerEnv,
  clientKey: string,
  method: "DELETE" | "POST",
  sessionId: string,
  roomSessionId: string,
) => quotaStub(env, clientKey).fetch(new Request("https://tabula.internal/rooms", {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, roomSessionId }),
}));

const acquireQuotaRoom = async (
  env: WorkerEnv,
  clientKey: string,
  sessionId: string,
  roomSessionId: string,
) => {
  const response = await quotaRoomRequest(env, clientKey, "POST", sessionId, roomSessionId);
  if (!response.ok) throw new Error("Tabula MCP Room quota service is unavailable.");
  const decision = await response.json() as QuotaDecision;
  if (!decision.allowed) {
    throw new TabulaCoreError("session_limit", "This client already has the maximum number of live Tabula sessions.", {
      details: { limitScope: "client", retryAfterSeconds: decision.retryAfterSeconds ?? 30 },
      retry: "Leave an inactive Tabula session before joining another room.",
    });
  }
};

const releaseQuotaRoom = async (
  env: WorkerEnv,
  clientKey: string,
  sessionId: string,
  roomSessionId: string,
) => {
  await quotaRoomRequest(env, clientKey, "DELETE", sessionId, roomSessionId);
};

/**
 * Keep the Durable Object lifecycle independent from the generated MCP App HTML.
 * The Worker composition root injects the built asset, while unit tests can use
 * an empty document without importing dist/document-app.html.
 */
export const createTabulaMcpSessionDurableObject = (documentAppHtml: string) =>
  class TabulaMcpSessionDurableObject {
    private handler: TabulaMcpWebHandler | null = null;

    constructor(
      private readonly state: DurableObjectStateLike,
      private readonly env: WorkerEnv,
    ) {}

    async fetch(request: Request) {
      const metadata = this.#metadataFromRequest(request);
      if (metadata) {
        await this.state.storage.put(sessionMetadataKey, metadata);
        await this.state.storage.setAlarm(
          Date.now() + positiveIntegerFromEnv(
            this.env.TABULA_MCP_SESSION_IDLE_TTL_MS,
            DEFAULT_SESSION_IDLE_TTL_MS,
          ),
        );
      }
      const forcedSessionId = request.headers.get(forcedSessionIdHeader) ?? undefined;
      const roomSessionLifecycle = metadata ? {
        reserve: (roomSessionId: string) =>
          acquireQuotaRoom(this.env, metadata.clientKey, metadata.sessionId, roomSessionId),
        release: (roomSessionId: string) =>
          releaseQuotaRoom(this.env, metadata.clientKey, metadata.sessionId, roomSessionId),
      } : undefined;
      this.handler ??= createTabulaMcpWebHandler({
        deploymentMode: "remote",
        documentAppHtml,
        env: stringEnv(this.env),
        roomSessionLifecycle,
        ...(forcedSessionId ? { sessionIdGenerator: () => forcedSessionId } : {}),
      });
      const response = await this.handler.fetch(request);
      if (request.method === "DELETE" || response.status === 404) await this.#close(metadata);
      return response;
    }

    async alarm() {
      await this.#close(await this.state.storage.get<SessionMetadata>(sessionMetadataKey));
    }

    #metadataFromRequest(request: Request): SessionMetadata | undefined {
      const clientKey = request.headers.get(internalClientKeyHeader);
      const sessionId = request.headers.get(internalSessionIdHeader);
      return clientKey && sessionId ? { clientKey, sessionId } : undefined;
    }

    async #close(metadata?: SessionMetadata) {
      const handler = this.handler;
      this.handler = null;
      if (handler) await handler.close();
      if (metadata) await releaseQuotaSession(this.env, metadata.clientKey, metadata.sessionId).catch(() => undefined);
      await this.state.storage.delete(sessionMetadataKey);
      await this.state.storage.deleteAlarm();
    }
  };
