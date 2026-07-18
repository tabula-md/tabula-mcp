import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { decodeEncryptedData } from "@tabula-md/tabula/data/encode";
import { parseShareSnapshot } from "@tabula-md/tabula/data/json";
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
import { importCopy } from "../src/import-copy-service.js";
import { OperationLedger } from "../src/server/operation-ledger.js";

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

const restoreJsonSnapshot = async (encrypted: Uint8Array) => {
  const decoded = await decodeEncryptedData<{ kind: string; schemaVersion: number }>(encrypted, {
    decryptionKey: snapshotKey,
  });
  return {
    metadata: decoded.metadata,
    payload: parseShareSnapshot(decoded.data),
  };
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
      title: "Review workspace",
      files: [
        { id: "readme", title: "README.md", text: "# Readme\n" },
        { id: "plan", title: "Plan.md", text: "# Plan\n\nSecret plan" },
      ],
      activeFileId: "plan",
      commentsByFileId: {
        plan: [{ id: "comment-1", body: "Check this", createdAt: "2026-07-05T00:00:00.000Z" }],
      },
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });
    const body = Buffer.from(encrypted).toString("utf8");

    expect(encrypted.slice(0, 4)).toEqual(new Uint8Array([0x54, 0x42, 0x45, 0x31]));
    expect(body).not.toContain("Secret plan");
    expect(body).not.toContain("Plan.md");
    expect(body).not.toContain(snapshotKey);
  });

  it("creates a schema v2 snapshot that Tabula can decrypt and parse", async () => {
    const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
      title: "Review workspace",
      files: [
        { id: "tabula-mcp-root", title: "README.md", text: "# Readme\n" },
        { id: "plan", title: "Plan.md", text: "# Plan\n\nReady to share" },
      ],
      activeFileId: "plan",
      commentsByFileId: {
        plan: [{ id: "comment-1", body: "Check this", createdAt: "2026-07-05T00:00:00.000Z" }],
      },
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });

    const { metadata, payload } = await restoreJsonSnapshot(encrypted);

    expect(metadata).toEqual({ kind: "json-share", schemaVersion: 2 });
    expect(payload).toMatchObject({
      schemaVersion: 2,
      createdAt: "2026-07-05T00:00:00.000Z",
      rootFolderId: "tabula-mcp-root-1",
      activeFileId: "plan",
      folders: [
        {
          id: "tabula-mcp-root-1",
          title: "Review workspace",
          parentId: null,
          order: 0,
        },
      ],
      files: [
        {
          id: "tabula-mcp-root",
          title: "README.md",
          text: "# Readme\n",
          parentId: "tabula-mcp-root-1",
          order: 0,
        },
        {
          id: "plan",
          title: "Plan.md",
          text: "# Plan\n\nReady to share",
          parentId: "tabula-mcp-root-1",
          order: 1,
        },
      ],
      commentsByFileId: {
        plan: [{ id: "comment-1", body: "Check this", createdAt: "2026-07-05T00:00:00.000Z" }],
      },
    });
  });

  it("preserves nested Markdown paths in exported copies", async () => {
    const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
      files: [
        { id: "readme", path: "README.md", title: "README.md", text: "# Readme\n" },
        { id: "plan", path: "docs/research/Plan.md", title: "Plan.md", text: "# Plan\n" },
      ],
      activeFileId: "plan",
      snapshotKey,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });

    const { payload } = await restoreJsonSnapshot(encrypted);
    const docs = payload.folders.find((folder) => folder.title === "docs");
    const research = payload.folders.find((folder) => folder.title === "research");
    const plan = payload.files.find((file) => file.id === "plan");

    expect(docs?.parentId).toBe(payload.rootFolderId);
    expect(research?.parentId).toBe(docs?.id);
    expect(plan?.parentId).toBe(research?.id);
    expect(plan?.text).toBe("# Plan\n");
  });

  it("uses the exported path basename as the file title", async () => {
    const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
      files: [{ id: "plan", path: "docs/Plan.md", title: "stale-name.md", text: "# Plan\n" }],
      snapshotKey,
    });
    const { payload } = await restoreJsonSnapshot(encrypted);
    expect(payload.files[0]?.title).toBe("Plan.md");
  });

  it.each([
    {
      name: "duplicate paths",
      files: [
        { id: "one", path: "dup.md", title: "dup.md", text: "one" },
        { id: "two", path: "dup.md", title: "dup.md", text: "two" },
      ],
    },
    {
      name: "case-folded path collisions",
      files: [
        { id: "upper", path: "A.md", title: "A.md", text: "upper" },
        { id: "lower", path: "a.md", title: "a.md", text: "lower" },
      ],
    },
    {
      name: "file and folder collisions",
      files: [
        { id: "blocking", path: "docs", title: "docs", text: "file" },
        { id: "nested", path: "docs/readme.md", title: "readme.md", text: "nested" },
      ],
    },
  ])("rejects $name before creating an encrypted copy", async ({ files }) => {
    await expect(createEncryptedJsonShareWorkspaceSnapshot({ files, snapshotKey }))
      .rejects.toThrow(/conflict/i);
  });

  it("rejects a copy that the MCP import surface cannot safely return", async () => {
    await expect(createEncryptedJsonShareWorkspaceSnapshot({
      files: [{
        id: "large",
        path: "large.md",
        title: "large.md",
        text: "x".repeat(200_001),
      }],
      snapshotKey,
    })).rejects.toThrow(/200000 Markdown characters/i);
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

  it("sends an opaque stable idempotency key for Export Copy tool retries", async () => {
    const ledger = new OperationLedger();
    const headers: Array<Record<string, string>> = [];
    let attempts = 0;
    const input = { files: [{ path: "private.md", content: "secret text" }] };
    const runExport = () => ledger.run("export_copy", input, () => shareMarkdownWorkspace({
      files: [{ id: "private", path: "private.md", title: "private.md", text: "secret text" }],
      snapshotKey,
      fetchImpl: async (_url, init) => {
        headers.push(init?.headers as Record<string, string>);
        attempts += 1;
        if (attempts === 1) throw new Error("upload response lost");
        return Response.json({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` });
      },
    }));

    await expect(runExport()).rejects.toThrow("upload response lost");
    await expect(runExport()).resolves.toMatchObject({ snapshotId });
    expect(headers).toHaveLength(2);
    expect(headers[0]?.["idempotency-key"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers[0]?.["idempotency-key"]).not.toContain("secret");
    expect(headers[1]?.["idempotency-key"]).toBe(headers[0]?.["idempotency-key"]);
  });

  it("round-trips every successfully exported workspace through the MCP importer", async () => {
    let encryptedCopy = new Uint8Array();
    const shared = await shareMarkdownWorkspace({
      title: "Round trip",
      files: [
        { id: "readme", path: "README.md", title: "README.md", text: "# Readme\n" },
        { id: "plan", path: "docs/Plan.md", title: "Plan.md", text: "# Plan\n" },
      ],
      activeFileId: "plan",
      appOrigin: "https://tabula.md",
      snapshotKey,
      fetchImpl: async (_url, init) => {
        encryptedCopy = new Uint8Array(init?.body as ArrayBuffer);
        return Response.json({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` });
      },
    });

    const imported = await importCopy({
      copyUrl: shared.shareUrl,
      fetchImpl: async () => new Response(encryptedCopy, {
        headers: { "content-length": String(encryptedCopy.byteLength) },
      }),
    });
    expect(imported).toMatchObject({
      title: "Round trip",
      activePath: "docs/Plan.md",
      files: expect.arrayContaining([
        { path: "README.md", content: "# Readme\n" },
        { path: "docs/Plan.md", content: "# Plan\n" },
      ]),
    });
  });

  it("round-trips varied generated workspace trees through the shared parser and MCP importer", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const files = Array.from({ length: (seed % 5) + 1 }, (_, index) => ({
        id: `s${seed}-f${index}`,
        path: index % 2 === 0 ? `topic-${seed}/note-${index}.md` : `note-${seed}-${index}.md`,
        title: `note-${index}.md`,
        text: `# Seed ${seed}\n\nGenerated file ${index}. ${"한글 ".repeat(index)}\n`,
      }));
      const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({ files, snapshotKey });
      const imported = await importCopy({
        copyUrl: `https://tabula.md/#json=${snapshotId},${snapshotKey}`,
        fetchImpl: async () => new Response(encrypted, {
          headers: { "content-length": String(encrypted.byteLength) },
        }),
      });
      expect(imported.files).toEqual(files
        .map((file) => ({ path: file.path, content: file.text }))
        .sort((left, right) => left.path.localeCompare(right.path)));
    }
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
