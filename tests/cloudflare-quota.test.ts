import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeQuotaIdentity,
  quotaClientKey,
  TabulaMcpQuotaDurableObject,
} from "../src/server/cloudflare-quota.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt?: number;
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async setAlarm(value: number | Date) { this.alarmAt = value instanceof Date ? value.getTime() : value; }
  async deleteAlarm() { this.alarmAt = undefined; }
}

const request = (
  sessionId: string,
  operation: "request" | "mutation" | "export" = "request",
  units = 1,
) => new Request("https://tabula.internal/quota", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, operation, units }),
});

const roomRequest = (sessionId: string, roomSessionId: string, method: "DELETE" | "POST" = "POST") =>
  new Request("https://tabula.internal/rooms", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, roomSessionId }),
  });

const createQuota = (storage: MemoryStorage, env: Record<string, string> = {}) =>
  new TabulaMcpQuotaDurableObject(
    { storage },
    {
      TABULA_MCP_MAX_SESSIONS_PER_CLIENT: "10",
      TABULA_MCP_RATE_LIMIT_MAX: "20",
      ...env,
    },
  );

afterEach(() => vi.useRealTimers());

describe("Cloudflare per-client MCP quota", () => {
  it("derives a private stable shard key from a normalized network prefix", async () => {
    expect(normalizeQuotaIdentity("203.0.113.5")).toBe("203.0.113.0/24");
    expect(normalizeQuotaIdentity("203.0.113.99")).toBe("203.0.113.0/24");
    expect(normalizeQuotaIdentity("2001:db8:1234:5678:abcd::1")).toBe("2001:0db8:1234:5678::/64");
    const first = await quotaClientKey("203.0.113.5", "test-secret");
    const samePrefix = await quotaClientKey("203.0.113.99", "test-secret");
    expect(first).toBe(samePrefix);
    expect(first).not.toContain("203.0.113");
    await expect(quotaClientKey("203.0.113.5", "")).rejects.toThrow("QUOTA_HASH_SECRET");
  });

  it("counts active sessions across otherwise independent session Durable Objects", async () => {
    const quota = createQuota(new MemoryStorage(), { TABULA_MCP_MAX_SESSIONS_PER_CLIENT: "2" });

    await expect((await quota.fetch(request("session-1"))).json())
      .resolves.toMatchObject({ allowed: true, activeSessions: 1 });
    await expect((await quota.fetch(request("session-2"))).json())
      .resolves.toMatchObject({ allowed: true, activeSessions: 2 });
    await expect((await quota.fetch(request("session-3"))).json())
      .resolves.toMatchObject({ allowed: false, reason: "client_session_limit", activeSessions: 2 });
  });

  it("does not reset the request counter when a client creates another MCP session", async () => {
    const quota = createQuota(new MemoryStorage(), {
      TABULA_MCP_RATE_LIMIT_MAX: "2",
      TABULA_MCP_RATE_LIMIT_WINDOW_MS: "60000",
    });

    await quota.fetch(request("session-1"));
    await quota.fetch(request("session-2"));
    await expect((await quota.fetch(request("session-3"))).json())
      .resolves.toMatchObject({ allowed: false, reason: "rate_limited", remaining: 0 });
  });

  it("limits active Room leases across MCP sessions and releases only the requested Room", async () => {
    const quota = createQuota(new MemoryStorage(), { TABULA_MCP_MAX_ROOMS_PER_CLIENT: "2" });
    await quota.fetch(request("session-1"));
    await quota.fetch(request("session-2"));
    await expect((await quota.fetch(roomRequest("session-1", "room-1"))).json())
      .resolves.toMatchObject({ allowed: true, activeRooms: 1 });
    await expect((await quota.fetch(roomRequest("session-2", "room-2"))).json())
      .resolves.toMatchObject({ allowed: true, activeRooms: 2 });
    await expect((await quota.fetch(roomRequest("session-1", "room-3"))).json())
      .resolves.toMatchObject({ allowed: false, reason: "client_room_limit", activeRooms: 2 });

    await quota.fetch(roomRequest("session-1", "room-1", "DELETE"));
    await expect((await quota.fetch(roomRequest("session-1", "room-3"))).json())
      .resolves.toMatchObject({ allowed: true, activeRooms: 2 });
  });

  it("enforces separate mutation and export-byte budgets", async () => {
    const mutationQuota = createQuota(new MemoryStorage(), {
      TABULA_MCP_MUTATION_RATE_LIMIT_MAX: "1",
    });
    await expect((await mutationQuota.fetch(request("session-1", "mutation"))).json())
      .resolves.toMatchObject({ allowed: true });
    await expect((await mutationQuota.fetch(request("session-1", "mutation"))).json())
      .resolves.toMatchObject({ allowed: false, reason: "mutation_rate_limited" });

    const exportQuota = createQuota(new MemoryStorage(), { TABULA_MCP_EXPORT_BYTES_LIMIT: "10" });
    await expect((await exportQuota.fetch(request("session-1", "export", 7))).json())
      .resolves.toMatchObject({ allowed: true });
    await expect((await exportQuota.fetch(request("session-1", "export", 4))).json())
      .resolves.toMatchObject({ allowed: false, reason: "export_rate_limited" });
  });

  it("releases explicit disconnects and expires abandoned leases through an alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    const storage = new MemoryStorage();
    const quota = createQuota(storage, {
      TABULA_MCP_MAX_SESSIONS_PER_CLIENT: "1",
      TABULA_MCP_SESSION_IDLE_TTL_MS: "1000",
    });
    await quota.fetch(request("session-1"));
    expect(storage.alarmAt).toBe(Date.now() + 1000);

    await quota.fetch(new Request("https://tabula.internal/quota", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    }));
    await expect((await quota.fetch(request("session-2"))).json())
      .resolves.toMatchObject({ allowed: true, activeSessions: 1 });

    vi.advanceTimersByTime(1001);
    await quota.alarm();
    await expect((await quota.fetch(request("session-3"))).json())
      .resolves.toMatchObject({ allowed: true, activeSessions: 1 });
  });
});
