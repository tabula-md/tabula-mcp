import { describe, expect, it, vi } from "vitest";
import { readRoomSnapshot } from "../../src/app/snapshots.js";
import type { SessionRegistry } from "../../src/registry.js";

describe("readRoomSnapshot", () => {
  it("returns a waiting room snapshot without reading an unhydrated workspace", async () => {
    const readMarkdown = vi.fn();
    const getOutline = vi.fn();
    const session = {
      getStatus: vi.fn(async () => ({
        sessionId: "00000000-0000-4000-8000-000000000001",
        roomId: "room_123",
        shareUrl: "https://tabula.md/#room=room_123,secret",
        status: "connected",
        writeAccess: false,
        textLength: 0,
        sha256: "0".repeat(64),
        peerCount: 1,
        collaborators: [],
        hydrationStatus: "waiting-for-peer-state",
        stateReceived: false,
      })),
      readMarkdown,
      getOutline,
    };
    const registry = {
      get: vi.fn(() => session),
    } as unknown as SessionRegistry;

    await expect(readRoomSnapshot(registry)).resolves.toMatchObject({
      mode: "room",
      markdown: "",
      outline: [],
      waitingForWorkspaceState: true,
      room: {
        hydrationStatus: "waiting-for-peer-state",
        stateReceived: false,
      },
    });
    const snapshot = await readRoomSnapshot(registry);
    expect(snapshot.room).not.toHaveProperty("peerCount");
    expect(snapshot.room).not.toHaveProperty("title");
    expect(snapshot.room.collaboratorCount).toBe(0);
    expect(readMarkdown).not.toHaveBeenCalled();
    expect(getOutline).not.toHaveBeenCalled();
  });
});
