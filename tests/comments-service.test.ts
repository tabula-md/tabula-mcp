import type { WorkspaceRoomComment } from "@tabula-md/tabula/collaboration";
import { describe, expect, it } from "vitest";
import {
  addSessionComment,
  deleteSessionComment,
  listSessionComments,
  replyToSessionComment,
  setSessionCommentResolved,
} from "../src/comments-service.js";
import type { SessionRegistry } from "../src/registry.js";

const createHarness = ({ writeAccess = true }: { writeAccess?: boolean } = {}) => {
  const content = "# Shared\n\nhello\nworld\n";
  const commentsByFileId: Record<string, WorkspaceRoomComment[]> = { doc: [] };
  let version = 1;
  const session = {
    writeAccess,
    actor: { id: "agent-1", name: "Claude", color: "#123456" },
    recoveryMode: "temporary" as const,
    async getStatus() { return { stateReceived: true }; },
    async readWorkspaceSnapshot() {
      return {
        sessionId: "session-1",
        workspace: {
          roomId: "room-1",
          mode: "workspace" as const,
          version,
          rootId: "root",
          activeDocumentId: "doc",
          nodes: [
            { id: "root", type: "folder" as const, parentId: null, title: "Workspace", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z" },
            { id: "doc", type: "document" as const, parentId: "root", title: "shared.md", order: 0, createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", sha256: "0".repeat(64), textLength: content.length },
          ],
        },
        documents: { doc: content },
        commentsByFileId,
        activeDocumentId: "doc",
      };
    },
    async upsertComment(comment: WorkspaceRoomComment) {
      commentsByFileId.doc!.push(comment);
      version += 1;
    },
    async addCommentReply(commentId: string, reply: WorkspaceRoomComment["replies"][number]) {
      const comment = commentsByFileId.doc!.find((candidate) => candidate.id === commentId)!;
      comment.replies.push(reply);
      version += 1;
    },
    async setCommentResolved(commentId: string, resolved: boolean) {
      const comment = commentsByFileId.doc!.find((candidate) => candidate.id === commentId)!;
      comment.resolved = resolved;
      version += 1;
    },
    async deleteComment(commentId: string) {
      commentsByFileId.doc = commentsByFileId.doc!.filter((candidate) => candidate.id !== commentId);
      version += 1;
    },
    async flushCheckpoint() {},
    async persistCheckpointAfterMutation() { return "disabled" as const; },
    checkpointPersistenceStatus() { return "disabled" as const; },
  };
  const registry = { get: () => session } as unknown as SessionRegistry;
  return { registry, session };
};

describe("comments service", () => {
  it("adds, lists, replies to, resolves, reopens, and deletes anchored comments", async () => {
    const { registry } = createHarness();
    const added = await addSessionComment({
      registry,
      sessionId: "session-1",
      path: "shared.md",
      body: "Check this line.",
      startLine: 3,
      endLine: 3,
      now: () => "2026-07-17T01:00:00.000Z",
      id: () => "00000000-0000-4000-8000-000000000001",
    });
    expect(added).toMatchObject({
      applied: true,
      persisted: false,
      checkpointPending: false,
      commentId: "00000000-0000-4000-8000-000000000001",
      path: "shared.md",
      startLine: 3,
      endLine: 3,
    });

    const open = await listSessionComments({ registry, sessionId: "session-1" });
    expect(open.comments).toHaveLength(1);

    const replied = await replyToSessionComment({
      registry,
      sessionId: "session-1",
      commentId: added.commentId,
      body: "I will revise it.",
      now: () => "2026-07-17T01:01:00.000Z",
      id: () => "00000000-0000-4000-8000-000000000002",
    });
    expect(replied).toMatchObject({
      commentId: added.commentId,
      path: "shared.md",
      replyId: "00000000-0000-4000-8000-000000000002",
    });

    const resolved = await setSessionCommentResolved({
      registry,
      sessionId: "session-1",
      commentId: added.commentId,
      resolved: true,
    });
    expect(resolved).toMatchObject({ resolved: true, changed: true });
    await expect(listSessionComments({ registry, sessionId: "session-1" })).resolves.toMatchObject({ comments: [] });
    await expect(listSessionComments({ registry, sessionId: "session-1", status: "resolved" })).resolves.toMatchObject({
      comments: [expect.objectContaining({ id: added.commentId, resolved: true, replies: [expect.any(Object)] })],
    });

    const reopened = await setSessionCommentResolved({
      registry,
      sessionId: "session-1",
      commentId: added.commentId,
      resolved: false,
    });
    expect(reopened).toMatchObject({ resolved: false, changed: true });

    const deleted = await deleteSessionComment({ registry, sessionId: "session-1", commentId: added.commentId });
    expect(deleted).toMatchObject({ deleted: true, path: "shared.md" });
    await expect(listSessionComments({ registry, sessionId: "session-1", status: "all" })).resolves.toMatchObject({
      comments: [],
    });
  });

  it("requires complete, in-file line ranges", async () => {
    const { registry } = createHarness();
    await expect(addSessionComment({
      registry,
      sessionId: "session-1",
      path: "shared.md",
      body: "Check this.",
      startLine: 3,
    })).rejects.toMatchObject({ code: "invalid_range" });
    await expect(addSessionComment({
      registry,
      sessionId: "session-1",
      path: "shared.md",
      body: "Check this.",
      startLine: 9,
      endLine: 9,
    })).rejects.toMatchObject({ code: "invalid_range" });
  });

  it("rejects comment mutations for a read-only connection", async () => {
    const { registry } = createHarness({ writeAccess: false });
    await expect(addSessionComment({
      registry,
      sessionId: "session-1",
      path: "shared.md",
      body: "Check this.",
    })).rejects.toMatchObject({ code: "write_disabled" });
  });
});
