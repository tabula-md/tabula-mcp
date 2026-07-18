import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTextPatchesForChange } from "@tabula-md/tabula/text-patches";
import { TabulaCoreError } from "./core-errors.js";
import { sha256Text } from "./crypto.js";
import { assertMarkdownSize } from "./markdown-limits.js";
import type { SessionRegistry } from "./registry.js";
import { WorkspaceConflictError } from "./protocol.js";
import { renderExactTextDiff, type ExactTextChange } from "./text-diff.js";
import type { WorkspaceChange } from "./workspace-contract.js";
import { buildWorkspacePathIndex, normalizeWorkspaceFilePath } from "./workspace-paths.js";
import { throwIfOperationAborted } from "./server/operation-context.js";
import {
  checkpointWithoutMutation,
  mutationReceipt,
  persistAppliedMutation,
} from "./mutation-receipt.js";

const requireSession = (registry: SessionRegistry, sessionId: string) => {
  try {
    return registry.get(sessionId);
  } catch {
    throw new TabulaCoreError("session_not_found", "The Tabula session is not connected.", {
      details: { sessionId },
      retry: "Join the room again.",
    });
  }
};

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

const writeFailed = (path: string) => new TabulaCoreError(
  "write_failed",
  "Tabula could not apply the file change to the live session.",
  {
    details: { path },
    retry: "Read the latest file state and retry once.",
  },
);

const writeFilesFailed = (paths: readonly string[]) => new TabulaCoreError(
  "write_failed",
  "Tabula could not apply the file changes to the live session.",
  {
    details: { paths },
    retry: "Read the latest file states and retry once.",
  },
);

export type SessionFileWrite = {
  path: string;
  content: string;
  expectedRevision?: string;
};

export type SessionTextEdit = {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

type WorkspacePathIndex = ReturnType<typeof buildWorkspacePathIndex>;

const requireWriteAccess = (session: { writeAccess: boolean }) => {
  if (!session.writeAccess) {
    throw new TabulaCoreError("write_disabled", "This Tabula MCP connection is read-only.", {
      retry: "Reconnect using a writable Tabula MCP configuration.",
    });
  }
};

const parentPathOf = (entryPath: string) => {
  const parentPath = path.posix.dirname(entryPath);
  return parentPath === "." ? "" : parentPath;
};

const planFolderPath = ({
  folderPath,
  index,
  changes,
  plannedFolderIds,
  blockedFilePaths = new Set<string>(),
}: {
  folderPath: string;
  index: WorkspacePathIndex;
  changes: WorkspaceChange[];
  plannedFolderIds: Map<string, string>;
  blockedFilePaths?: ReadonlySet<string>;
}): string | null => {
  if (!folderPath) return null;
  const existing = index.byPath.get(folderPath);
  if (existing) {
    if (existing.node.type !== "folder") {
      throw new TabulaCoreError("invalid_path", "A Markdown file blocks a requested folder path.", {
        details: { path: folderPath },
        retry: "Choose a different folder path or move the blocking file.",
      });
    }
    return existing.node.id;
  }
  if (blockedFilePaths.has(folderPath)) {
    throw new TabulaCoreError("invalid_path", "A requested file also needs to be a parent folder.", {
      details: { path: folderPath },
      retry: "Do not create a file at a path that must contain another file.",
    });
  }
  const planned = plannedFolderIds.get(folderPath);
  if (planned) return planned;
  const folderId = randomUUID();
  changes.push({
    type: "folder.create",
    folderId,
    parentId: planFolderPath({
      folderPath: parentPathOf(folderPath),
      index,
      changes,
      plannedFolderIds,
      blockedFilePaths,
    }),
    title: path.posix.basename(folderPath),
  });
  plannedFolderIds.set(folderPath, folderId);
  return folderId;
};

const exactMatchOffsets = (content: string, search: string) => {
  const offsets: number[] = [];
  let from = 0;
  while (from <= content.length - search.length) {
    const offset = content.indexOf(search, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + Math.max(1, search.length);
  }
  return offsets;
};

const lineAtOffset = (content: string, offset: number) =>
  content.slice(0, offset).split("\n").length;

export const maxSessionReadFiles = 20;
export const maxSessionReadCharacters = 100_000;
export const defaultSessionReadLines = 400;
export const maxSessionReadLines = 2_000;
export const maxSearchContextLines = 5;
export const defaultSessionListEntries = 100;
export const maxSessionListEntries = 200;

type SessionListCursor = {
  v: 1;
  workspaceVersion: number;
  basePath: string;
  recursive: boolean;
  afterPath: string;
};

const encodeSessionListCursor = (value: SessionListCursor) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeSessionListCursor = (cursor: string): SessionListCursor => {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SessionListCursor>;
    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.workspaceVersion) ||
      typeof parsed.basePath !== "string" ||
      typeof parsed.recursive !== "boolean" ||
      typeof parsed.afterPath !== "string" ||
      !parsed.afterPath
    ) throw new Error("Invalid cursor payload.");
    return parsed as SessionListCursor;
  } catch {
    throw new TabulaCoreError("stale_cursor", "The file-list cursor is invalid or no longer usable.", {
      retry: "List files again without a cursor.",
    });
  }
};

