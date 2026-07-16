import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const roomMock = vi.hoisted(() => {
  const hash = (value: string) => `${value.length.toString(16).padStart(64, "0")}`;
  let sequence = 0;
  class MockRoomClient {
    readonly sessionId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    readonly roomId: string;
    readonly shareUrl: string;
    readonly roomServerUrl: string;
    readonly writeAccess: boolean;
    readonly actor = { id: "agent", capabilities: ["presence", "read", "write"] };
    documents: Record<string, string> = { main: "# Shared\n\nhello\n" };
    workspace = {
      roomId: "room",
      mode: "workspace" as const,
      version: 1,
      rootId: "root",
      activeDocumentId: "main",
      nodes: [
        { id: "root", type: "folder" as const, parentId: null, title: "Workspace", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z" },
        { id: "main", type: "document" as const, parentId: "root", title: "shared.md", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", sha256: hash("# Shared\n\nhello\n"), textLength: 18 },
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
        stateReceived: true,
        hydrationStatus: "ready",
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
  return { MockRoomClient };
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
      expect(session).toMatchObject({ ready: true, canWrite: true, fileCount: 1, otherCollaboratorCount: 1 });
      expect(JSON.stringify(joined.structuredContent)).not.toContain(roomUrl);

      const listed = await client.callTool({ name: "tabula_list_files", arguments: { sessionId: session.sessionId } });
      expect(listed.structuredContent).toMatchObject({ files: [expect.objectContaining({ path: "shared.md" })] });

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
});
