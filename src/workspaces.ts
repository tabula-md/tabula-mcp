import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256Text } from "./crypto.js";
import { assertMarkdownSize } from "./markdown-limits.js";
import { TabulaMcpError } from "./protocol.js";
import type {
  WorkspaceDocumentNode,
  WorkspaceFolderNode,
  WorkspaceNode,
  WorkspaceRoomState,
} from "./workspace-contract.js";

export type WorkspaceSourceKind = "created" | "imported";

export type WorkspaceFileInput = {
  path: string;
  title?: string;
  markdown: string;
};

export type WorkspaceDocumentContent = {
  documentId: string;
  path: string;
  title: string;
  markdown: string;
  textLength: number;
  sha256: string;
  updatedAt: string;
};

export type StoredWorkspace = {
  workspaceId: string;
  title: string;
  source: WorkspaceSourceKind;
  workspace: WorkspaceRoomState;
  documents: WorkspaceDocumentContent[];
  createdAt: string;
  updatedAt: string;
  sourceRootPath?: string;
};

export type WorkspaceCreateOptions = {
  title?: string;
  files?: readonly WorkspaceFileInput[];
  source?: WorkspaceSourceKind;
  sourceRootPath?: string;
};

const rootFolderId = "workspace-root";
const defaultWorkspaceTitle = "Workspace";

const normalizeWorkspacePath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized) {
    throw new TabulaMcpError("Workspace file path must be non-empty.");
  }

  const posixPath = path.posix.normalize(normalized);
  if (posixPath === "." || posixPath.startsWith("../") || posixPath === ".." || path.posix.isAbsolute(posixPath)) {
    throw new TabulaMcpError("Workspace file path must stay inside the workspace.");
  }

  return posixPath;
};

const basenameTitle = (filePath: string) => {
  const name = path.posix.basename(filePath).trim();
  return name || "Untitled.md";
};

const titleFromWorkspace = (title?: string) => title?.trim() || defaultWorkspaceTitle;

const createFolderNode = ({
  id,
  parentId,
  title,
  order,
  timestamp,
}: {
  id: string;
  parentId: string | null;
  title: string;
  order: number;
  timestamp: string;
}): WorkspaceFolderNode => ({
  id,
  type: "folder",
  parentId,
  title,
  order,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const folderIdForPath = (folderPath: string) =>
  folderPath ? `folder_${Buffer.from(folderPath).toString("base64url")}` : rootFolderId;

const documentIdForPath = (filePath: string, index: number) =>
  `doc_${Buffer.from(`${index}:${filePath}`).toString("base64url")}`;

const pathDepth = (filePath: string) => filePath.split("/").length;

const sortedWorkspaceFiles = (files: readonly WorkspaceFileInput[]) =>
  [...files].sort((left, right) => {
    const leftPath = normalizeWorkspacePath(left.path);
    const rightPath = normalizeWorkspacePath(right.path);
    return pathDepth(leftPath) - pathDepth(rightPath) || leftPath.localeCompare(rightPath, undefined, { sensitivity: "base" });
  });

export const createWorkspaceFromFiles = async ({
  title,
  files = [],
  source = "created",
  sourceRootPath,
}: WorkspaceCreateOptions): Promise<StoredWorkspace> => {
  const workspaceId = randomUUID();
  const timestamp = new Date().toISOString();
  const workspaceTitle = titleFromWorkspace(title);
  const folderNodes = new Map<string, WorkspaceFolderNode>();
  folderNodes.set(
    "",
    createFolderNode({
      id: rootFolderId,
      parentId: null,
      title: workspaceTitle,
      order: 0,
      timestamp,
    }),
  );

  const documents: WorkspaceDocumentContent[] = [];
  const documentNodes: WorkspaceDocumentNode[] = [];

  for (const [index, file] of sortedWorkspaceFiles(files).entries()) {
    const filePath = normalizeWorkspacePath(file.path);
    const directory = path.posix.dirname(filePath) === "." ? "" : path.posix.dirname(filePath);
    let parentPath = "";

    if (directory) {
      const parts = directory.split("/");
      for (let depth = 0; depth < parts.length; depth += 1) {
        const folderPath = parts.slice(0, depth + 1).join("/");
        if (!folderNodes.has(folderPath)) {
          folderNodes.set(
            folderPath,
            createFolderNode({
              id: folderIdForPath(folderPath),
              parentId: folderIdForPath(parentPath),
              title: parts[depth] || "Folder",
              order: folderNodes.size,
              timestamp,
            }),
          );
        }
        parentPath = folderPath;
      }
    }

    assertMarkdownSize(file.markdown);
    const documentId = documentIdForPath(filePath, index);
    const documentTitle = file.title?.trim() || basenameTitle(filePath);
    const sha256 = await sha256Text(file.markdown);
    const content: WorkspaceDocumentContent = {
      documentId,
      path: filePath,
      title: documentTitle,
      markdown: file.markdown,
      textLength: file.markdown.length,
      sha256,
      updatedAt: timestamp,
    };
    documents.push(content);
    documentNodes.push({
      id: documentId,
      type: "document",
      parentId: folderIdForPath(directory),
      title: documentTitle,
      sha256,
      textLength: file.markdown.length,
      order: index,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const workspace: WorkspaceRoomState = {
    roomId: workspaceId,
    mode: "workspace",
    version: 1,
    rootId: rootFolderId,
    nodes: [...folderNodes.values(), ...documentNodes],
    activeDocumentId: documentNodes[0]?.id,
  };

  return {
    workspaceId,
    title: workspaceTitle,
    source,
    workspace,
    documents,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(sourceRootPath ? { sourceRootPath } : {}),
  };
};

export const withWorkspaceRoomId = (workspace: StoredWorkspace, roomId: string): StoredWorkspace => ({
  ...workspace,
  workspace: {
    ...workspace.workspace,
    roomId,
    nodes: workspace.workspace.nodes.map((node): WorkspaceNode => ({ ...node })),
  },
});