export const listSessionFiles = async ({
  registry,
  sessionId,
  path: requestedPath,
  recursive = true,
  limit = defaultSessionListEntries,
  cursor,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path?: string;
  recursive?: boolean;
  limit?: number;
  cursor?: string;
}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxSessionListEntries) {
    throw new TabulaCoreError("invalid_range", "File-list limit is outside the supported range.", {
      details: { limit, maximum: maxSessionListEntries },
      retry: `Use a limit between 1 and ${maxSessionListEntries}.`,
    });
  }
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const basePath = requestedPath ? normalizeWorkspaceFilePath(requestedPath) : "";
  if (basePath) {
    const base = index.byPath.get(basePath);
    if (!base || base.node.type !== "folder") {
      throw new TabulaCoreError("file_not_found", "Folder was not found in the Tabula session.", {
        details: { path: basePath },
        retry: "List files from the session root to find the correct path.",
      });
    }
  }

  const prefix = basePath ? `${basePath}/` : "";
  const entries = index.entries
    .filter((entry) => {
      if (!entry.path.startsWith(prefix) || entry.path === basePath) return false;
      return recursive || !entry.path.slice(prefix.length).includes("/");
    });
  let startIndex = 0;
  if (cursor) {
    const decoded = decodeSessionListCursor(cursor);
    const cursorMatchesRequest = decoded.workspaceVersion === snapshot.workspace.version &&
      decoded.basePath === basePath && decoded.recursive === recursive;
    const afterIndex = entries.findIndex((entry) => entry.path === decoded.afterPath);
    if (!cursorMatchesRequest || afterIndex < 0) {
      throw new TabulaCoreError("stale_cursor", "The file-list cursor does not match the current session view.", {
        details: { path: basePath || undefined },
        retry: "List files again without a cursor.",
      });
    }
    startIndex = afterIndex + 1;
  }
  const page = entries.slice(startIndex, startIndex + limit);
  const files = page.map(({ node, path: entryPath }) => node.type === "folder"
      ? { path: entryPath, type: "folder" as const }
      : {
          path: entryPath,
          type: "file" as const,
          revision: node.sha256,
          textLength: node.textLength,
        });
  const truncated = startIndex + page.length < entries.length;
  const lastPath = page.at(-1)?.path;

  return {
    sessionId,
    files,
    truncated,
    ...(truncated && lastPath
      ? {
          nextCursor: encodeSessionListCursor({
            v: 1,
            workspaceVersion: snapshot.workspace.version,
            basePath,
            recursive,
            afterPath: lastPath,
          }),
        }
      : {}),
  };
};

export const readSessionFiles = async ({
  registry,
  sessionId,
  paths,
}: {
  registry: SessionRegistry;
  sessionId: string;
  paths: readonly string[];
}) => {
  if (paths.length === 0) {
    throw new TabulaCoreError("invalid_input", "At least one Markdown file path is required.", {
      retry: "List files, then retry with one or more paths.",
    });
  }
  if (paths.length > maxSessionReadFiles) {
    throw new TabulaCoreError("read_too_large", "Too many Markdown files were requested in one read.", {
      details: { requestedFiles: paths.length, maxFiles: maxSessionReadFiles },
      retry: "Read a smaller group of files or use Search Files to narrow the result.",
    });
  }

  const filePaths = paths.map(normalizeWorkspaceFilePath);
  if (new Set(filePaths).size !== filePaths.length) {
    throw new TabulaCoreError("invalid_path", "Each file path must be unique within one read.", {
      retry: "Remove duplicate paths and retry Read Files.",
    });
  }
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const files = [];
  let totalCharacters = 0;

  for (const filePath of filePaths) {
    const entry = index.byPath.get(filePath);
    if (!entry || entry.node.type !== "document") {
      throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
        details: { path: filePath },
        retry: "List files to find the correct path.",
      });
    }
    const content = snapshot.documents[entry.node.id];
    if (content === undefined) {
      throw new TabulaCoreError("session_not_ready", "The file content has not arrived yet.", {
        details: { sessionId, path: filePath },
        retry: "Wait for session state and retry.",
      });
    }
    totalCharacters += content.length;
    if (totalCharacters > maxSessionReadCharacters) {
      throw new TabulaCoreError("read_too_large", "The requested Markdown files are too large to return in one read.", {
        details: {
          requestedFiles: filePaths.length,
          totalCharacters,
          maxCharacters: maxSessionReadCharacters,
        },
        retry: "Read a smaller group of files or use Search Files to narrow the result.",
      });
    }
    files.push({
      path: filePath,
      content,
      revision: entry.node.sha256,
      textLength: content.length,
    });
  }

  return {
    sessionId,
    files,
    totalCharacters,
  };
};

