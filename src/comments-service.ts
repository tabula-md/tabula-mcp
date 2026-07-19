import { randomUUID } from "node:crypto";
import {
  WORKSPACE_ROOM_MAX_COMMENT_LENGTH,
  type WorkspaceRoomComment,
  type WorkspaceRoomCommentReply,
} from "@tabula-md/tabula/collaboration";
import { TabulaCoreError } from "./core-errors.js";
import { mutationReceipt, persistAppliedMutation } from "./mutation-receipt.js";
import type { SessionRegistry } from "./registry.js";
import { throwIfOperationAborted } from "./server/operation-context.js";
import { buildWorkspacePathIndex, normalizeWorkspaceFilePath } from "./workspace-paths.js";

export const defaultCommentPageSize = 50;
export const maxCommentPageSize = 100;

type CommentStatus = "open" | "resolved" | "all";

type CommentCursor = {
  v: 1;
  workspaceVersion: number;
  path: string;
  status: CommentStatus;
  afterCreatedAt: string;
  afterId: string;
};

const encodeCursor = (value: CommentCursor) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeCursor = (cursor: string): CommentCursor => {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const parsed = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )) as Partial<CommentCursor>;
    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.workspaceVersion) ||
      typeof parsed.path !== "string" ||
      !["open", "resolved", "all"].includes(parsed.status ?? "") ||
      typeof parsed.afterCreatedAt !== "string" ||
      typeof parsed.afterId !== "string" ||
      !parsed.afterId
    ) throw new Error("Invalid cursor.");
    return parsed as CommentCursor;
  } catch {
    throw new TabulaCoreError("stale_cursor", "The comment-list cursor is invalid or no longer usable.", {
      retry: "List comments again without a cursor.",
    });
  }
};

const requireSession = (registry: SessionRegistry, sessionId: string) => registry.get(sessionId);

const readReadySnapshot = async (registry: SessionRegistry, sessionId: string) => {
  const session = requireSession(registry, sessionId);
  const status = await session.getStatus();
  if (!status.stateReceived) {
    throw new TabulaCoreError("session_not_ready", "The Tabula session is still waiting for workspace state.", {
      details: { sessionId },
      retry: "Keep Tabula open, wait for session state, and retry.",
    });
  }
  return { session, snapshot: await session.readWorkspaceSnapshot() };
};

const requireWriteAccess = (session: { writeAccess: boolean }) => {
  if (!session.writeAccess) {
    throw new TabulaCoreError("write_disabled", "This Tabula MCP connection is read-only.", {
      retry: "Reconnect using a writable Tabula MCP configuration.",
    });
  }
};

const requireBody = (body: string) => {
  const normalized = body.trim();
  if (!normalized) {
    throw new TabulaCoreError("invalid_input", "Comment text must not be empty.", {
      retry: "Provide the comment text and retry.",
    });
  }
  if (normalized.length > WORKSPACE_ROOM_MAX_COMMENT_LENGTH) {
    throw new TabulaCoreError("invalid_input", "Comment text is too long.", {
      details: { length: normalized.length, maximum: WORKSPACE_ROOM_MAX_COMMENT_LENGTH },
      retry: "Shorten the comment and retry.",
    });
  }
  return normalized;
};

const lineStartsOf = (content: string) => {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
};

const lineRangeToOffsets = (content: string, startLine?: number, endLine?: number) => {
  if (startLine === undefined && endLine === undefined) return undefined;
  if (startLine === undefined || endLine === undefined) {
    throw new TabulaCoreError("invalid_range", "Both startLine and endLine are required for a line comment.", {
      retry: "Provide both line numbers, or omit both for a file-level comment.",
    });
  }
  const starts = lineStartsOf(content);
  if (startLine < 1 || endLine < startLine || endLine > starts.length) {
    throw new TabulaCoreError("invalid_range", "The comment line range is outside the file.", {
      details: { startLine, endLine, totalLines: starts.length },
      retry: "Read the file and retry with a valid inclusive line range.",
    });
  }
  const selectionStart = starts[startLine - 1]!;
  let selectionEnd = endLine < starts.length ? starts[endLine]! : content.length;
  if (selectionEnd > selectionStart && content[selectionEnd - 1] === "\n") selectionEnd -= 1;
  return {
    startLine,
    endLine,
    selectionStart,
    selectionEnd,
    quote: content.slice(selectionStart, selectionEnd),
  };
};

