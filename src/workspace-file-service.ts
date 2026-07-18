import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTextPatchesForChange } from "@tabula-md/tabula";
import { TabulaCoreError } from "./core-errors.js";
import { assertMarkdownSize } from "./documents/snapshot.js";
import type { SessionRegistry } from "./registry.js";
import type { WorkspaceChange } from "./workspace-contract.js";
import { buildWorkspacePathIndex, normalizeWorkspaceFilePath } from "./workspace-paths.js";

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

export const listSessionFiles = async ({
  registry,
  sessionId,
  path: requestedPath,
  recursive = true,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path?: string;
  recursive?: boolean;
}) => {
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
  const files = index.entries
    .filter((entry) => {
      if (!entry.path.startsWith(prefix) || entry.path === basePath) return false;
      return recursive || !entry.path.slice(prefix.length).includes("/");
    })
    .map(({ node, path: entryPath }) => node.type === "folder"
      ? { path: entryPath, type: "folder" as const }
      : {
          path: entryPath,
          type: "file" as const,
          revision: node.sha256,
          textLength: node.textLength,
        });

  return { sessionId, files, truncated: false };
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

export const searchSessionFiles = async ({
  registry,
  sessionId,
  query,
  path: requestedPath,
  maxResults = 20,
}: {
  registry: SessionRegistry;
  sessionId: string;
  query: string;
  path?: string;
  maxResults?: number;
}) => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const { snapshot } = await readReadySnapshot(registry, sessionId);
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const basePath = requestedPath ? normalizeWorkspaceFilePath(requestedPath) : "";
  const prefix = basePath ? `${basePath}/` : "";
  const matches: Array<{ path: string; line: number; excerpt: string }> = [];

  for (const entry of index.entries) {
    if (entry.node.type !== "document" || (basePath && entry.path !== basePath && !entry.path.startsWith(prefix))) continue;
    const content = snapshot.documents[entry.node.id] ?? "";
    const pathMatches = entry.path.toLocaleLowerCase().includes(normalizedQuery);
    for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
      if (!pathMatches && !line.toLocaleLowerCase().includes(normalizedQuery)) continue;
      matches.push({ path: entry.path, line: lineIndex + 1, excerpt: line.slice(0, 240) });
      if (matches.length >= maxResults) return { sessionId, matches, truncated: true };
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
  const outcomes = new Map<string, { created: boolean; changed: boolean; textLength: number }>();

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
      if (!file.expectedRevision) {
        throw new TabulaCoreError("stale_revision", "An expected revision is required when replacing an existing file.", {
          details: { path: file.path, currentRevision },
          retry: "Read the file, then pass its revision to Write Files.",
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
      outcomes.set(file.path, { created: false, changed, textLength: file.content.length });
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
    outcomes.set(file.path, { created: true, changed: true, textLength: file.content.length });
  }

  try {
    if (changes.length > 0) {
      await session.applyWorkspaceChanges({ changes });
    }
    await session.flushCheckpoint();
  } catch (error) {
    if (error instanceof Error && /changed before/i.test(error.message)) {
      throw new TabulaCoreError("stale_revision", "A file changed before the batch write could be applied.", {
        details: { paths: normalizedFiles.map((file) => file.path) },
        retry: "Read the existing files again, merge the changes, and retry the whole batch.",
      });
    }
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed(normalizedFiles.map((file) => file.path));
  }

  let updated;
  try {
    updated = await session.readWorkspaceSnapshot();
  } catch {
    throw writeFilesFailed(normalizedFiles.map((file) => file.path));
  }
  const updatedIndex = buildWorkspacePathIndex(updated.workspace);
  const results = normalizedFiles.map((file) => {
    const node = updatedIndex.byPath.get(file.path)?.node;
    const outcome = outcomes.get(file.path);
    if (!node || node.type !== "document" || !outcome) throw writeFilesFailed([file.path]);
    return {
      path: file.path,
      ...outcome,
      revision: node.sha256,
    };
  });
  return {
    sessionId,
    files: results,
    createdCount: results.filter((file) => file.created).length,
    changedCount: results.filter((file) => file.changed).length,
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
  return { sessionId, ...written };
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
  const entry = buildWorkspacePathIndex(snapshot.workspace).byPath.get(filePath);
  if (!entry || entry.node.type !== "document") {
    throw new TabulaCoreError("file_not_found", "Markdown file was not found in the Tabula session.", {
      details: { path: filePath },
      retry: "List files to find the correct path.",
    });
  }
  const currentContent = snapshot.documents[entry.node.id] ?? "";
  if (expectedRevision !== entry.node.sha256) {
    throw new TabulaCoreError("stale_revision", "The file changed before the edit could be applied.", {
      details: { path: filePath, expectedRevision, currentRevision: entry.node.sha256 },
      retry: "Read the file again, update the exact edits, and retry.",
    });
  }

  let nextContent = currentContent;
  for (const [editIndex, edit] of edits.entries()) {
    if (!edit.oldText) {
      throw new TabulaCoreError("invalid_input", "oldText must not be empty.", {
        details: { path: filePath, editIndex },
        retry: "Use Write Files to replace the whole file or provide exact non-empty oldText.",
      });
    }
    const offsets = exactMatchOffsets(nextContent, edit.oldText);
    if (offsets.length === 0) {
      throw new TabulaCoreError("edit_not_found", "The exact oldText was not found in the file.", {
        details: { path: filePath, editIndex },
        retry: "Read the latest file and copy the exact text to replace.",
      });
    }
    if (offsets.length > 1) {
      throw new TabulaCoreError("edit_ambiguous", "The exact oldText occurs more than once in the file.", {
        details: {
          path: filePath,
          editIndex,
          matchCount: offsets.length,
          matchingLines: offsets.slice(0, 10).map((offset) => lineAtOffset(nextContent, offset)),
        },
        retry: "Use a longer unique oldText segment and retry.",
      });
    }
    const offset = offsets[0]!;
    nextContent = `${nextContent.slice(0, offset)}${edit.newText}${nextContent.slice(offset + edit.oldText.length)}`;
  }
  assertMarkdownSize(nextContent);
  const changed = nextContent !== currentContent;
  if (changed) {
    try {
      await session.applyWorkspaceChanges({
        changes: [{
          type: "document.patch",
          documentId: entry.node.id,
          baseSha256: entry.node.sha256,
          patches: getTextPatchesForChange(currentContent, nextContent),
        }],
      });
      await session.flushCheckpoint();
    } catch (error) {
      if (error instanceof Error && /changed before/i.test(error.message)) {
        throw new TabulaCoreError("stale_revision", "The file changed before the edit could be applied.", {
          details: { path: filePath },
          retry: "Read the file again, update the exact edits, and retry.",
        });
      }
      if (error instanceof TabulaCoreError) throw error;
      throw writeFailed(filePath);
    }
  }
  const updated = changed ? await session.readWorkspaceSnapshot() : snapshot;
  const node = buildWorkspacePathIndex(updated.workspace).byPath.get(filePath)?.node;
  if (!node || node.type !== "document") throw writeFailed(filePath);
  return {
    sessionId,
    path: filePath,
    changed,
    editsApplied: edits.length,
    revision: node.sha256,
    textLength: node.textLength,
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
    return { sessionId, path: directoryPath, created: false };
  }
  const changes: WorkspaceChange[] = [];
  planFolderPath({
    folderPath: directoryPath,
    index,
    changes,
    plannedFolderIds: new Map(),
  });
  try {
    await session.applyWorkspaceChanges({ changes });
    await session.flushCheckpoint();
  } catch (error) {
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed([directoryPath]);
  }
  const updated = buildWorkspacePathIndex((await session.readWorkspaceSnapshot()).workspace).byPath.get(directoryPath);
  if (!updated || updated.node.type !== "folder") throw writeFilesFailed([directoryPath]);
  return { sessionId, path: directoryPath, created: true };
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
    return { sessionId, source, destination, type: sourceEntry.node.type === "document" ? "file" as const : "folder" as const, changed: false };
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
    await session.applyWorkspaceChanges({ changes: [{
      type: "node.move",
      nodeId: sourceEntry.node.id,
      baseParentId: sourceEntry.node.parentId,
      baseTitle: sourceEntry.node.title,
      ...(sourceEntry.node.type === "document" ? { baseSha256: sourceEntry.node.sha256 } : {}),
      parentId,
      title: path.posix.basename(destination),
    }] });
    await session.flushCheckpoint();
  } catch (error) {
    if (error instanceof Error && /changed before|path changed/i.test(error.message)) {
      throw new TabulaCoreError("stale_revision", "The source changed before it could be moved or renamed.", {
        details: { path: source },
        retry: "List files again and retry from the current path.",
      });
    }
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed([source, destination]);
  }
  const updated = buildWorkspacePathIndex((await session.readWorkspaceSnapshot()).workspace).byPath.get(destination);
  if (!updated || updated.node.id !== sourceEntry.node.id) throw writeFilesFailed([source, destination]);
  return {
    sessionId,
    source,
    destination,
    type: updated.node.type === "document" ? "file" as const : "folder" as const,
    changed: true,
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
    await session.applyWorkspaceChanges({ changes: [{
      type: "node.delete",
      nodeId: entry.node.id,
      baseParentId: entry.node.parentId,
      baseTitle: entry.node.title,
      ...(entry.node.type === "document" ? { baseSha256: entry.node.sha256 } : {}),
    }] });
    await session.flushCheckpoint();
  } catch (error) {
    if (error instanceof Error && /changed before|path changed/i.test(error.message)) {
      throw new TabulaCoreError("stale_revision", "The path changed before it could be deleted.", {
        details: { path: targetPath },
        retry: "List files again and retry from the current path.",
      });
    }
    if (error instanceof TabulaCoreError) throw error;
    throw writeFilesFailed([targetPath]);
  }
  const updatedIndex = buildWorkspacePathIndex((await session.readWorkspaceSnapshot()).workspace);
  if (updatedIndex.byPath.has(targetPath)) throw writeFilesFailed([targetPath]);
  return {
    sessionId,
    path: targetPath,
    type: entry.node.type === "document" ? "file" as const : "folder" as const,
    deleted: true,
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
