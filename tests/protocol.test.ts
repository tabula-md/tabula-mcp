import { describe, expect, it } from "vitest";
import { assertEncryptedEnvelope, encodeBase64Url, parseRoomShareUrl, resolveRoomServerUrl } from "../src/protocol.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const shortRoomKey = encodeBase64Url(new Uint8Array(31).fill(7));

const nonCanonicalBase64Url = (value: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastCharacter = value.at(-1);
  const lastIndex = lastCharacter ? alphabet.indexOf(lastCharacter) : -1;
  if (lastIndex < 0) {
    throw new Error("Cannot create non-canonical base64url test value.");
  }
  const replacement = alphabet[(lastIndex + 1) % alphabet.length];
  return `${value.slice(0, -1)}${replacement}`;
};

describe("room protocol helpers", () => {
  it("parses Tabula room URLs without exposing the key in derived metadata", () => {
    const parsed = parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}`);

    expect(parsed).toEqual({
      roomId: "room_123",
      roomKey,
      appOrigin: "https://tabula.md",
      shareUrl: `https://tabula.md/#room=room_123,${roomKey}`,
    });
  });

  it("rejects room URLs without a valid client-only room fragment", () => {
    expect(() => parseRoomShareUrl("https://tabula.md/r/room_123")).toThrow(/root/);
    expect(() => parseRoomShareUrl("https://tabula.md/r/room_123#key=bad")).toThrow(/root/);
    expect(() => parseRoomShareUrl("https://tabula.md/#room=room_123")).toThrow(/exactly one/);
    expect(() => parseRoomShareUrl(`https://tabula.md/#room=room_123,${shortRoomKey}`)).toThrow(/32 bytes/);
    expect(() => parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}&extra=value`)).toThrow(/exactly one/);
    expect(() => parseRoomShareUrl(`https://tabula.md/#room=room_123,${nonCanonicalBase64Url(roomKey)}`)).toThrow(
      /base64url/,
    );
  });

  it("resolves local and official hosted room servers automatically", () => {
    expect(resolveRoomServerUrl({ appOrigin: "http://localhost:5173", env: {} })).toBe("http://localhost:3002");
    expect(resolveRoomServerUrl({ appOrigin: "https://tabula.md", env: {} })).toBe("https://rooms.tabula.md");
    expect(resolveRoomServerUrl({ appOrigin: "https://www.tabula.md", env: {} })).toBe("https://rooms.tabula.md");
  });

  it("lets explicit configuration override inferred room servers", () => {
    expect(
      resolveRoomServerUrl({
        appOrigin: "https://tabula.md",
        roomServerUrl: "https://rooms.example.com/",
        env: {},
      }),
    ).toBe("https://rooms.example.com");
  });

  it("blocks unallowlisted custom room server egress in production", () => {
    expect(() =>
      resolveRoomServerUrl({
        appOrigin: "https://tabula.md",
        roomServerUrl: "https://rooms.example.com/",
        env: { TABULA_MCP_PRODUCTION: "1" },
      }),
    ).toThrow(/does not allow Tabula Room server egress/);

    expect(
      resolveRoomServerUrl({
        appOrigin: "https://tabula.md",
        roomServerUrl: "https://rooms.example.com/",
        env: {
          TABULA_MCP_PRODUCTION: "1",
          TABULA_MCP_ALLOWED_ROOM_SERVER_URLS: "https://rooms.example.com",
        },
      }),
    ).toBe("https://rooms.example.com");
  });

  it("requires configuration for self-hosted app links", () => {
    expect(() => resolveRoomServerUrl({ appOrigin: "https://tabula.example.com", env: {} })).toThrow(
      /self-hosted Tabula links/,
    );
  });

  it("rejects malformed encrypted room envelopes before decrypting", () => {
    const envelope = {
      v: 1,
      roomId: "room_123",
      kind: "room-event",
      version: 1,
      iv: encodeBase64Url(new Uint8Array(12).fill(1)),
      ciphertext: encodeBase64Url(new Uint8Array([1, 2, 3])),
      createdAt: "2026-07-05T00:00:00.000Z",
    } as const;

    expect(assertEncryptedEnvelope(envelope, "room_123")).toEqual(envelope);
    expect(() =>
      assertEncryptedEnvelope(
        {
          ...envelope,
          kind: "state-init",
        },
        "room_123",
      ),
    ).toThrow(/not valid/);
    expect(() =>
      assertEncryptedEnvelope(
        {
          ...envelope,
          iv: encodeBase64Url(new Uint8Array(11).fill(1)),
        },
        "room_123",
      ),
    ).toThrow(/invalid iv/);
    expect(() =>
      assertEncryptedEnvelope(
        {
          ...envelope,
          ciphertext: encodeBase64Url(new Uint8Array(1024 * 1024 + 1).fill(1)),
        },
        "room_123",
      ),
    ).toThrow(/too large/);
    expect(() =>
      assertEncryptedEnvelope(
        {
          ...envelope,
          createdAt: "not-a-date",
        },
        "room_123",
      ),
    ).toThrow(/not valid/);
  });
});
