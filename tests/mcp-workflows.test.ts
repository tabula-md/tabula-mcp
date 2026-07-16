import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const roomMock = vi.hoisted(() => {
  const hash = (value: string) => `${value.length.toString(16).padStart(64, "0")}`;
  let sequence = 0;
  let stateReceived = true;
  class MockRoomClient {
    readonly sessionId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    readonly roomId: string;
    readonly shareUrl: string;
    readonly roomServerUrl: string;
    readonly writeAccess: boolean;
    readonly actor = { id: "agent", capabilities: ["presence", "read", "write"] };
    documents: Record<string, string> = {
      main: "# Shared\n\nhello\n",
      guide: "# Guide\n\nnested\n",
    };
    workspace = {
      roomId: "room",
      mode: "workspace" as const,
      version: 1,
      rootId: "root",
      activeDocumentId: "main",
      nodes: [
        { id: "root", type: "folder" as const, parentId: null, title: "Workspace", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z" },
        { id: "docs", type: "folder" as const, parentId: "root", title: "docs", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z" },
        { id: "main", type: "document" as const, parentId: "root", title: "shared.md", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", sha256: hash("# Shared\n\nhello\n"), textLength: 18 },
        { id: "guide", type: "document" as const, parentId: "docs", title: "guide.md", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", sha256: hash("# Guide\n\nnested\n"), textLength: 17 },
      ],
    };
    constructor({ parsedRoom, roomServerUrl, writeAccess }: {
      parsedRoom: { roomId: string; shareUrl: string };
      roomServerUrl: string;
      writeAccess: boolean;
    }) {
      this.roomId = parsedRoom.roomId;
      this.shareUrl = parsedRoom.shareUrl;
      this.roomServerUrl = roomServerUrl;
      this.writeAccess = writeAccess;
      this.workspace.roomId = parsedRoom.roomId;
    }
    async connect() { return "checkpoint-disabled"; }
    async getStatus() {
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        shareUrl: this.shareUrl,
        roomServerUrl: this.roomServerUrl,
        stateReceived,
        hydrationStatus: stateReceived ? "ready" : "waiting-for-peer-state",
        writeAccess: this.writeAccess,
        collaborators: [{ id: "human" }],
        recoveryMode: "temporary",
      };
    }
    async readWorkspace() {
      return { workspace: this.workspace, documents: this.workspace.nodes.filter((node) => node.type === "document") };
    }
    async readWorkspaceSnapshot() {
      return {
        sessionId: this.sessionId,
        workspace: this.workspace,
        documents: { ...this.documents },
        commentsByFileId: {},
        activeDocumentId: this.workspace.activeDocumentId,
      };
    }
    async publishWorkspaceSnapshot({ workspace, documents }: {
      workspace: typeof this.workspace;
      documents: Array<{ documentId: string; markdown: string }>;
    }) {
      this.workspace = workspace;
      this.documents = Object.fromEntries(documents.map((document) => [document.documentId, document.markdown]));
      return { emittedWorkspace: true, emittedDocumentCount: documents.length };
    }
    async applyWorkspaceChanges({ changes }: { changes: Array<any> }) {
      const changedDocumentIds: string[] = [];
      for (const change of changes) {
        if (change.type === "document.patch") {
          let content = this.documents[change.documentId] ?? "";
          for (const patch of [...change.patches].sort((a, b) => b.from - a.from)) {
            content = `${content.slice(0, patch.from)}${patch.insert}${content.slice(patch.to)}`;
          }
          this.documents[change.documentId] = content;
          this.workspace.nodes = this.workspace.nodes.map((node) => node.id === change.documentId
            ? { ...node, sha256: hash(content), textLength: content.length }
            : node);
          changedDocumentIds.push(change.documentId);
        } else if (change.type === "document.create") {
          const id = "created";
          this.documents[id] = change.markdown;
          this.workspace.nodes.push({
            id, type: "document", parentId: change.parentId ?? this.workspace.rootId, title: change.title,
            order: 1, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
            sha256: hash(change.markdown), textLength: change.markdown.length,
          });
          changedDocumentIds.push(id);
        }
      }
      return { changedDocumentIds };
    }
    disconnect() {}
  }
  return {
    MockRoomClient,
    setStateReceived(value: boolean) {
      stateReceived = value;
    },
  };
});

vi.mock("../src/room-client.js", () => ({ TabulaRoomClient: roomMock.MockRoomClient }));

import { MemoryDocumentStore } from "../src/documents/store.js";
import { createTabulaMcpServer } from "../src/index.js";

const originalFetch = globalThis.fetch;
const roomUrl = "https://tabula.md/#room=Vh93A9rDpVdhy-QpdN1i-w,giUChQup7ia5k7kk0D00jxU3tDivDALDpjgN2Xv0Sf0";

const withClient = async (callback: (client: Client) => Promise<void>) => {
  const instance = createTabulaMcpServer({ documentStore: new MemoryDocumentStore(), env: {}, writeEnabled: true });
  const client = new Client({ name: "workflow-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
    await callback(client);
  } finally {
    await Promise.allSettled([client.close(), instance.server.close()]);
    instance.registry.clear();
    await instance.documents.clear();
  }
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  roomMock.setStateReceived(true);
  vi.restoreAllMocks();
});

describe("core MCP workflows", () => {
  it("joins, lists, reads, writes, and reads a live session without low-level patches", async () => {
    await withClient(async (client) => {
      const joined = await client.callTool({ name: "tabula_join_room", arguments: { roomUrl } });
      const session = joined.structuredContent as {
        sessionId: string;
        ready: boolean;
        canWrite: boolean;
        fileCount: number;
        otherCollaboratorCount: number;
      };
      expect(session).toMatchObject({ ready: true, canWrite: true, fileCount: 2, otherCollaboratorCount: 1 });
      expect(JSON.stringify(joined.structuredContent)).not.toContain(roomUrl);

      const resources = await client.listResources();
      const manifestUri = `tabula://session/${session.sessionId}`;
      const fileUri = `tabula://session/${session.sessionId}/file/shared.md`;
      const nestedFileUri = `tabula://session/${session.sessionId}/file/docs%2Fguide.md`;
      expect(resources.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: manifestUri, mimeType: "application/json" }),
        expect.objectContaining({ uri: fileUri, mimeType: "text/markdown" }),
        expect.objectContaining({ uri: nestedFileUri, mimeType: "text/markdown" }),
      ]));
      expect(JSON.stringify(resources)).not.toContain("documentId");
      const manifest = await client.readResource({ uri: manifestUri });
      const manifestValue = JSON.parse(manifest.contents[0]?.text ?? "{}");
      expect(manifestValue.sessionId).toBe(session.sessionId);
      expect(manifestValue.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "shared.md" }),
        expect.objectContaining({ path: "docs/guide.md" }),
      ]));
      const fileResource = await client.readResource({ uri: fileUri });
      expect(fileResource.contents[0]).toMatchObject({ text: "# Shared\n\nhello\n" });
      const nestedFileResource = await client.readResource({ uri: nestedFileUri });
      expect(nestedFileResource.contents[0]).toMatchObject({
        text: "# Guide\n\nnested\n",
        _meta: expect.objectContaining({ path: "docs/guide.md" }),
      });

      const listed = await client.callTool({ name: "tabula_list_files", arguments: { sessionId: session.sessionId } });
      expect((listed.structuredContent as { files: unknown[] }).files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "shared.md" }),
      ]));

      const read = await client.callTool({ name: "tabula_read_file", arguments: { sessionId: session.sessionId, path: "shared.md" } });
      const file = read.structuredContent as { content: string; revision: string };
      expect(file.content).toBe("# Shared\n\nhello\n");

      const content = `${file.content}\nhi! 👋\n`;
      const written = await client.callTool({
        name: "tabula_write_file",
        arguments: { sessionId: session.sessionId, path: "shared.md", content, expectedRevision: file.revision },
      });
      expect(written.isError).not.toBe(true);
      expect(written.structuredContent).toMatchObject({ changed: true, created: false, textLength: content.length });

      const reread = await client.callTool({ name: "tabula_read_file", arguments: { sessionId: session.sessionId, path: "shared.md" } });
      expect(reread.structuredContent).toMatchObject({ content });
    });
  });

  it("creates a draft and starts a writable live session", async () => {
    await withClient(async (client) => {
      const created = await client.callTool({
        name: "tabula_create_draft",
        arguments: { title: "Research", content: "# Research\n" },
      });
      const draftId = (created.structuredContent as { draftId: string }).draftId;
      const started = await client.callTool({ name: "tabula_start_session", arguments: { draftId } });
      expect(started.structuredContent).toMatchObject({
        ready: true,
        canWrite: true,
        fileCount: 1,
        sessionUrl: expect.stringMatching(/^https:\/\/tabula\.md\/#room=/),
      });
    });
  });

  it("returns session_not_ready without discarding the connected session", async () => {
    roomMock.setStateReceived(false);
    await withClient(async (client) => {
      const joined = await client.callTool({ name: "tabula_join_room", arguments: { roomUrl } });
      expect(joined.isError).toBe(true);
      expect(joined.structuredContent).toBeUndefined();
      const error = JSON.parse(joined.content?.find((item) => item.type === "text")?.text ?? "{}");
      expect(error).toMatchObject({
        code: "session_not_ready",
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        retry: expect.stringContaining("List Files"),
      });

      roomMock.setStateReceived(true);
      const listed = await client.callTool({
        name: "tabula_list_files",
        arguments: { sessionId: error.sessionId },
      });
      expect(listed.isError).not.toBe(true);
      expect((listed.structuredContent as { files: unknown[] }).files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "shared.md" }),
      ]));
    });
  });
});