const offsetsToLineRange = (content: string, comment: WorkspaceRoomComment) => {
  if (comment.selectionStart === undefined || comment.selectionEnd === undefined) return {};
  const clampedStart = Math.min(Math.max(comment.selectionStart, 0), content.length);
  const clampedEnd = Math.min(Math.max(comment.selectionEnd, clampedStart), content.length);
  const startLine = content.slice(0, clampedStart).split("\n").length;
  const endLine = content.slice(0, Math.max(clampedStart, clampedEnd - 1)).split("\n").length;
  return { startLine, endLine };
};

const replyOutput = (reply: WorkspaceRoomCommentReply) => ({
  id: reply.id,
  body: reply.body,
  author: reply.authorName ?? "Unknown",
  createdAt: reply.createdAt,
});

const commentOutput = ({
  comment,
  path,
  content,
}: {
  comment: WorkspaceRoomComment;
  path: string;
  content: string;
}) => ({
  id: comment.id,
  path,
  body: comment.body,
  author: comment.authorName ?? "Unknown",
  createdAt: comment.createdAt,
  resolved: comment.resolved,
  ...offsetsToLineRange(content, comment),
  ...(comment.quote ? { quote: comment.quote } : {}),
  replies: comment.replies.map(replyOutput),
});

const indexedComments = (snapshot: Awaited<ReturnType<typeof readReadySnapshot>>["snapshot"]) => {
  const index = buildWorkspacePathIndex(snapshot.workspace);
  return Object.entries(snapshot.commentsByFileId).flatMap(([fileId, comments]) => {
    const path = index.pathsById.get(fileId);
    const content = snapshot.documents[fileId];
    if (!path || content === undefined) return [];
    return comments.map((comment) => ({ comment, path, content }));
  }).sort((left, right) => left.comment.createdAt.localeCompare(right.comment.createdAt) ||
    left.comment.id.localeCompare(right.comment.id));
};

const findComment = (
  snapshot: Awaited<ReturnType<typeof readReadySnapshot>>["snapshot"],
  commentId: string,
) => {
  const found = indexedComments(snapshot).find((entry) => entry.comment.id === commentId);
  if (!found) {
    throw new TabulaCoreError("comment_not_found", "The requested comment was not found in this session.", {
      details: { commentId },
      retry: "List comments and retry with a current comment ID.",
    });
  }
  return found;
};

export const listSessionComments = async ({
  registry,
  sessionId,
  path,
  status = "open",
  limit = defaultCommentPageSize,
  cursor,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path?: string;
  status?: CommentStatus;
  limit?: number;
  cursor?: string;
}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxCommentPageSize) {
    throw new TabulaCoreError("invalid_range", "Comment-list limit is outside the supported range.", {
      details: { limit, maximum: maxCommentPageSize },
      retry: `Use a limit between 1 and ${maxCommentPageSize}.`,
    });
  }
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const requestedPath = path ? normalizeWorkspaceFilePath(path) : "";
  if (requestedPath) {
    const entry = buildWorkspacePathIndex(snapshot.workspace).byPath.get(requestedPath);
    if (!entry || entry.node.type !== "document") {
      throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
        details: { path: requestedPath },
        retry: "List files to find the correct path.",
      });
    }
  }
  const entries = indexedComments(snapshot).filter(({ comment, path: commentPath }) =>
    (!requestedPath || commentPath === requestedPath) &&
    (status === "all" || comment.resolved === (status === "resolved"))
  );
  let startIndex = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    const matches = decoded.workspaceVersion === snapshot.workspace.version &&
      decoded.path === requestedPath && decoded.status === status;
    const afterIndex = entries.findIndex(({ comment }) =>
      comment.createdAt === decoded.afterCreatedAt && comment.id === decoded.afterId
    );
    if (!matches || afterIndex < 0) {
      throw new TabulaCoreError("stale_cursor", "The comment-list cursor does not match the current session view.", {
        retry: "List comments again without a cursor.",
      });
    }
    startIndex = afterIndex + 1;
  }
  const page = entries.slice(startIndex, startIndex + limit);
  const truncated = startIndex + page.length < entries.length;
  const last = page.at(-1)?.comment;
  return {
    sessionId,
    comments: page.map(commentOutput),
    truncated,
    ...(truncated && last ? {
      nextCursor: encodeCursor({
        v: 1,
        workspaceVersion: snapshot.workspace.version,
        path: requestedPath,
        status,
        afterCreatedAt: last.createdAt,
        afterId: last.id,
      }),
    } : {}),
  };
};

