import { env } from "cloudflare:workers";
import {
  listDurableObjectIds,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { quotaClientKey } from "../../src/server/cloudflare-quota.js";

const clientIp = "203.0.113.42";
const quotaHashSecret = "workerd-session-isolation-secret";
const sessionMetadataKey = "mcp-session-metadata-v1";
const quotaStateKey = "quota-v2";

type SessionMetadata = { clientKey: string; sessionId: string };
type StoredQuotaState = {
  sessions: Record<string, { expiresAt: number; rooms: Record<string, { expiresAt: number }> }>;
};
type TestEnv = {
  TABULA_MCP_QUOTA: DurableObjectNamespace;
  TABULA_MCP_SESSIONS: DurableObjectNamespace;
};

const testEnv = env as unknown as TestEnv;

const mcpRequest = async ({
  body,
  method = "POST",
  sessionId,
}: {
  body?: Record<string, unknown>;
  method?: "DELETE" | "POST";
  sessionId?: string;
}) => SELF.fetch(new Request("https://mcp.tabula.md/mcp", {
  method,
  headers: {
    accept: "application/json, text/event-stream",
    "cf-connecting-ip": clientIp,
    ...(body ? { "content-type": "application/json" } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
}));

const initialize = async (id: number) => {
  const response = await mcpRequest({
    body: {
      id,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: `workerd-test-${id}`, version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    },
  });
  const responseBody = await response.text();
  expect(response.status, responseBody).toBe(200);
  expect(responseBody).toContain("protocolVersion");
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  return sessionId!;
};

const notifyInitialized = async (sessionId: string) => {
  const response = await mcpRequest({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  });
  expect([200, 202, 204]).toContain(response.status);
  await response.arrayBuffer();
};

const listTools = async (sessionId: string, id: number) => {
  const response = await mcpRequest({
    body: { id, jsonrpc: "2.0", method: "tools/list", params: {} },
    sessionId,
  });
  const responseBody = await response.text();
  expect(response.status, responseBody).toBe(200);
  expect(responseBody).toContain("list_files");
};

const sessionMetadata = (sessionId: string) => runInDurableObject<DurableObject, SessionMetadata | undefined>(
  testEnv.TABULA_MCP_SESSIONS.getByName(sessionId),
  async (_instance, state) => state.storage.get<SessionMetadata>(sessionMetadataKey),
);

const quotaState = async () => {
  const clientKey = await quotaClientKey(clientIp, quotaHashSecret);
  return runInDurableObject<DurableObject, StoredQuotaState | undefined>(
    testEnv.TABULA_MCP_QUOTA.getByName(clientKey),
    async (_instance, state) => state.storage.get<StoredQuotaState>(quotaStateKey),
  );
};

afterEach(async () => {
  await reset();
});

describe("production Worker Durable Object routing", () => {
  it("isolates concurrent MCP sessions and releases quota on DELETE and idle alarm", async () => {
    const sessionA = await initialize(1);
    const sessionB = await initialize(2);
    expect(sessionA).not.toBe(sessionB);

    await notifyInitialized(sessionA);
    await notifyInitialized(sessionB);
    await listTools(sessionA, 3);
    await listTools(sessionB, 4);

    await expect(sessionMetadata(sessionA)).resolves.toMatchObject({ sessionId: sessionA });
    await expect(sessionMetadata(sessionB)).resolves.toMatchObject({ sessionId: sessionB });
    const sessionObjectIds = await listDurableObjectIds(testEnv.TABULA_MCP_SESSIONS);
    expect(sessionObjectIds.some((id) => id.equals(testEnv.TABULA_MCP_SESSIONS.idFromName(sessionA)))).toBe(true);
    expect(sessionObjectIds.some((id) => id.equals(testEnv.TABULA_MCP_SESSIONS.idFromName(sessionB)))).toBe(true);
    await expect(quotaState()).resolves.toMatchObject({
      sessions: {
        [sessionA]: expect.any(Object),
        [sessionB]: expect.any(Object),
      },
    });

    const deleted = await mcpRequest({ method: "DELETE", sessionId: sessionA });
    expect(deleted.status).toBe(200);
    await deleted.arrayBuffer();
    const afterDelete = await quotaState();
    expect(Object.keys(afterDelete?.sessions ?? {})).toEqual([sessionB]);
    await expect(runDurableObjectAlarm(
      testEnv.TABULA_MCP_SESSIONS.getByName(sessionA),
    )).resolves.toBe(false);

    const sessionBStub = testEnv.TABULA_MCP_SESSIONS.getByName(sessionB);
    await expect(runDurableObjectAlarm(sessionBStub)).resolves.toBe(true);
    await expect(runDurableObjectAlarm(sessionBStub)).resolves.toBe(false);
    const afterAlarm = await quotaState();
    expect(afterAlarm?.sessions).toEqual({});

    const sessionC = await initialize(5);
    const sessionD = await initialize(6);
    expect(new Set([sessionC, sessionD]).size).toBe(2);
    expect(Object.keys((await quotaState())?.sessions ?? {})).toHaveLength(2);
  });

  it("does not retain quota or an idle alarm for an unknown MCP session", async () => {
    const unknownSessionId = crypto.randomUUID();
    const response = await mcpRequest({
      body: { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
      sessionId: unknownSessionId,
    });
    expect(response.status).toBe(404);
    await response.arrayBuffer();

    expect(Object.keys((await quotaState())?.sessions ?? {})).toEqual([]);
    await expect(runDurableObjectAlarm(
      testEnv.TABULA_MCP_SESSIONS.getByName(unknownSessionId),
    )).resolves.toBe(false);
  });
});
