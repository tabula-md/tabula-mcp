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
});