const lineStartsOf = (content: string) => {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
};

export const readSessionFile = async ({
  registry,
  sessionId,
  path: requestedPath,
  startLine,
  lineCount,
  tailLines,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
  startLine?: number;
  lineCount?: number;
  tailLines?: number;
}) => {
  if (tailLines !== undefined && (startLine !== undefined || lineCount !== undefined)) {
    throw new TabulaCoreError("invalid_input", "tailLines cannot be combined with startLine or lineCount.", {
      retry: "Use tailLines by itself, or use startLine with an optional lineCount.",
    });
  }
  const requestedCount = tailLines ?? lineCount ?? defaultSessionReadLines;
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > maxSessionReadLines) {
    throw new TabulaCoreError("invalid_range", "The requested line count is outside the supported range.", {
      details: { requestedLines: requestedCount, maxLines: maxSessionReadLines },
      retry: `Read between 1 and ${maxSessionReadLines} lines at a time.`,
    });
  }
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new TabulaCoreError("invalid_range", "startLine must be a positive line number.", {
      retry: "Use a startLine of 1 or greater.",
    });
  }

  const filePath = normalizeWorkspaceFilePath(requestedPath);
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const entry = buildWorkspacePathIndex(snapshot.workspace).byPath.get(filePath);
  if (!entry || entry.node.type !== "document") {
    throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
      details: { path: filePath },
      retry: "List files to find the correct path.",
    });
  }
  const fullContent = snapshot.documents[entry.node.id];
  if (fullContent === undefined) {
    throw new TabulaCoreError("session_not_ready", "The file content has not arrived yet.", {
      details: { sessionId, path: filePath },
      retry: "Wait for session state and retry.",
    });
  }

  const lineStarts = lineStartsOf(fullContent);
  const totalLines = lineStarts.length;
  const firstLine = tailLines === undefined
    ? (startLine ?? 1)
    : Math.max(1, totalLines - requestedCount + 1);
  if (firstLine > totalLines) {
    throw new TabulaCoreError("invalid_range", "startLine is beyond the end of the file.", {
      details: { path: filePath, startLine: firstLine, totalLines },
      retry: `Use a startLine between 1 and ${totalLines}.`,
    });
  }
  const endLine = Math.min(totalLines, firstLine + requestedCount - 1);
  const startOffset = lineStarts[firstLine - 1]!;
  const endOffset = endLine < totalLines ? lineStarts[endLine]! : fullContent.length;
  const content = fullContent.slice(startOffset, endOffset);
  if (content.length > maxSessionReadCharacters) {
    throw new TabulaCoreError("read_too_large", "The selected Markdown lines are too large to return.", {
      details: { path: filePath, startLine: firstLine, endLine, maxCharacters: maxSessionReadCharacters },
      retry: "Read a smaller line range.",
    });
  }

  return {
    sessionId,
    path: filePath,
    content,
    revision: entry.node.sha256,
    textLength: fullContent.length,
    totalLines,
    startLine: firstLine,
    endLine,
    truncated: firstLine > 1 || endLine < totalLines,
  };
};

