import { describe, expect, it, vi } from "vitest";
import { TabulaCoreError } from "../src/core-errors.js";
import { SessionRegistry } from "../src/registry.js";
import type { TabulaRoomClient } from "../src/room-client.js";

const client = (sessionId: string, shareUrl = `https://tabula.md/#room=${sessionId},secret`) => ({
  sessionId,
  shareUrl,
  disconnect: vi.fn(),
}) as unknown as TabulaRoomClient;

describe("SessionRegistry", () => {
  it("requires explicit handles and never falls back to another Room", async () => {
    const registry = new SessionRegistry();
    const first = client("session-1");
    const second = client("session-2");
    await registry.reserve(first.sessionId);
    registry.add(first);
    await registry.reserve(second.sessionId);
    registry.add(second);

    expect(registry.get(second.sessionId)).toBe(second);
    expect(() => registry.get("unknown")).toThrowError(TabulaCoreError);
    try {
      registry.get("unknown");
    } catch (error) {
      expect(error).toMatchObject({ code: "session_not_found" });
    }
    await registry.clear();
  });

  it("reserves quota before connection, releases one leave, and bounds concurrent Rooms", async () => {
    const reserve = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const registry = new SessionRegistry({ lifecycle: { reserve, release }, maxSessions: 1 });
    const first = client("session-1");
    await registry.reserve(first.sessionId);
    expect(reserve).toHaveBeenCalledWith(first.sessionId);
    registry.add(first);

    await expect(registry.reserve("session-2")).rejects.toMatchObject({
      code: "session_limit",
      details: { limit: 1 },
    });
    expect(reserve).toHaveBeenCalledTimes(1);

    await expect(registry.leave(first.sessionId)).resolves.toBe(true);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(first.sessionId);
    await expect(registry.leave(first.sessionId)).resolves.toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases a failed reservation and every connected Room during cleanup", async () => {
    const reserve = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const registry = new SessionRegistry({ lifecycle: { reserve, release }, maxSessions: 3 });
    const first = client("session-1");
    const second = client("session-2");
    await registry.reserve(first.sessionId);
    registry.add(first);
    await registry.reserve(second.sessionId);
    registry.add(second);
    await registry.reserve("session-3");
    await registry.cancelReservation("session-3");
    await registry.clear();

    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.disconnect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("session-1");
    expect(release).toHaveBeenCalledWith("session-2");
    expect(release).toHaveBeenCalledWith("session-3");
    expect(registry.size).toBe(0);
  });

  it("connects one client for concurrent joins and reuses it after settlement", async () => {
    const registry = new SessionRegistry();
    const shareUrl = "https://tabula.md/#room=private,secret";
    const connected = client("session-1", shareUrl);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const connect = vi.fn(async () => {
      await gate;
      await registry.reserve(connected.sessionId);
      registry.add(connected);
      return connected;
    });

    const first = registry.ensureRoom(shareUrl, connect);
    const concurrent = registry.ensureRoom(shareUrl, connect);
    release?.();

    await expect(first).resolves.toEqual({ client: connected, reused: false });
    await expect(concurrent).resolves.toEqual({ client: connected, reused: true });
    await expect(registry.ensureRoom(shareUrl, connect)).resolves.toEqual({ client: connected, reused: true });
    expect(connect).toHaveBeenCalledOnce();
    await registry.clear();
  });

  it("allows a fresh join after the single-flight connector fails", async () => {
    const registry = new SessionRegistry();
    const shareUrl = "https://tabula.md/#room=private,secret";
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(async () => {
        const connected = client("session-2", shareUrl);
        await registry.reserve(connected.sessionId);
        registry.add(connected);
        return connected;
      });

    await expect(registry.ensureRoom(shareUrl, connect)).rejects.toThrow("offline");
    await expect(registry.ensureRoom(shareUrl, connect)).resolves.toMatchObject({ reused: false });
    expect(connect).toHaveBeenCalledTimes(2);
    await registry.clear();
  });
});