export const addSessionComment = async ({
  registry,
  sessionId,
  path,
  body,
  startLine,
  endLine,
  now = () => new Date().toISOString(),
  id = randomUUID,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
  body: string;
  startLine?: number;
  endLine?: number;
  now?: () => string;
  id?: () => string;
}) => {
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const filePath = normalizeWorkspaceFilePath(path);
  const entry = buildWorkspacePathIndex(snapshot.workspace).byPath.get(filePath);
  if (!entry || entry.node.type !== "document") {
    throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
      details: { path: filePath },
      retry: "List files to find the correct path.",
    });
  }
  const content = snapshot.documents[entry.node.id];
  if (content === undefined) {
    throw new TabulaCoreError("session_not_ready", "The file content has not arrived yet.", {
      details: { path: filePath },
      retry: "Wait for session state and retry.",
    });
  }
  const range = lineRangeToOffsets(content, startLine, endLine);
  const comment: WorkspaceRoomComment = {
    id: id(),
    fileId: entry.node.id,
    body: requireBody(body),
    authorId: session.actor.id,
    authorName: session.actor.name,
    authorColor: session.actor.color,
    ...(range ? {
      quote: range.quote,
      sourceQuote: range.quote,
      selectionStart: range.selectionStart,
      selectionEnd: range.selectionEnd,
    } : {}),
    resolved: false,
    createdAt: now(),
    replies: [],
  };
  try {
    throwIfOperationAborted();
    await session.upsertComment(comment);
  } catch (error) {
    if (error instanceof TabulaCoreError) throw error;
    throw new TabulaCoreError("write_failed", "Tabula could not add the comment to the live session.", {
      details: { path: filePath },
      retry: "List comments and retry once.",
    });
  }
  const checkpoint = await persistAppliedMutation(session);
  return {
    sessionId,
    commentId: comment.id,
    path: filePath,
    ...(range ? { startLine: range.startLine, endLine: range.endLine } : {}),
    ...mutationReceipt(checkpoint),
  };
};

export const replyToSessionComment = async ({
  registry,
  sessionId,
  commentId,
  body,
  now = () => new Date().toISOString(),
  id = randomUUID,
}: {
  registry: SessionRegistry;
  sessionId: string;
  commentId: string;
  body: string;
  now?: () => string;
  id?: () => string;
}) => {
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const found = findComment(snapshot, commentId);
  const reply: WorkspaceRoomCommentReply = {
    id: id(),
    body: requireBody(body),
    authorId: session.actor.id,
    authorName: session.actor.name,
    authorColor: session.actor.color,
    createdAt: now(),
  };
  try {
    throwIfOperationAborted();
    await session.addCommentReply(commentId, reply);
  } catch (error) {
    if (error instanceof TabulaCoreError) throw error;
    throw new TabulaCoreError("write_failed", "Tabula could not add the comment reply to the live session.", {
      details: { commentId },
      retry: "List comments and retry once.",
    });
  }
  const checkpoint = await persistAppliedMutation(session);
  return {
    sessionId,
    commentId,
    path: found.path,
    replyId: reply.id,
    ...mutationReceipt(checkpoint),
  };
};

export const setSessionCommentResolved = async ({
  registry,
  sessionId,
  commentId,
  resolved,
}: {
  registry: SessionRegistry;
  sessionId: string;
  commentId: string;
  resolved: boolean;
}) => {
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const found = findComment(snapshot, commentId);
  if (found.comment.resolved === resolved) {
    return {
      sessionId,
      commentId,
      path: found.path,
      resolved,
      changed: false,
      ...mutationReceipt(session.checkpointPersistenceStatus()),
    };
  }
  try {
    throwIfOperationAborted();
    await session.setCommentResolved(commentId, resolved);
  } catch (error) {
    if (error instanceof TabulaCoreError) throw error;
    throw new TabulaCoreError("write_failed", "Tabula could not change the comment status in the live session.", {
      details: { commentId },
      retry: "List comments and retry once.",
    });
  }
  const checkpoint = await persistAppliedMutation(session);
  return {
    sessionId,
    commentId,
    path: found.path,
    resolved,
    changed: true,
    ...mutationReceipt(checkpoint),
  };
};

export const deleteSessionComment = async ({
  registry,
  sessionId,
  commentId,
}: {
  registry: SessionRegistry;
  sessionId: string;
  commentId: string;
}) => {
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const found = findComment(snapshot, commentId);
  try {
    throwIfOperationAborted();
    await session.deleteComment(commentId);
  } catch (error) {
    if (error instanceof TabulaCoreError) throw error;
    throw new TabulaCoreError("write_failed", "Tabula could not delete the comment from the live session.", {
      details: { commentId },
      retry: "List comments and retry once.",
    });
  }
  const checkpoint = await persistAppliedMutation(session);
  return {
    sessionId,
    commentId,
    path: found.path,
    deleted: true,
    ...mutationReceipt(checkpoint),
  };
};
