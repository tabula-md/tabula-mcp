import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  decryptEnvelopeForRoom,
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "../src/crypto.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");

describe("room encryption", () => {
  it("round-trips encrypted Yjs snapshots without plaintext fields", async () => {
    const key = await importRoomKey(roomKey);
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("markdown").insert(0, "# Shared\n\nHello from Tabula MCP");

    const envelope = await encryptBytesForRoom(
      key,
      "room_123",
      "snapshot",
      1,
      Y.encodeStateAsUpdate(sourceDoc),
    );

    expect(envelope).toMatchObject({
      v: 1,
      roomId: "room_123",
      kind: "snapshot",
      version: 1,
    });
    expect(JSON.stringify(envelope)).not.toContain("Hello from Tabula MCP");

    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, await decryptEnvelopeForRoom(key, envelope));
    expect(restoredDoc.getText("markdown").toString()).toBe("# Shared\n\nHello from Tabula MCP");
  });

  it("authenticates room envelope metadata and supports state-init", async () => {
    const key = await importRoomKey(roomKey);
    const envelope = await encryptBytesForRoom(key, "room_123", "state-init", 2, new TextEncoder().encode("state"));

    await expect(decryptEnvelopeForRoom(key, envelope)).resolves.toEqual(new TextEncoder().encode("state"));
    await expect(
      decryptEnvelopeForRoom(key, {
        ...envelope,
        kind: "yjs-update",
      }),
    ).rejects.toThrow();
  });

  it("round-trips encrypted room events without exposing proposal plaintext in the envelope", async () => {
    const key = await importRoomKey(roomKey);
    const event = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        id: "event_123",
        type: "patch.proposed",
        roomId: "room_123",
        actorId: "agent_123",
        createdAt: "2026-06-18T00:00:00.000Z",
      }),
    );
    const envelope = await encryptBytesForRoom(key, "room_123", "room-event", 3, event);

    expect(envelope).toMatchObject({
      v: 1,
      roomId: "room_123",
      kind: "room-event",
      version: 3,
    });
    expect(JSON.stringify(envelope)).not.toContain("patch.proposed");
    await expect(decryptEnvelopeForRoom(key, envelope)).resolves.toEqual(event);
  });

  it("hashes Markdown deterministically for patch preconditions", async () => {
    await expect(sha256Text("same text")).resolves.toBe(await sha256Text("same text"));
    await expect(sha256Text("same text")).resolves.not.toBe(await sha256Text("different text"));
    await expect(sha256Text("hello")).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
