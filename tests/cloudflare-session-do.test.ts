import { describe, expect, it, vi } from "vitest";
import { createTabulaMcpSessionDurableObject } from "../workers/tabula-mcp-session-do.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt?: number;
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  async setAlarm(value: number | Date) { this.alarmAt = value instanceof Date ? value.getTime() : value; }
  async deleteAlarm() { this.alarmAt = undefined; }
}

describe("TabulaMcpSessionDurableObject lifecycle", () => {
  it("uses the shared MCP and Room idle TTL for its durable cleanup alarm", async () => {
    const TabulaMcpSessionDurableObject = createTabulaMcpSessionDurableObject("");
    const storage = new MemoryStorage();
    const quotaFetch = vi.fn(async () => Response.json({ released: true }));
    const session = new TabulaMcpSessionDurableObject(
      { storage },
      {
        TABULA_MCP_QUOTA: { getByName: () => ({ fetch: quotaFetch }) },
        TABULA_MCP_SESSION_IDLE_TTL_MS: "1234",
      },
    );
    const startedAt = Date.now();

    const response = await session.fetch(new Request("https://mcp.tabula.md/health", {
      headers: {
        "x-tabula-mcp-client-key": "client-key",
        "x-tabula-mcp-session-id": "mcp-session",
      },
    }));

    expect(response.status).toBe(200);
    expect(storage.alarmAt).toBeGreaterThanOrEqual(startedAt + 1_234);
    expect(storage.alarmAt).toBeLessThanOrEqual(Date.now() + 1_234);
    await session.alarm();
  });

  it("releases its client quota lease when an idle alarm fires", async () => {
    const TabulaMcpSessionDurableObject = createTabulaMcpSessionDurableObject("");
    const storage = new MemoryStorage();
    await storage.put("mcp-session-metadata-v1", { clientKey: "client-key", sessionId: "mcp-session" });
    const quotaFetch = vi.fn(async () => Response.json({ released: true }));
    const getByName = vi.fn(() => ({ fetch: quotaFetch }));
    const session = new TabulaMcpSessionDurableObject(
      { storage },
      { TABULA_MCP_QUOTA: { getByName } },
    );

    await session.alarm();

    expect(getByName).toHaveBeenCalledWith("client-key");
    expect(quotaFetch).toHaveBeenCalledOnce();
    const request = quotaFetch.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("DELETE");
    await expect(request.json()).resolves.toEqual({ sessionId: "mcp-session" });
    expect(storage.values.has("mcp-session-metadata-v1")).toBe(false);
    expect(storage.alarmAt).toBeUndefined();
  });
});
