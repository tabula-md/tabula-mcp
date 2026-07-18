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
