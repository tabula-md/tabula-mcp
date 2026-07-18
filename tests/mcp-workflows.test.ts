import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const roomMock = vi.hoisted(() => {
  const hash = (value: string) => `${value.length.toString(16).padStart(64, "0")}`;
  let sequence = 0;
  let stateReceived = true;
  const actorIds: string[] = [];
  class MockRoomClient {
    readonly sessionId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    readonly roomId: string;
    readonly shareUrl: string;
    readonly roomServerUrl: string;
    readonly writeAccess: boolean;
    readonly actor: { id: string; name: string; color?: string; capabilities: string[] };
    commentsByFileId: Record<string, Array<any>> = { main: [], guide: [] };
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
    constructor({ parsedRoom, roomServerUrl, writeAccess, identityId, identityName, identityColor }: {
      parsedRoom: { roomId: string; shareUrl: string };
      roomServerUrl: string;
      writeAccess: boolean;
      identityId?: string;
      identityName?: string;
      identityColor?: string;
    }) {
      this.roomId = parsedRoom.roomId;
      this.shareUrl = parsedRoom.shareUrl;
      this.roomServerUrl = roomServerUrl;
      this.writeAccess = writeAccess;
      this.actor = {
        id: identityId ?? "agent",
        name: identityName ?? "Agent",
        color: identityColor,
        capabilities: writeAccess ? ["presence", "read", "write"] : ["presence", "read"],
      };
      actorIds.push(this.actor.id);
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
        commentsByFileId: this.commentsByFileId,
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
        if (change.type === "folder.create") {
          this.workspace.nodes.push({
            id: change.folderId, type: "folder", parentId: change.parentId ?? this.workspace.rootId, title: change.title,
            order: this.workspace.nodes.length, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
          });
        } else if (change.type === "document.patch") {
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
          const id = `created-${this.workspace.nodes.length}`;
          this.documents[id] = change.markdown;
          this.workspace.nodes.push({
            id, type: "document", parentId: change.parentId ?? this.workspace.rootId, title: change.title,
            order: 1, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
            sha256: hash(change.markdown), textLength: change.markdown.length,
          });
          changedDocumentIds.push(id);
        } else if (change.type === "node.move") {
          this.workspace.nodes = this.workspace.nodes.map((node) => node.id === change.nodeId
            ? { ...node, parentId: change.parentId ?? this.workspace.rootId, title: change.title }
            : node);
        } else if (change.type === "node.delete") {
          const deletedIds = new Set([change.nodeId]);
          let added = true;
          while (added) {
            added = false;
            for (const node of this.workspace.nodes) {
              if (node.parentId && deletedIds.has(node.parentId) && !deletedIds.has(node.id)) {
                deletedIds.add(node.id);
                added = true;
              }
            }
          }
          this.workspace.nodes = this.workspace.nodes.filter((node) => !deletedIds.has(node.id));
          for (const id of deletedIds) delete this.documents[id];
        }
      }
      return { changedDocumentIds };
    }
    async upsertComment(comment: any) {
      (this.commentsByFileId[comment.fileId] ??= []).push(comment);
      this.workspace.version += 1;
    }
    async addCommentReply(commentId: string, reply: any) {
      const comment = Object.values(this.commentsByFileId).flat().find((candidate) => candidate.id === commentId);
      comment.replies.push(reply);
      this.workspace.version += 1;
    }
    async setCommentResolved(commentId: string, resolved: boolean) {
      const comment = Object.values(this.commentsByFileId).flat().find((candidate) => candidate.id === commentId);
      comment.resolved = resolved;
      this.workspace.version += 1;
    }
    async deleteComment(commentId: string) {
      for (const [fileId, comments] of Object.entries(this.commentsByFileId)) {
        this.commentsByFileId[fileId] = comments.filter((candidate) => candidate.id !== commentId);
      }
      this.workspace.version += 1;
    }
    checkpointPersistenceStatus() { return "disabled" as const; }
    async flushCheckpoint() {}
    async persistCheckpointAfterMutation() { return "disabled" as const; }
    disconnect() {}
  }
  return {
    MockRoomClient,
    setStateReceived(value: boolean) {
      stateReceived = value;
    },
    actorIds,
  };
});

vi.mock("../src/room-client.js", () => ({ TabulaRoomClient: roomMock.MockRoomClient }));

import type { RuntimeEnvironment } from "../src/env.js";
import { createTabulaMcpServer } from "../src/index.js";

const originalFetch = globalThis.fetch;
const roomUrl = "https://tabula.md/#room=Vh93A9rDpVdhy-QpdN1i-w,giUChQup7ia5k7kk0D00jxU3tDivDALDpjgN2Xv0Sf0";
const secondRoomUrl = "https://tabula.md/#room=2w_Sx-x0GrAOawFgHqvgMA,YMZdnTRmorvDRDW-TYJG362ehdoN4Hqhi4zidGr2uVE";