export const searchSessionFiles = async ({
  registry,
  sessionId,
  query,
  path: requestedPath,
  maxResults = 20,
  contextLines = 1,
}: {
  registry: SessionRegistry;
  sessionId: string;
  query: string;
  path?: string;
  maxResults?: number;
  contextLines?: number;
}) => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    throw new TabulaCoreError("invalid_input", "Search query must not be empty.", {
      retry: "Provide literal text to find in paths or Markdown content.",
    });
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new TabulaCoreError("invalid_range", "Search maxResults is outside the supported range.", {
      details: { maxResults, maximum: 100 },
      retry: "Use maxResults between 1 and 100.",
    });
  }
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > maxSearchContextLines) {
    throw new TabulaCoreError("invalid_range", "Search contextLines is outside the supported range.", {
      details: { contextLines, maxContextLines: maxSearchContextLines },
      retry: `Use contextLines between 0 and ${maxSearchContextLines}.`,
    });
  }
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const basePath = requestedPath ? normalizeWorkspaceFilePath(requestedPath) : "";
  if (basePath && !index.byPath.has(basePath)) {
    throw new TabulaCoreError("file_not_found", "Search scope was not found in the Tabula session.", {
      details: { path: basePath },
      retry: "List files to find the correct file or folder path.",
    });
  }
  const prefix = basePath ? `${basePath}/` : "";
  const matches: Array<{
    path: string;
    kind: "path" | "content";
    line: number;
    match: string;
    before: string[];
    after: string[];
  }> = [];
  const addMatch = (match: (typeof matches)[number]) => {
    matches.push(match);
    return matches.length > maxResults;
  };

  for (const entry of index.entries) {
    if (entry.node.type !== "document" || (basePath && entry.path !== basePath && !entry.path.startsWith(prefix))) continue;
    const content = snapshot.documents[entry.node.id] ?? "";
    if (entry.path.toLocaleLowerCase().includes(normalizedQuery)) {
      if (addMatch({ path: entry.path, kind: "path", line: 1, match: entry.path, before: [], after: [] })) {
        return { sessionId, matches: matches.slice(0, maxResults), truncated: true };
      }
    }
    const lines = content.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;
      if (addMatch({
        path: entry.path,
        kind: "content",
        line: lineIndex + 1,
        match: line.slice(0, 240),
        before: lines.slice(Math.max(0, lineIndex - contextLines), lineIndex).map((value: string) => value.slice(0, 240)),
        after: lines.slice(lineIndex + 1, lineIndex + contextLines + 1).map((value: string) => value.slice(0, 240)),
      })) {
        return { sessionId, matches: matches.slice(0, maxResults), truncated: true };
      }
    }
  }
  return { sessionId, matches, truncated: false };
};

