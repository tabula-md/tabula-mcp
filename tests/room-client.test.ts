import { describe, expect, it } from "vitest";
import { parseRoomShareUrl } from "../src/protocol.js";
import { TabulaRoomClient } from "../src/room-client.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

const createClient = () =>
  new TabulaRoomClient({
    parsedRoom: parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}`),
    roomServerUrl: "https://rooms.tabula.md",
    writeAccess: true,
  });

describe("TabulaRoomClient room state hydration", () => {
  it("reports waiting-for-peer-state before receiving live room state", async () => {
    const client = createClient();
    try {
      await expect(client.readMarkdown()).resolves.toMatchObject({
        hydrationStatus: "waiting-for-peer-state",
        stateReceived: false,
        markdown: "",
      });
    } finally {
      client.disconnect();
    }
  });

  it("blocks room writes before a state-init or yjs-update has arrived", async () => {
    const client = createClient();
    try {
      await expect(
        client.applyPatches({
          patches: [{ from: 0, to: 0, insert: "# Draft" }],
        }),
      ).rejects.toThrow(/state has not been received/);
    } finally {
      client.disconnect();
    }
  });
});
