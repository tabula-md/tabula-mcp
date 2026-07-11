import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { decryptEnvelopeForRoom, importRoomKey } from "../src/crypto.js";
import { decodeBase64Url, encodeBase64Url, type EncryptedEnvelope } from "../src/protocol.js";
import {
  createEncryptedMarkdownSnapshot,
  createEncryptedJsonShareSnapshot,
  createEncryptedJsonShareWorkspaceSnapshot,
  createJsonShareUrl,
  createRoomShareUrl,
  generateJsonShareKey,
  generateRoomId,
  generateRoomKey,
  resolveJsonShareServerUrl,
  shareMarkdownDocument,
  shareMarkdownWorkspace,
} from "../src/share.js";

const roomId = "room_123";
const roomKey = encodeBase64Url(new Uint8Array(32).fill(7));
const snapshotId = "snapshot_123";
const snapshotKey = encodeBase64Url(new Uint8Array(32).fill(9));

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
  it("generates URL-safe room ids and 32-byte share keys", () => {
    expect(generateRoomId()).toMatch(/^[A-Za-z0-9_-]+$/);

    const generatedRoomKey = generateRoomKey();
    expect(generatedRoomKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64Url(generatedRoomKey).byteLength).toBe(32);

    const generatedSnapshotKey = generateJsonShareKey();
    expect(generatedSnapshotKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64Url(generatedSnapshotKey).byteLength).toBe(32);
  });

  it("creates room and JSON share URLs with keys in the fragment", () => {
    expect(createRoomShareUrl({ appOrigin: "https://tabula.md", roomId, roomKey })).toBe(
      `https://tabula.md/#room=${roomId},${roomKey}`,
    );
    expect(createJsonShareUrl({ appOrigin: "https://tabula.md", snapshotId, snapshotKey })).toBe(
      `https://tabula.md/#json=${snapshotId},${snapshotKey}`,
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

  it("encrypts Markdown into an opaque JSON snapshot blob", async () => {
    const encrypted = await createEncryptedJsonShareSnapshot({
      title: "Secret Plan",
      markdown: "# Secret\n\nLocal only",
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });
    const body = Buffer.from(encrypted).toString("utf8");

    expect(encrypted.slice(0, 4)).toEqual(new Uint8Array([0x54, 0x42, 0x45, 0x31]));
    expect(body).not.toContain("# Secret");
    expect(body).not.toContain("Local only");
    expect(body).not.toContain(snapshotKey);
  });

  it("encrypts multi-file workspaces into opaque JSON snapshot blobs", async () => {
    const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
      files: [
        { id: "readme", title: "README.md", text: "# Readme\n" },
        { id: "plan", title: "Plan.md", text: "# Plan\n\nSecret plan" },
      ],
      activeFileId: "plan",
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });
    const body = Buffer.from(encrypted).toString("utf8");

    expect(encrypted.slice(0, 4)).toEqual(new Uint8Array([0x54, 0x42, 0x45, 0x31]));
    expect(body).not.toContain("Secret plan");
    expect(body).not.toContain("Plan.md");
    expect(body).not.toContain(snapshotKey);
  });

  it("uploads only an encrypted JSON snapshot and returns a bearer share URL", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: snapshotId,
          data: `https://json.tabula.md/api/v2/${snapshotId}`,
          expiresAt: "2026-07-12T00:00:00.000Z",
        }),
        { status: 200 },
      );
    };

    const result = await shareMarkdownDocument({
      title: "Secret Plan",
      markdown: "# Secret\n\nDo not upload plaintext",
      appOrigin: "https://tabula.md",
      fetchImpl,
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      title: "Secret Plan",
      linkKind: "json-snapshot",
      snapshotId,
      appOrigin: "https://tabula.md",
      jsonServerUrl: "https://json.tabula.md",
      snapshotUrl: `https://json.tabula.md/api/v2/${snapshotId}`,
      shareUrl: `https://tabula.md/#json=${snapshotId},${snapshotKey}`,
      encrypted: true,
      secret: true,
      keyLocation: "url-fragment",
      textLength: "# Secret\n\nDo not upload plaintext".length,
      expiresAt: "2026-07-12T00:00:00.000Z",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://json.tabula.md/api/v2/post/");

    const body = Buffer.from(fetchCalls[0]?.init.body as ArrayBuffer).toString("utf8");
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(fetchCalls[0]?.init.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(body).not.toContain("# Secret");
    expect(body).not.toContain("Do not upload plaintext");
    expect(body).not.toContain(snapshotKey);
  });

  it("uploads encrypted workspace snapshots with multiple files", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: snapshotId,
          data: `https://json.tabula.md/api/v2/${snapshotId}`,
        }),
        { status: 200 },
      );
    };

    const result = await shareMarkdownWorkspace({
      title: "Workspace",
      files: [
        { id: "readme", title: "README.md", text: "# Readme\n" },
        { id: "plan", title: "Plan.md", text: "# Plan\n\nDo not upload plaintext" },
      ],
      activeFileId: "plan",
      appOrigin: "https://tabula.md",
      fetchImpl,
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      title: "Workspace",
      linkKind: "json-snapshot",
      snapshotId,
      fileCount: 2,
      textLength: "# Readme\n".length + "# Plan\n\nDo not upload plaintext".length,
      shareUrl: `https://tabula.md/#json=${snapshotId},${snapshotKey}`,
      encrypted: true,
      secret: true,
      keyLocation: "url-fragment",
    });
    expect(fetchCalls).toHaveLength(1);
    const body = Buffer.from(fetchCalls[0]?.init.body as ArrayBuffer).toString("utf8");
    expect(body).not.toContain("Do not upload plaintext");
    expect(body).not.toContain(snapshotKey);
  });

  it("uses local JSON snapshot service defaults for localhost app origins", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `http://localhost:3004/api/v2/${snapshotId}` }), {
        status: 200,
      });
    const result = await shareMarkdownDocument({
      markdown: "# Local",
      appOrigin: "http://localhost:5173",
      fetchImpl,
      snapshotKey,
    });

    expect(result.jsonServerUrl).toBe("http://localhost:3004");
    expect(result.snapshotUrl).toBe(`http://localhost:3004/api/v2/${snapshotId}`);
    expect(result.shareUrl).toBe(`http://localhost:5173/#json=${snapshotId},${snapshotKey}`);
  });

  it("preserves custom JSON snapshot service URLs", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.example.com/api/v2/${snapshotId}` }), {
        status: 200,
      });
    const result = await shareMarkdownDocument({
      markdown: "# Custom Transport",
      appOrigin: "https://tabula.md",
      jsonServerUrl: "https://json.example.com/",
      fetchImpl,
      snapshotKey,
    });

    expect(result.jsonServerUrl).toBe("https://json.example.com");
    expect(result.snapshotUrl).toBe(`https://json.example.com/api/v2/${snapshotId}`);
    expect(result.shareUrl).toBe(`https://tabula.md/#json=${snapshotId},${snapshotKey}`);
  });

  it("resolves JSON snapshot service URLs", () => {
    expect(resolveJsonShareServerUrl({ appOrigin: "https://tabula.md", env: {} })).toBe("https://json.tabula.md");
    expect(resolveJsonShareServerUrl({ appOrigin: "http://localhost:5173", env: {} })).toBe("http://localhost:3004");
    expect(
      resolveJsonShareServerUrl({
        appOrigin: "https://tabula.example.com",
        env: { TABULA_JSON_URL: "https://json.example.com/" },
      }),
    ).toBe("https://json.example.com");
    expect(() => resolveJsonShareServerUrl({ appOrigin: "https://tabula.example.com", env: {} })).toThrow(
      /JSON snapshot service URL/,
    );
  });

  it("blocks unallowlisted custom JSON snapshot egress in production", () => {
    expect(() =>
      resolveJsonShareServerUrl({
        appOrigin: "https://tabula.md",
        jsonServerUrl: "https://json.example.com/",
        env: { TABULA_MCP_PRODUCTION: "1" },
      }),
    ).toThrow(/does not allow Tabula JSON snapshot service egress/);

    expect(
      resolveJsonShareServerUrl({
        appOrigin: "https://tabula.md",
        jsonServerUrl: "https://json.example.com/",
        env: {
          TABULA_MCP_PRODUCTION: "1",
          TABULA_MCP_ALLOWED_JSON_SERVER_URLS: "https://json.example.com",
        },
      }),
    ).toBe("https://json.example.com");
  });

  it("returns clear errors when encrypted upload fails", async () => {
    await expect(
      shareMarkdownDocument({
        markdown: "# Draft",
        fetchImpl: async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
        snapshotKey,
      }),
    ).rejects.toThrow(/HTTP 500: nope/);
  });
});