export const writeSessionFiles = async ({
  registry,
  sessionId,
  files,
}: {
  registry: SessionRegistry;
  sessionId: string;
  files: readonly SessionFileWrite[];
}) => {
  if (files.length === 0) {
    throw new TabulaCoreError("invalid_input", "At least one Markdown file is required.", {
      retry: "Retry with one or more file objects.",
    });
  }
  const normalizedFiles = files.map((file) => ({
    ...file,
    path: normalizeWorkspaceFilePath(file.path),
  }));
  const requestedPaths = new Set<string>();
  for (const file of normalizedFiles) {
    if (requestedPaths.has(file.path)) {
      throw new TabulaCoreError("invalid_path", "Each file path must be unique within one write.", {
        details: { path: file.path },
        retry: "Remove the duplicate file path and retry the whole write.",
      });
    }
    requestedPaths.add(file.path);
    assertMarkdownSize(file.content);
  }

  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const changes: WorkspaceChange[] = [];
  const plannedFolderIds = new Map<string, string>();
  const outcomes = new Map<string, {
    created: boolean;
    changed: boolean;
    revision: string;
    textLength: number;
  }>();

  for (const file of normalizedFiles) {
    const existing = index.byPath.get(file.path);
    if (existing) {
      if (existing.node.type !== "document") {
        throw new TabulaCoreError("invalid_path", "A folder already exists at the requested file path.", {
          details: { path: file.path },
          retry: "Choose a file path that is not already a folder.",
        });
      }
      const currentContent = snapshot.documents[existing.node.id] ?? "";
      const currentRevision = existing.node.sha256;
      if (currentContent === file.content) {
        outcomes.set(file.path, {
          created: false,
          changed: false,
          revision: currentRevision,
          textLength: file.content.length,
        });
        continue;
      }
      if (!file.expectedRevision) {
        throw new TabulaCoreError("stale_revision", "An expected revision is required when replacing an existing file.", {
          details: { path: file.path, currentRevision },
          retry: "Read the file, then pass its revision to the write.",
        });
      }
      if (file.expectedRevision !== currentRevision) {
        throw new TabulaCoreError("stale_revision", "The file changed before the write could be applied.", {
          details: { path: file.path, expectedRevision: file.expectedRevision, currentRevision },
          retry: "Read the file again, merge the changes, and retry.",
        });
      }
      const changed = currentContent !== file.content;
      if (changed) {
        changes.push({
          type: "document.patch",
          documentId: existing.node.id,
          baseSha256: currentRevision,
          patches: getTextPatchesForChange(currentContent, file.content),
        });
      }
      outcomes.set(file.path, {
        created: false,
        changed,
        revision: await sha256Text(file.content),
        textLength: file.content.length,
      });
      continue;
    }

    const parentPath = parentPathOf(file.path);
    changes.push({
      type: "document.create",
      parentId: planFolderPath({
        folderPath: parentPath,
        index,
        changes,
        plannedFolderIds,
        blockedFilePaths: requestedPaths,
      }),
      title: path.posix.basename(file.path),
      markdown: file.content,
    });
    outcomes.set(file.path, {
      created: true,
      changed: true,
      revision: await sha256Text(file.content),
      textLength: file.content.length,
    });
  }

  try {
    throwIfOperationAborted();
    if (changes.length > 0) await session.applyWorkspaceChanges({ changes });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) {
      throw new TabulaCoreError("stale_revision", "A file changed before the batch write could be applied.", {
        details: { paths: normalizedFiles.map((file) => file.path) },
        retry: "Read the existing files again, merge the changes, and retry the whole batch.",
      });
    }
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed(normalizedFiles.map((file) => file.path));
  }
  const checkpoint = changes.length > 0
    ? await persistAppliedMutation(session)
    : checkpointWithoutMutation(session);

  try {
    const updatedIndex = buildWorkspacePathIndex((await session.readWorkspaceSnapshot()).workspace);
    for (const file of normalizedFiles) {
      const node = updatedIndex.byPath.get(file.path)?.node;
      const outcome = outcomes.get(file.path);
      if (node?.type === "document" && outcome) outcome.revision = node.sha256;
    }
  } catch {
    // The apply receipt is authoritative. Locally computed revisions remain
    // usable if post-commit projection is temporarily unavailable.
  }

  const results = normalizedFiles.map((file) => {
    const outcome = outcomes.get(file.path);
    if (!outcome) throw writeFilesFailed([file.path]);
    return {
      path: file.path,
      ...outcome,
    };
  });
  return {
    sessionId,
    files: results,
    createdCount: results.filter((file) => file.created).length,
    changedCount: results.filter((file) => file.changed).length,
    ...mutationReceipt(checkpoint),
  };
};

export const writeSessionFile = async ({
  registry,
  sessionId,
  path: filePath,
  content,
  expectedRevision,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
  content: string;
  expectedRevision?: string;
}) => {
  let result;
  try {
    result = await writeSessionFiles({
      registry,
      sessionId,
      files: [{ path: filePath, content, expectedRevision }],
    });
  } catch (error) {
    if (error instanceof TabulaCoreError && error.code === "write_failed") {
      throw writeFailed(normalizeWorkspaceFilePath(filePath));
    }
    throw error;
  }
  const written = result.files[0];
  if (!written) throw writeFailed(filePath);
  return {
    sessionId,
    ...written,
    applied: result.applied,
    persisted: result.persisted,
    checkpointPending: result.checkpointPending,
  };
};