const withClient = async (
  callback: (client: Client) => Promise<void>,
  env: RuntimeEnvironment = {},
) => {
  const instance = createTabulaMcpServer({ env, writeEnabled: true });
  const client = new Client({ name: "workflow-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
    await callback(client);
  } finally {
    await Promise.allSettled([client.close(), instance.server.close()]);
    await instance.registry.clear();
  }
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  roomMock.setStateReceived(true);
  roomMock.actorIds.splice(0);
  vi.restoreAllMocks();
});

describe("core MCP workflows", () => {
  it("joins, lists, reads, writes, and reads a live session without low-level patches", async () => {
    await withClient(async (client) => {
      const joined = await client.callTool({ name: "join_room", arguments: { roomUrl } });
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
      expect(resources.resources).toEqual([
        expect.objectContaining({ uri: expect.stringMatching(/^ui:\/\/tabula\/document-/) }),
      ]);
      expect(JSON.stringify(resources)).not.toContain(session.sessionId);
      expect(JSON.stringify(resources)).not.toContain("shared.md");
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates).toEqual(expect.arrayContaining([
        expect.objectContaining({ uriTemplate: "tabula://session/{sessionId}" }),
        expect.objectContaining({ uriTemplate: "tabula://session/{sessionId}/file/{path}" }),
      ]));
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

      const listed = await client.callTool({ name: "list_files", arguments: { sessionId: session.sessionId } });
      expect(listed.structuredContent).not.toHaveProperty("sessionId");
      expect((listed.structuredContent as { files: unknown[] }).files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "shared.md" }),
      ]));

      const read = await client.callTool({
        name: "read_file",
        arguments: { sessionId: session.sessionId, path: "shared.md", startLine: 1, lineCount: 3 },
      });
      const file = read.structuredContent as { path: string; content: string; revision: string; startLine: number };
      expect(read.structuredContent).not.toHaveProperty("sessionId");
      expect(file).toMatchObject({ path: "shared.md", startLine: 1 });
      expect(file.content).toBe("# Shared\n\nhello\n");

      const readMany = await client.callTool({
        name: "read_multiple_files",
        arguments: { sessionId: session.sessionId, paths: ["shared.md", "docs/guide.md"] },
      });
      expect((readMany.structuredContent as { files: Array<{ path: string }> }).files.map((item) => item.path))
        .toEqual(["shared.md", "docs/guide.md"]);

      const searched = await client.callTool({
        name: "search_files",
        arguments: { sessionId: session.sessionId, query: "nested" },
      });
      expect(searched.isError).not.toBe(true);
      expect(searched.structuredContent).not.toHaveProperty("sessionId");
      expect(searched.structuredContent).toMatchObject({
        matches: [expect.objectContaining({ path: "docs/guide.md", kind: "content", line: 3, match: "nested" })],
        truncated: false,
      });

      const content = `${file.content}\nhi! 👋\n`;
      const written = await client.callTool({
        name: "write_file",
        arguments: {
          sessionId: session.sessionId,
          path: "shared.md",
          content,
          expectedRevision: file.revision,
        },
      });
      expect(written.isError).not.toBe(true);
      expect(written.structuredContent).not.toHaveProperty("sessionId");
      expect(written.structuredContent).toMatchObject({ changed: true, created: false, textLength: content.length });

      const reread = await client.callTool({
        name: "read_multiple_files",
        arguments: { sessionId: session.sessionId, paths: ["shared.md"] },
      });
      expect(reread.structuredContent).toMatchObject({ files: [expect.objectContaining({ content })] });

      const writtenFiles = await client.callTool({
        name: "write_files",
        arguments: {
          sessionId: session.sessionId,
          files: [
            { path: "research/notes.md", content: "# Notes\n" },
            { path: "decision.md", content: "# Decision\n" },
          ],
        },
      });
      expect(writtenFiles.isError).not.toBe(true);
      expect(writtenFiles.structuredContent).not.toHaveProperty("sessionId");
      expect(writtenFiles.structuredContent).toMatchObject({ createdCount: 2, changedCount: 2 });

      const latestShared = ((await client.callTool({
        name: "read_multiple_files",
        arguments: { sessionId: session.sessionId, paths: ["shared.md"] },
      })).structuredContent as { files: Array<{ revision: string }> }).files[0]!;
      const edited = await client.callTool({
        name: "edit_file",
        arguments: {
          sessionId: session.sessionId,
          path: "shared.md",
          expectedRevision: latestShared.revision,
          edits: [{ oldText: "hi! 👋", newText: "hello from Tabula" }],
        },
      });
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({
        path: "shared.md",
        changed: true,
        editsApplied: 1,
        rebased: false,
        diff: expect.stringContaining("-hi! 👋"),
      });

      const createdDirectory = await client.callTool({
        name: "create_directory",
        arguments: { sessionId: session.sessionId, path: "archive/2026" },
      });
      expect(createdDirectory.isError).not.toBe(true);
      expect(createdDirectory.structuredContent).toMatchObject({ path: "archive/2026", created: true });
      const decision = ((writtenFiles.structuredContent as {
        files: Array<{ path: string; revision: string }>;
      }).files).find((candidate) => candidate.path === "decision.md")!;
      const moved = await client.callTool({
        name: "move_file",
        arguments: {
          sessionId: session.sessionId,
          source: "decision.md",
          destination: "archive/2026/final.md",
          expectedRevision: decision.revision,
        },
      });
      expect(moved.isError).not.toBe(true);
      expect(moved.structuredContent).toMatchObject({ destination: "archive/2026/final.md", type: "file", changed: true });
      const deleted = await client.callTool({
        name: "delete_path",
        arguments: { sessionId: session.sessionId, path: "research", recursive: true },
      });
      expect(deleted.isError).not.toBe(true);
      expect(deleted.structuredContent).toMatchObject({ path: "research", type: "folder", deleted: true });

      const addedComment = await client.callTool({
        name: "add_comment",
        arguments: {
          sessionId: session.sessionId,
          path: "shared.md",
          body: "Please verify this greeting.",
          startLine: 3,
          endLine: 3,
        },
      });
      expect(addedComment.isError).not.toBe(true);
      const commentId = (addedComment.structuredContent as { commentId: string }).commentId;
      expect(addedComment.structuredContent).toMatchObject({
        path: "shared.md",
        startLine: 3,
        endLine: 3,
      });
      const replied = await client.callTool({
        name: "reply_to_comment",
        arguments: { sessionId: session.sessionId, commentId, body: "Verified." },
      });
      expect(replied.isError).not.toBe(true);
      const resolved = await client.callTool({
        name: "resolve_comment",
        arguments: { sessionId: session.sessionId, commentId, resolved: true },
      });
      expect(resolved.structuredContent).toMatchObject({ resolved: true, changed: true });
      const listedComments = await client.callTool({
        name: "list_comments",
        arguments: { sessionId: session.sessionId, status: "resolved" },
      });
      expect(listedComments.structuredContent).toMatchObject({
        comments: [expect.objectContaining({ id: commentId, replies: [expect.objectContaining({ body: "Verified." })] })],
      });
      const deletedComment = await client.callTool({
        name: "delete_comment",
        arguments: { sessionId: session.sessionId, commentId },
      });
      expect(deletedComment.structuredContent).toMatchObject({ deleted: true, commentId });
    });
  });

  it("keeps multiple live sessions isolated by explicit sessionId and leaves only the requested one", async () => {
    await withClient(async (client) => {
      const first = (await client.callTool({ name: "join_room", arguments: { roomUrl } })).structuredContent as {
        sessionId: string;
      };
      const second = (await client.callTool({ name: "join_room", arguments: { roomUrl: secondRoomUrl } })).structuredContent as {
        sessionId: string;
      };
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(roomMock.actorIds.at(-2)).toBe(roomMock.actorIds.at(-1));

      const firstRead = (await client.callTool({
        name: "read_file",
        arguments: { sessionId: first.sessionId, path: "shared.md" },
      })).structuredContent as { content: string; revision: string };
      const secondRead = (await client.callTool({
        name: "read_file",
        arguments: { sessionId: second.sessionId, path: "shared.md" },
      })).structuredContent as { content: string; revision: string };

      await client.callTool({
        name: "write_file",
        arguments: {
          sessionId: first.sessionId,
          path: "shared.md",
          content: `${firstRead.content}\nfirst room only\n`,
          expectedRevision: firstRead.revision,
        },
      });
      const unchangedSecond = await client.callTool({
        name: "read_file",
        arguments: { sessionId: second.sessionId, path: "shared.md" },
      });
      expect(unchangedSecond.structuredContent).toMatchObject({ content: secondRead.content });

      const left = await client.callTool({ name: "leave_session", arguments: { sessionId: first.sessionId } });
      expect(left.structuredContent).toEqual({ sessionId: first.sessionId, left: true });
      const leftAgain = await client.callTool({ name: "leave_session", arguments: { sessionId: first.sessionId } });
      expect(leftAgain.structuredContent).toEqual({ sessionId: first.sessionId, left: false, reason: "already_left" });

      const missing = await client.callTool({
        name: "read_file",
        arguments: { sessionId: first.sessionId, path: "shared.md" },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content?.find((item) => item.type === "text")?.text ?? "{}")).toMatchObject({
        code: "session_not_found",
        details: { sessionId: first.sessionId },
      });
      const remaining = await client.callTool({
        name: "read_file",
        arguments: { sessionId: second.sessionId, path: "shared.md" },
      });
      expect(remaining.isError).not.toBe(true);
    });
  });

  it("rejects another Room before connecting when the per-MCP-session limit is reached", async () => {
    await withClient(async (client) => {
      const first = await client.callTool({ name: "join_room", arguments: { roomUrl } });
      expect(first.isError).not.toBe(true);
      const limited = await client.callTool({ name: "join_room", arguments: { roomUrl: secondRoomUrl } });
      expect(limited.isError).toBe(true);
      expect(JSON.parse(limited.content?.find((item) => item.type === "text")?.text ?? "{}")).toMatchObject({
        code: "session_limit",
        details: { limit: 1 },
        retry: expect.stringContaining("Leave an inactive"),
      });
    }, { TABULA_MCP_MAX_ROOMS_PER_SESSION: "1" });
  });

  it("does not expose or accept a Room handle from another MCP connection", async () => {
    await withClient(async (firstClient) => {
      const first = (await firstClient.callTool({ name: "join_room", arguments: { roomUrl } })).structuredContent as {
        sessionId: string;
      };
      await withClient(async (secondClient) => {
        const second = (await secondClient.callTool({
          name: "join_room",
          arguments: { roomUrl: secondRoomUrl },
        })).structuredContent as { sessionId: string };
        expect(second.sessionId).not.toBe(first.sessionId);

        const resources = await secondClient.listResources();
        expect(JSON.stringify(resources)).not.toContain(first.sessionId);
        const foreignRead = await secondClient.callTool({
          name: "read_file",
          arguments: { sessionId: first.sessionId, path: "shared.md" },
        });
        expect(foreignRead.isError).toBe(true);
        expect(JSON.parse(foreignRead.content?.find((item) => item.type === "text")?.text ?? "{}")).toMatchObject({
          code: "session_not_found",
          details: { sessionId: first.sessionId },
        });
      });
    });
  });

  it("starts a writable live session directly from host-native files", async () => {
    await withClient(async (client) => {
      const started = await client.callTool({
        name: "start_session",
        arguments: {
          title: "Research",
          files: [
            { path: "research.md", content: "# Research\n" },
            { path: "sources/notes.md", content: "# Notes\n" },
          ],
        },
      });
      expect(started.structuredContent).toMatchObject({
        ready: true,
        canWrite: true,
        fileCount: 2,
        sessionUrl: expect.stringMatching(/^https:\/\/tabula\.md\/#room=/),
      });
    });
  });

  it("exports a connected session through the same flat first-call contract", async () => {
    const snapshotId = "session_copy_123";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await withClient(async (client) => {
      const joined = await client.callTool({ name: "join_room", arguments: { roomUrl } });
      const { sessionId } = joined.structuredContent as { sessionId: string };
      const exported = await client.callTool({
        name: "export_copy",
        arguments: { sessionId, paths: ["shared.md"] },
      });

      expect(exported.isError).not.toBe(true);
      expect(exported.structuredContent).toMatchObject({
        copyUrl: expect.stringMatching(new RegExp(`^https://tabula\\.md/#json=${snapshotId},`)),
        fileCount: 1,
        encrypted: true,
      });
    });
  });

  it("returns a recoverable error for a URL that is not a private room link", async () => {
    await withClient(async (client) => {
      const joined = await client.callTool({
        name: "join_room",
        arguments: { roomUrl: "https://tabula.md/" },
      });
      expect(joined.isError).toBe(true);
      const error = JSON.parse(joined.content?.find((item) => item.type === "text")?.text ?? "{}");
      expect(error).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("valid private Tabula room URL"),
        details: { expected: "https://tabula.md/#room=<room-id>,<room-key>" },
        retry: expect.stringContaining("complete #room URL"),
      });
      expect(joined.structuredContent).toEqual(error);
    });
  });

  it("rolls back a connection whose workspace state never became ready", async () => {
    roomMock.setStateReceived(false);
    await withClient(async (client) => {
      const joined = await client.callTool({ name: "join_room", arguments: { roomUrl } });
      expect(joined.isError).toBe(true);
      const error = JSON.parse(joined.content?.find((item) => item.type === "text")?.text ?? "{}");
      expect(error).toMatchObject({
        code: "session_not_ready",
        details: expect.any(Object),
        retry: expect.stringContaining("join it again"),
      });
      expect(joined.structuredContent).toEqual(error);

      roomMock.setStateReceived(true);
      const retried = await client.callTool({ name: "join_room", arguments: { roomUrl } });
      expect(retried.isError).not.toBe(true);
      expect(retried.structuredContent).toMatchObject({ ready: true, canWrite: true });
    }, { TABULA_MCP_MAX_ROOMS_PER_SESSION: "1" });
  });
});
