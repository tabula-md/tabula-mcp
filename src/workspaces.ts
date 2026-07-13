import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Text } from "./crypto.js";
import { assertMarkdownSize } from "./documents/index.js";
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

export type ImportMarkdownWorkspaceOptions = {
  rootPath: string;
  title?: string;
  maxFiles?: number;
  excludeDirectories?: readonly string[];
};

export type ReadWorkspaceResult = {
  workspaceId: string;
  roomId: string;
  workspace: WorkspaceRoomState;
  activeDocumentId?: string;
  documents: Array<WorkspaceDocumentNode & { cached: true; path?: string }>;
  cachedDocumentCount: number;
  hydrationStatus: "ready";
  stateReceived: true;
  createdAt: string;
  updatedAt: string;
  source: WorkspaceSourceKind;
  sourceRootPath?: string;
};

export type ReadWorkspaceDocumentResult = {
  workspaceId: string;
  roomId: string;
  documentId: string;
  path?: string;
  title: string;
  markdown: string;
  textLength: number;
  sha256: string;
  cachedAt: string;
  hydrationStatus: "ready";
  stateReceived: true;
};

const rootFolderId = "workspace-root";
const defaultWorkspaceTitle = "Workspace";
const defaultMaxImportFiles = 200;
const defaultExcludedDirectories = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const markdownExtensions = new Set([".md", ".mdx"]);

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

const shouldSkipDirectory = (name: string, excludedDirectories: ReadonlySet<string>) =>
  excludedDirectories.has(name) || excludedDirectories.has(name.toLowerCase());

export const collectMarkdownFiles = async ({
  rootPath,
  maxFiles = defaultMaxImportFiles,
  excludeDirectories = [...defaultExcludedDirectories],
}: ImportMarkdownWorkspaceOptions): Promise<WorkspaceFileInput[]> => {
  const resolvedRoot = path.resolve(rootPath);
  const rootStats = await stat(resolvedRoot).catch(() => null);
  if (!rootStats?.isDirectory()) {
    throw new TabulaMcpError("Markdown workspace import rootPath must be an existing directory.");
  }

  const excluded = new Set(excludeDirectories.map((entry) => entry.trim()).filter(Boolean));
  const files: WorkspaceFileInput[] = [];

  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, excluded)) {
          await visit(absolutePath);
        }
        continue;
      }
      if (!entry.isFile() || !markdownExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      if (files.length >= maxFiles) {
        throw new TabulaMcpError(`Markdown workspace import is limited to ${maxFiles} files.`);
      }
      const relativePath = path.relative(resolvedRoot, absolutePath).split(path.sep).join(path.posix.sep);
      files.push({
        path: relativePath,
        markdown: await readFile(absolutePath, "utf8"),
      });
    }
  };

  await visit(resolvedRoot);
  if (files.length === 0) {
    throw new TabulaMcpError("No Markdown files were found under rootPath.");
  }

  return sortedWorkspaceFiles(files);
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, StoredWorkspace>();
  private latestWorkspaceId = "";

  async create(options: WorkspaceCreateOptions = {}) {
    const workspace = await createWorkspaceFromFiles(options);
    this.add(workspace);
    return workspace;
  }

  async importMarkdown(options: ImportMarkdownWorkspaceOptions) {
    const files = await collectMarkdownFiles(options);
    const workspace = await createWorkspaceFromFiles({
      title: options.title,
      files,
      source: "imported",
      sourceRootPath: path.resolve(options.rootPath),
    });
    this.add(workspace);
    return workspace;
  }

  add(workspace: StoredWorkspace) {
    this.workspaces.set(workspace.workspaceId, workspace);
    this.latestWorkspaceId = workspace.workspaceId;
  }

  get(workspaceId?: string) {
    if (workspaceId) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) {
        throw new TabulaMcpError("Unknown Tabula workspace id.");
      }
      return workspace;
    }

    if (this.workspaces.size === 0) {
      throw new TabulaMcpError("No Tabula workspace has been created or imported.");
    }
    if (this.workspaces.size === 1) {
      const workspace = [...this.workspaces.values()][0];
      if (!workspace) {
        throw new TabulaMcpError("No Tabula workspace has been created or imported.");
      }
      return workspace;
    }

    const latestWorkspace = this.workspaces.get(this.latestWorkspaceId);
    if (latestWorkspace) {
      return latestWorkspace;
    }

    throw new TabulaMcpError("Multiple workspaces exist. Pass workspaceId explicitly.");
  }

  has(workspaceId?: string) {
    return workspaceId ? this.workspaces.has(workspaceId) : this.workspaces.size > 0;
  }

  list() {
    return [...this.workspaces.values()];
  }

  clear() {
    this.workspaces.clear();
    this.latestWorkspaceId = "";
  }
}

export const readStoredWorkspace = (workspace: StoredWorkspace): ReadWorkspaceResult => {
  const documentsById = new Map(workspace.documents.map((document) => [document.documentId, document]));
  return {
    workspaceId: workspace.workspaceId,
    roomId: workspace.workspace.roomId,
    workspace: workspace.workspace,
    activeDocumentId: workspace.workspace.activeDocumentId,
    documents: workspace.workspace.nodes
      .filter((node): node is WorkspaceDocumentNode => node.type === "document")
      .map((node) => ({
        ...node,
        cached: true as const,
        path: documentsById.get(node.id)?.path,
    })),
    cachedDocumentCount: workspace.documents.length,
    hydrationStatus: "ready",
    stateReceived: true,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    source: workspace.source,
    ...(workspace.sourceRootPath ? { sourceRootPath: workspace.sourceRootPath } : {}),
  };
};

export const readStoredWorkspaceDocument = (
  workspace: StoredWorkspace,
  documentId: string,
): ReadWorkspaceDocumentResult => {
  const document = workspace.documents.find((candidate) => candidate.documentId === documentId);
  if (!document) {
    throw new TabulaMcpError("Workspace document was not found.");
  }

  return {
    workspaceId: workspace.workspaceId,
    roomId: workspace.workspace.roomId,
    documentId,
    path: document.path,
    title: document.title,
    markdown: document.markdown,
    textLength: document.textLength,
    sha256: document.sha256,
    cachedAt: document.updatedAt,
    hydrationStatus: "ready",
    stateReceived: true,
  };
};

export const workspaceShareFiles = (workspace: StoredWorkspace) =>
  workspace.documents.map((document) => ({
    id: document.documentId,
    title: document.title,
    text: document.markdown,
  }));

export const withWorkspaceRoomId = (workspace: StoredWorkspace, roomId: string): StoredWorkspace => ({
  ...workspace,
  workspace: {
    ...workspace.workspace,
    roomId,
    nodes: workspace.workspace.nodes.map((node): WorkspaceNode => ({ ...node })),
  },
});
