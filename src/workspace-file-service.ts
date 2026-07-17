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
    throw new TabulaCoreError("invalid_input", "At least one Markdown file path is required.");
  }
  if (paths.length > maxSessionReadFiles) {
    throw new TabulaCoreError("read_too_large", "Too many Markdown files were requested in one read.", {
      details: { requestedFiles: paths.length, maxFiles: maxSessionReadFiles },
      retry: "Read a smaller group of files or use Search Files to narrow the result.",
    });
  }

  const filePaths = paths.map(normalizeWorkspaceFilePath);
  if (new Set(filePaths).size !== filePaths.length) {
    throw new TabulaCoreError("invalid_path", "Each file path must be unique within one read.");
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
    throw new TabulaCoreError("invalid_input", "At least one Markdown file is required.");
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
      });
    }
    requestedPaths.add(file.path);
    assertMarkdownSize(file.content);
  }

  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  if (!session.writeAccess) {
    throw new TabulaCoreError("write_disabled", "This Tabula MCP connection is read-only.", {
      retry: "Reconnect using a writable Tabula MCP configuration.",
    });
  }
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const changes: WorkspaceChange[] = [];
  const plannedFolderIds = new Map<string, string>();
  const outcomes = new Map<string, { created: boolean; changed: boolean; textLength: number }>();

  const ensureFolder = (folderPath: string): string | null => {
    if (!folderPath) return null;
    const existing = index.byPath.get(folderPath);
    if (existing) {
      if (existing.node.type !== "folder") {
        throw new TabulaCoreError("invalid_path", "A Markdown file blocks a requested folder path.", {
          details: { path: folderPath },
        });
      }
      return existing.node.id;
    }
    if (requestedPaths.has(folderPath)) {
      throw new TabulaCoreError("invalid_path", "A requested file also needs to be a parent folder.", {
        details: { path: folderPath },
      });
    }
    const planned = plannedFolderIds.get(folderPath);
    if (planned) return planned;
    const parentPath = path.posix.dirname(folderPath) === "." ? "" : path.posix.dirname(folderPath);
    const folderId = randomUUID();
    changes.push({
      type: "folder.create",
      folderId,
      parentId: ensureFolder(parentPath),
      title: path.posix.basename(folderPath),
    });
    plannedFolderIds.set(folderPath, folderId);
    return folderId;
  };

  for (const file of normalizedFiles) {
    const existing = index.byPath.get(file.path);
    if (existing) {
      if (existing.node.type !== "document") {
        throw new TabulaCoreError("invalid_path", "A folder already exists at the requested file path.", {
          details: { path: file.path },
        });
      }
      const currentContent = snapshot.documents[existing.node.id] ?? "";
      const currentRevision = existing.node.sha256;
      if (!file.expectedRevision) {
        throw new TabulaCoreError("stale_revision", "An expected revision is required when replacing an existing file.", {
          details: { path: file.path, currentRevision },
          retry: "Read the file, then pass its revision to Write File or Write Files.",
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

    const parentPath = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
    changes.push({
      type: "document.create",
      parentId: ensureFolder(parentPath),
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
  return { ...snapshot, files };
};
