import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { decryptEnvelopeForRoom, importRoomKey } from "./crypto.js";
import { decodeBase64Url, encodeBase64Url, type EncryptedEnvelope } from "./protocol.js";
import {
  createEncryptedMarkdownSnapshot,
  createRoomShareUrl,
  generateRoomId,
  generateRoomKey,
  shareMarkdownDocument,
} from "./share.js";

const roomId = "room_123";
const roomKey = encodeBase64Url(new Uint8Array(32).fill(7));

const restoreMarkdown = async (envelope: EncryptedEnvelope) => {
  const importedRoomKey = await importRoomKey(roomKey);
  const update = await decryptEnvelopeForRoom(importedRoomKey, envelope);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getText("markdown").toString();
  } finally {
    doc.destroy();
  }
};

describe("Tabula document sharing", () => {
  it("generates URL-safe room ids and 32-byte keys", () => {
    expect(generateRoomId()).toMatch(/^[A-Za-z0-9_-]+$/);

    const generatedRoomKey = generateRoomKey();
    expect(generatedRoomKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64Url(generatedRoomKey).byteLength).toBe(32);
  });

  it("creates share URLs with the room key in the fragment", () => {
    expect(createRoomShareUrl({ appOrigin: "https://tabula.md", roomId, roomKey })).toBe(
      `https://tabula.md/r/${roomId}#key=${roomKey}`,
    );
  });

  it("encrypts Markdown into a recoverable snapshot envelope", async () => {
    const envelope = await createEncryptedMarkdownSnapshot({
      roomId,
      roomKey,
      markdown: "# Secret\n\nLocal only",
    });

    expect(envelope).toMatchObject({
      v: 1,
      roomId,
      kind: "snapshot",
      version: 1,
    });
    expect(JSON.stringify(envelope)).not.toContain("# Secret");
    expect(await restoreMarkdown(envelope)).toBe("# Secret\n\nLocal only");
  });

  it("uploads only an encrypted snapshot and returns a bearer share URL", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };

    const result = await shareMarkdownDocument({
      title: "Secret Plan",
      markdown: "# Secret\n\nDo not upload plaintext",
      appOrigin: "https://tabula.md",
      fetchImpl,
      roomId,
      roomKey,
    });

    expect(result).toMatchObject({
      title: "Secret Plan",
      roomId,
      roomServerUrl: "https://rooms.tabula.md",
      shareUrl: `https://tabula.md/r/${roomId}#key=${roomKey}`,
      encrypted: true,
      textLength: "# Secret\n\nDo not upload plaintext".length,
      snapshotVersion: 1,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(`https://rooms.tabula.md/v1/rooms/${roomId}/snapshot`);

    const body = String(fetchCalls[0]?.init.body);
    expect(body).not.toContain("# Secret");
    expect(body).not.toContain("Do not upload plaintext");
    expect(body).not.toContain(roomKey);
    expect(JSON.parse(body)).toMatchObject({
      roomId,
      kind: "snapshot",
    });
  });

  it("uses local room server defaults for localhost app origins", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 201 });
    const result = await shareMarkdownDocument({
      markdown: "# Local",
      appOrigin: "http://localhost:5173",
      fetchImpl,
      roomId,
      roomKey,
    });

    expect(result.roomServerUrl).toBe("http://localhost:3002");
    expect(result.shareUrl).toBe(`http://localhost:5173/r/${roomId}#key=${roomKey}`);
  });

  it("returns clear errors when encrypted upload fails", async () => {
    await expect(
      shareMarkdownDocument({
        markdown: "# Draft",
        fetchImpl: async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
        roomId,
        roomKey,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
