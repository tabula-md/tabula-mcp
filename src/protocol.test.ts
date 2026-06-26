import { describe, expect, it } from "vitest";
import { parseRoomShareUrl, resolveRoomServerUrl } from "./protocol.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

describe("room protocol helpers", () => {
  it("parses Tabula room URLs without exposing the key in derived metadata", () => {
    const parsed = parseRoomShareUrl(`https://tabula.md/r/room_123#key=${roomKey}`);

    expect(parsed).toEqual({
      roomId: "room_123",
      roomKey,
      appOrigin: "https://tabula.md",
    });
  });

  it("rejects room URLs without a valid client-only key", () => {
    expect(() => parseRoomShareUrl("https://tabula.md/r/room_123")).toThrow(/#key/);
    expect(() => parseRoomShareUrl("https://tabula.md/r/room_123#key=bad")).toThrow(/32 bytes/);
  });

  it("resolves local room servers automatically but requires configuration for hosted app links", () => {
    expect(resolveRoomServerUrl({ appOrigin: "http://localhost:5173", env: {} })).toBe("http://localhost:3002");
    expect(
      resolveRoomServerUrl({
        appOrigin: "https://tabula.md",
        roomServerUrl: "https://rooms.example.com/",
        env: {},
      }),
    ).toBe("https://rooms.example.com");
    expect(() => resolveRoomServerUrl({ appOrigin: "https://tabula.md", env: {} })).toThrow(/Room server URL/);
  });
});
