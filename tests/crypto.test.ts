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

  it("hashes Markdown deterministically for patch preconditions", async () => {
    await expect(sha256Text("same text")).resolves.toBe(await sha256Text("same text"));
    await expect(sha256Text("same text")).resolves.not.toBe(await sha256Text("different text"));
  });
});
