import path from "node:path";
import { getTextPatchesForChange } from "@tabula-md/tabula";
import { TabulaCoreError } from "./core-errors.js";
import type { SessionRegistry } from "./registry.js";
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

export const readSessionFile = async ({
  registry,
  sessionId,
  path: requestedPath,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
}) => {
  const filePath = normalizeWorkspaceFilePath(requestedPath);
  const { snapshot } = await readReadySnapshot(registry, sessionId);
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
      details: { sessionId, path: filePath },
      retry: "Wait for session state and retry.",
    });
  }
  return {
    sessionId,
    path: filePath,
    content,
    revision: entry.node.sha256,
    textLength: content.length,
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

export const writeSessionFile = async ({
  registry,
  sessionId,
  path: requestedPath,
  content,
  expectedRevision,
}: {
  registry: SessionRegistry;
  sessionId: string;
  path: string;
  content: string;
  expectedRevision?: string;
}) => {
  const filePath = normalizeWorkspaceFilePath(requestedPath);
  const { session, snapshot } = await readReadySnapshot(registry, sessionId);
  if (!session.writeAccess) {
    throw new TabulaCoreError("write_disabled", "This Tabula MCP connection is read-only.", {
      retry: "Reconnect using a writable Tabula MCP configuration.",
    });
  }
  const index = buildWorkspacePathIndex(snapshot.workspace);
  const existing = index.byPath.get(filePath);

  if (existing) {
    if (existing.node.type !== "document") {
      throw new TabulaCoreError("invalid_path", "A folder already exists at the requested file path.", {
        details: { path: filePath },
      });
    }
    const currentContent = snapshot.documents[existing.node.id] ?? "";
    const currentRevision = existing.node.sha256;
    if (!expectedRevision) {
      throw new TabulaCoreError("stale_revision", "An expected revision is required when replacing an existing file.", {
        details: { path: filePath, currentRevision },
        retry: "Read the file, then pass its revision to Write File.",
      });
    }
    if (expectedRevision !== currentRevision) {
      throw new TabulaCoreError("stale_revision", "The file changed before the write could be applied.", {
        details: { path: filePath, expectedRevision, currentRevision },
        retry: "Read the file again, merge the changes, and retry.",
      });
    }
    if (currentContent === content) {
      return { sessionId, path: filePath, created: false, changed: false, revision: currentRevision, textLength: content.length };
    }
    try {
      await session.applyWorkspaceChanges({
        changes: [{
          type: "document.patch",
          documentId: existing.node.id,
          baseSha256: currentRevision,
          patches: getTextPatchesForChange(currentContent, content),
        }],
      });
    } catch (error) {
      if (error instanceof Error && /changed before/i.test(error.message)) {
        const latest = await session.readWorkspaceSnapshot();
        const latestNode = latest.workspace.nodes.find(
          (node) => node.id === existing.node.id && node.type === "document",
        );
        throw new TabulaCoreError("stale_revision", "The file changed before the write could be applied.", {
          details: {
            path: filePath,
            expectedRevision,
            ...(latestNode?.type === "document" ? { currentRevision: latestNode.sha256 } : {}),
          },
          retry: "Read the file again, merge the changes, and retry.",
        });
      }
      if (error instanceof TabulaCoreError) throw error;
      throw writeFailed(filePath);
    }
    let updated;
    try {
      updated = await session.readWorkspaceSnapshot();
    } catch {
      throw writeFailed(filePath);
    }
    const updatedNode = updated.workspace.nodes.find((node) => node.id === existing.node.id && node.type === "document");
    if (!updatedNode || updatedNode.type !== "document") throw writeFailed(filePath);
    return { sessionId, path: filePath, created: false, changed: true, revision: updatedNode.sha256, textLength: content.length };
  }

  const parentPath = path.posix.dirname(filePath) === "." ? "" : path.posix.dirname(filePath);
  const parent = parentPath ? index.byPath.get(parentPath) : undefined;
  if (parentPath && (!parent || parent.node.type !== "folder")) {
    throw new TabulaCoreError("parent_folder_not_found", "The parent folder does not exist in the Tabula session.", {
      details: { path: parentPath },
      retry: "Choose an existing folder or write the file at the session root.",
    });
  }
  let changed;
  try {
    changed = await session.applyWorkspaceChanges({
      changes: [{ type: "document.create", parentId: parent?.node.id ?? null, title: path.posix.basename(filePath), markdown: content }],
    });
  } catch {
    throw writeFailed(filePath);
  }
  const documentId = changed.changedDocumentIds[0];
  if (!documentId) throw writeFailed(filePath);
  let created;
  try {
    created = await session.readWorkspaceSnapshot();
  } catch {
    throw writeFailed(filePath);
  }
  const createdNode = created.workspace.nodes.find((node) => node.id === documentId && node.type === "document");
  if (!createdNode || createdNode.type !== "document") throw writeFailed(filePath);
  return { sessionId, path: filePath, created: true, changed: true, revision: createdNode.sha256, textLength: content.length };
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