export const editSessionFile = async ({
  registry,
  sessionId,
  path: requestedPath,
  expectedRevision,
  edits,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
  expectedRevision: string;
  edits: readonly SessionTextEdit[];
}) => {
  const filePath = normalizeWorkspaceFilePath(requestedPath);
  if (edits.length === 0) {
    throw new TabulaCoreError("invalid_input", "At least one exact text edit is required.", {
      retry: "Retry with one or more oldText and newText pairs.",
    });
  }
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const planEdits = (candidateSnapshot: typeof snapshot, stale: boolean) => {
    const entry = buildWorkspacePathIndex(candidateSnapshot.workspace).byPath.get(filePath);
    if (!entry || entry.node.type !== "document") {
      throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
        details: { path: filePath },
        retry: "List files to find the correct path.",
      });
    }
    const documentId = entry.node.id;
    const currentRevision = entry.node.sha256;
    const currentContent = candidateSnapshot.documents[entry.node.id];
    if (currentContent === undefined) {
      throw new TabulaCoreError("session_not_ready", "The file content has not arrived yet.", {
        details: { sessionId, path: filePath },
        retry: "Wait for session state and retry.",
      });
    }
    let nextContent = currentContent;
    let editsApplied = 0;
    const diffChanges: ExactTextChange[] = [];
    const staleFailure = (message: string, details: Record<string, unknown>) =>
      new TabulaCoreError("stale_revision", message, {
        details: { path: filePath, expectedRevision, currentRevision, ...details },
        retry: "Read the latest file, update the exact edits, and retry.",
      });

    for (const [editIndex, edit] of edits.entries()) {
      if (!edit.oldText) {
        throw new TabulaCoreError("invalid_input", "oldText must not be empty.", {
          details: { path: filePath, editIndex },
          retry: "Use Write File to replace the whole file or provide exact non-empty oldText.",
        });
      }
      const offsets = exactMatchOffsets(nextContent, edit.oldText);
      if (offsets.length === 0) {
        if (stale) throw staleFailure("The file changed and oldText no longer matches exactly.", { editIndex });
        throw new TabulaCoreError("edit_not_found", "The exact oldText was not found in the file.", {
          details: { path: filePath, editIndex },
          retry: "Read the latest file and copy the exact text to replace.",
        });
      }
      if (offsets.length > 1 && !edit.replaceAll) {
        const details = {
          editIndex,
          matchCount: offsets.length,
          matchingLines: offsets.slice(0, 10).map((offset) => lineAtOffset(nextContent, offset)),
        };
        if (stale) throw staleFailure("The file changed and oldText is no longer unique.", details);
        throw new TabulaCoreError("edit_ambiguous", "The exact oldText occurs more than once in the file.", {
          details: { path: filePath, ...details },
          retry: "Use a longer unique oldText segment or set replaceAll true.",
        });
      }
      const selectedOffsets = edit.replaceAll ? offsets : offsets.slice(0, 1);
      for (const offset of [...selectedOffsets].reverse()) {
        const before = nextContent;
        nextContent = `${nextContent.slice(0, offset)}${edit.newText}${nextContent.slice(offset + edit.oldText.length)}`;
        diffChanges.push({ before, after: nextContent, offset, oldText: edit.oldText, newText: edit.newText });
        editsApplied += 1;
      }
    }
    assertMarkdownSize(nextContent);
    return { documentId, currentRevision, currentContent, nextContent, editsApplied, diffChanges };
  };

  const initialEntry = buildWorkspacePathIndex(snapshot.workspace).byPath.get(filePath);
  if (!initialEntry || initialEntry.node.type !== "document") {
    throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
      details: { path: filePath },
      retry: "List files to find the correct path.",
    });
  }
  let rebased = expectedRevision !== initialEntry.node.sha256;
  let activeSnapshot = snapshot;
  let plan = planEdits(activeSnapshot, rebased);
  let changed = plan.nextContent !== plan.currentContent;
  if (changed) {
    try {
      throwIfOperationAborted();
      await session.applyWorkspaceChanges({ changes: [{
        type: "document.patch",
        documentId: plan.documentId,
        baseSha256: plan.currentRevision,
        patches: getTextPatchesForChange(plan.currentContent, plan.nextContent),
      }] });
    } catch (error) {
      if (!(error instanceof WorkspaceConflictError)) {
        if (error instanceof TabulaCoreError) throw error;
        throw writeFailed(filePath);
      }
      activeSnapshot = await session.readWorkspaceSnapshot();
      plan = planEdits(activeSnapshot, true);
      rebased = true;
      changed = plan.nextContent !== plan.currentContent;
      if (changed) {
        try {
          throwIfOperationAborted();
          await session.applyWorkspaceChanges({ changes: [{
            type: "document.patch",
            documentId: plan.documentId,
            baseSha256: plan.currentRevision,
            patches: getTextPatchesForChange(plan.currentContent, plan.nextContent),
          }] });
        } catch (retryError) {
          if (retryError instanceof WorkspaceConflictError) {
            throw new TabulaCoreError("stale_revision", "The file kept changing before the edit could be applied.", {
              details: { path: filePath },
              retry: "Read the latest file and retry the edit.",
            });
          }
          if (retryError instanceof TabulaCoreError) throw retryError;
          throw writeFailed(filePath);
        }
      }
    }
  }
  const checkpoint = changed
    ? await persistAppliedMutation(session)
    : checkpointWithoutMutation(session);
  let revision = await sha256Text(plan.nextContent);
  let textLength = plan.nextContent.length;
  try {
    const node = buildWorkspacePathIndex((await session.readWorkspaceSnapshot()).workspace).byPath.get(filePath)?.node;
    if (node?.type === "document") {
      revision = node.sha256;
      textLength = node.textLength;
    }
  } catch {
    // Do not turn an applied edit into a failure because projection is unavailable.
  }
  const renderedDiff = renderExactTextDiff({ path: filePath, changes: plan.diffChanges });
  return {
    sessionId,
    path: filePath,
    changed,
    editsApplied: plan.editsApplied,
    rebased,
    revision,
    textLength,
    ...mutationReceipt(checkpoint),
    ...renderedDiff,
  };
};

