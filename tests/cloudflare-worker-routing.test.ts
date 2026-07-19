import { describe, expect, it, vi } from "vitest";
import worker, { cloudflareReadiness, routeMcpRequestToSession } from "../workers/tabula-mcp-worker.js";
import type { WorkerEnv } from "../workers/tabula-mcp-session-do.js";

describe("Cloudflare Worker MCP session routing", () => {
  it("reports missing runtime dependencies without exposing secret values", () => {
    expect(cloudflareReadiness({})).toEqual({
      ready: false,
      missing: ["TABULA_MCP_SESSIONS", "TABULA_MCP_QUOTA", "TABULA_MCP_QUOTA_HASH_SECRET"],
    });
    expect(cloudflareReadiness({
      TABULA_MCP_SESSIONS: {} as never,
      TABULA_MCP_QUOTA: {} as never,
      TABULA_MCP_QUOTA_HASH_SECRET: "configured-secret-value",
    })).toEqual({ ready: true, missing: [] });
  });

  it("returns 503 from /ready when required Cloudflare runtime configuration is missing", async () => {
    const response = await worker.fetch(new Request("https://mcp.tabula.md/ready"), {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      service: "tabula-mcp",
      version: "0.8.1",
      deploymentMode: "remote",
      code: "runtime_not_ready",
      missing: ["TABULA_MCP_SESSIONS", "TABULA_MCP_QUOTA", "TABULA_MCP_QUOTA_HASH_SECRET"],
    });
  });

  it("routes initialize, follow-up, and delete requests through one named Session Durable Object", async () => {
    const routedSessionIds: string[] = [];
    const sessionRequests: Request[] = [];
    const sessionNamespace = {
      getByName: vi.fn((sessionId: string) => ({
        fetch: vi.fn(async (request: Request) => {
          routedSessionIds.push(sessionId);
          sessionRequests.push(request);
          const headers = new Headers({ "content-type": "application/json" });
          if (request.headers.get("x-tabula-mcp-forced-session-id") === sessionId) {
            headers.set("mcp-session-id", sessionId);
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 }), { headers });
        }),
      })),
    };
    const quotaRequests: Request[] = [];
    const quotaNamespace = {
      getByName: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          quotaRequests.push(request);
          return request.method === "DELETE"
            ? Response.json({ released: true })
            : Response.json({ allowed: true });
        }),
      })),
    };
    const env = {
      TABULA_MCP_SESSIONS: sessionNamespace,
      TABULA_MCP_QUOTA: quotaNamespace,
      TABULA_MCP_QUOTA_HASH_SECRET: "routing-test-secret",
    } as unknown as WorkerEnv;
    const initializeBody = JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: 1 });
    const initialize = await routeMcpRequestToSession(new Request("https://mcp.tabula.md/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.12" },
      body: initializeBody,
    }), env);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const followUp = await routeMcpRequestToSession(new Request("https://mcp.tabula.md/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.12",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    }), env);
    expect(followUp.status).toBe(200);

    const closed = await routeMcpRequestToSession(new Request("https://mcp.tabula.md/mcp", {
      method: "DELETE",
      headers: { "cf-connecting-ip": "203.0.113.12", "mcp-session-id": sessionId! },
    }), env);
    expect(closed.status).toBe(200);
    expect(routedSessionIds).toEqual([sessionId, sessionId, sessionId]);
    expect(sessionNamespace.getByName).toHaveBeenCalledTimes(3);
    expect(sessionRequests[0]?.headers.get("x-tabula-mcp-session-id")).toBe(sessionId);
    expect(sessionRequests[1]?.headers.get("x-tabula-mcp-forced-session-id")).toBeNull();
    expect(quotaRequests.some((request) => request.method === "DELETE")).toBe(true);
  });
});