export const createSessionDirectory = async ({
  registry,
  sessionId,
  path: requestedPath,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
}) => {
  const directoryPath = normalizeWorkspaceFilePath(requestedPath);
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const existing = index.byPath.get(directoryPath);
  if (existing) {
    if (existing.node.type !== "folder") {
      throw new TabulaCoreError("path_exists", "A Markdown file already exists at the requested directory path.", {
        details: { path: directoryPath },
        retry: "Choose another directory path or move the existing file first.",
      });
    }
    return {
      sessionId,
      path: directoryPath,
      created: false,
      ...mutationReceipt(checkpointWithoutMutation(session)),
    };
  }
  const changes: WorkspaceChange[] = [];
  planFolderPath({
    folderPath: directoryPath,
    index,
    changes,
    plannedFolderIds: new Map(),
  });
  try {
    throwIfOperationAborted();
    await session.applyWorkspaceChanges({ changes });
  } catch (error) {
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed([directoryPath]);
  }
  const checkpoint = await persistAppliedMutation(session);
  return { sessionId, path: directoryPath, created: true, ...mutationReceipt(checkpoint) };
};

export const moveSessionFile = async ({
  registry,
  sessionId,
  source: requestedSource,
  destination: requestedDestination,
  expectedRevision,
}: {
  registry: SessionRegistry;
  sessionId: string;
  source: string;
  destination: string;
  expectedRevision?: string;
}) => {
  const source = normalizeWorkspaceFilePath(requestedSource);
  const destination = normalizeWorkspaceFilePath(requestedDestination);
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const sourceEntry = index.byPath.get(source);
  if (!sourceEntry) {
    throw new TabulaCoreError("file_not_found", "The source file or directory was not found.", {
      details: { path: source },
      retry: "List files to find the correct source path.",
    });
  }
  if (source === destination) {
    return {
      sessionId,
      source,
      destination,
      type: sourceEntry.node.type === "document" ? "file" as const : "folder" as const,
      changed: false,
      ...mutationReceipt(checkpointWithoutMutation(session)),
    };
  }
  const destinationCollision = index.entries.find((entry) =>
    entry.node.id !== sourceEntry.node.id && entry.path.toLocaleLowerCase() === destination.toLocaleLowerCase()
  );
  if (destinationCollision) {
    throw new TabulaCoreError("path_exists", "Another file or directory already exists at the destination.", {
      details: { path: destination },
      retry: "Choose an unused destination path.",
    });
  }
  if (
    sourceEntry.node.type === "folder" &&
    destination.toLocaleLowerCase().startsWith(`${source.toLocaleLowerCase()}/`)
  ) {
    throw new TabulaCoreError("invalid_path", "A directory cannot be moved inside itself.", {
      details: { source, destination },
      retry: "Choose a destination outside the source directory.",
    });
  }
  const parentPath = parentPathOf(destination);
  const parent = parentPath ? index.byPath.get(parentPath) : undefined;
  if (parentPath && (!parent || parent.node.type !== "folder")) {
    throw new TabulaCoreError("parent_folder_not_found", "The destination parent directory does not exist.", {
      details: { path: parentPath },
      retry: "Create the destination directory first, then retry Move or Rename.",
    });
  }
  if (sourceEntry.node.type === "document") {
    if (!expectedRevision) {
      throw new TabulaCoreError("stale_revision", "An expected revision is required when moving or renaming a file.", {
        details: { path: source, currentRevision: sourceEntry.node.sha256 },
        retry: "Read the file, then pass its revision to Move or Rename.",
      });
    }
    if (expectedRevision !== sourceEntry.node.sha256) {
      throw new TabulaCoreError("stale_revision", "The file changed before it could be moved or renamed.", {
        details: { path: source, expectedRevision, currentRevision: sourceEntry.node.sha256 },
        retry: "Read the file again and retry with its current revision.",
      });
    }
  }
  const parentId = parent?.node.id ?? null;
  try {
    throwIfOperationAborted();
    await session.applyWorkspaceChanges({ changes: [{
      type: "node.move",
      nodeId: sourceEntry.node.id,
      baseParentId: sourceEntry.node.parentId,
      baseTitle: sourceEntry.node.title,
      ...(sourceEntry.node.type === "document" ? { baseSha256: sourceEntry.node.sha256 } : {}),
      parentId,
      title: path.posix.basename(destination),
    }] });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) {
      throw new TabulaCoreError("stale_revision", "The source changed before it could be moved or renamed.", {
        details: { path: source },
        retry: "List files again and retry from the current path.",
      });
    }
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed([source, destination]);
  }
  const checkpoint = await persistAppliedMutation(session);
  return {
    sessionId,
    source,
    destination,
    type: sourceEntry.node.type === "document" ? "file" as const : "folder" as const,
    changed: true,
    ...mutationReceipt(checkpoint),
  };
};

export const deleteSessionPath = async ({
  registry,
  sessionId,
  path: requestedPath,
  expectedRevision,
  recursive = false,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
  expectedRevision?: string;
  recursive?: boolean;
}) => {
  const targetPath = normalizeWorkspaceFilePath(requestedPath);
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  requireWriteAccess(session);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const entry = index.byPath.get(targetPath);
  if (!entry) {
    throw new TabulaCoreError("file_not_found", "The file or directory to delete was not found.", {
      details: { path: targetPath },
      retry: "List files to find the correct path.",
    });
  }
  if (entry.node.type === "folder") {
    const hasChildren = index.entries.some((candidate) => candidate.path.startsWith(`${targetPath}/`));
    if (hasChildren && !recursive) {
      throw new TabulaCoreError("directory_not_empty", "The directory is not empty.", {
        details: { path: targetPath },
        retry: "Retry with recursive true only if the user intends to delete every descendant.",
      });
    }
  } else {
    if (!expectedRevision) {
      throw new TabulaCoreError("stale_revision", "An expected revision is required when deleting a file.", {
        details: { path: targetPath, currentRevision: entry.node.sha256 },
        retry: "Read the file, then pass its revision to Delete Path.",
      });
    }
    if (expectedRevision !== entry.node.sha256) {
      throw new TabulaCoreError("stale_revision", "The file changed before it could be deleted.", {
        details: { path: targetPath, expectedRevision, currentRevision: entry.node.sha256 },
        retry: "Read the file again and retry with its current revision.",
      });
    }
  }
  try {
    throwIfOperationAborted();
    await session.applyWorkspaceChanges({ changes: [{
      type: "node.delete",
      nodeId: entry.node.id,
      baseParentId: entry.node.parentId,
      baseTitle: entry.node.title,
      ...(entry.node.type === "document" ? { baseSha256: entry.node.sha256 } : {}),
    }] });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) {
      throw new TabulaCoreError("stale_revision", "The path changed before it could be deleted.", {
        details: { path: targetPath },
        retry: "List files again and retry from the current path.",
      });
    }
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed([targetPath]);
  }
  const checkpoint = await persistAppliedMutation(session);
  return {
    sessionId,
    path: targetPath,
    type: entry.node.type === "document" ? "file" as const : "folder" as const,
    deleted: true,
    ...mutationReceipt(checkpoint),
  };
};

export const readSessionExportSnapshot = async ({
  registry,
  sessionId,
  paths,
}: {
  registry: SessionRegistry;
  sessionId: string;
  paths?: readonly string[];
}) => {
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const selected = paths?.length ? new Set(paths.map(normalizeWorkspaceFilePath)) : null;
  const files = index.entries.flatMap((entry) => {
    if (entry.node.type !== "document" || (selected && !selected.has(entry.path))) return [];
    return [{ id: entry.node.id, path: entry.path, title: entry.node.title, text: snapshot.documents[entry.node.id] ?? "" }];
  });
  if (selected && files.length !== selected.size) {
    const found = new Set(files.map((file) => file.path));
    const missing = [...selected].find((filePath) => !found.has(filePath));
    throw new TabulaCoreError("file_not_found", "A requested export file was not found.", {
      details: { path: missing },
      retry: "List files and retry with valid paths.",
    });
  }
  const selectedIds = new Set(files.map((file) => file.id));
  const commentsByFileId = Object.fromEntries(
    Object.entries(snapshot.commentsByFileId).filter(([fileId]) => selectedIds.has(fileId)),
  );
  return {
    ...snapshot,
    activeDocumentId: snapshot.activeDocumentId && selectedIds.has(snapshot.activeDocumentId)
      ? snapshot.activeDocumentId
      : files[0]?.id,
    commentsByFileId,
    files,
  };
};
