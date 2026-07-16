import path from "node:path";
import { TabulaCoreError } from "./core-errors.js";
import type { WorkspaceNode, WorkspaceRoomState } from "./workspace-contract.js";

export type WorkspacePathEntry = { node: WorkspaceNode; path: string };

export const normalizeWorkspaceFilePath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").trim();
  if (!normalized || normalized.includes("\0")) {
    throw new TabulaCoreError("invalid_path", "File path must be non-empty and contain no null bytes.");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new TabulaCoreError("invalid_path", "File path must be relative to the Tabula session.", {
      details: { path: value },
    });
  }
  const result = path.posix.normalize(normalized);
  if (result === "." || result === ".." || result.startsWith("../") || path.posix.isAbsolute(result)) {
    throw new TabulaCoreError("invalid_path", "File path must stay inside the Tabula session.", {
      details: { path: value },
    });
  }
  return result;
};

export const buildWorkspacePathIndex = (workspace: WorkspaceRoomState) => {
  const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
  const pathsById = new Map<string, string>();

  const resolveNodePath = (node: WorkspaceNode, ancestors = new Set<string>()): string => {
    const cached = pathsById.get(node.id);
    if (cached !== undefined) return cached;
    if (ancestors.has(node.id)) {
      throw new TabulaCoreError("invalid_path", "The Tabula session contains a folder cycle.");
    }
    const seen = new Set(ancestors).add(node.id);
    if (node.id === workspace.rootId) {
      pathsById.set(node.id, "");
      return "";
    }
    if (
      !node.title.trim() ||
      node.title === "." ||
      node.title === ".." ||
      node.title.includes("/") ||
      node.title.includes("\\") ||
      node.title.includes("\0")
    ) {
      throw new TabulaCoreError("invalid_path", "The Tabula session contains an invalid file or folder name.", {
        details: { nodeId: node.id },
      });
    }
    const parent = node.parentId ? nodesById.get(node.parentId) : undefined;
    if (node.parentId && node.parentId !== workspace.rootId && (!parent || parent.type !== "folder")) {
      throw new TabulaCoreError("invalid_path", "The Tabula session contains a node with an invalid parent.", {
        details: { nodeId: node.id, parentId: node.parentId },
      });
    }
    const parentPath = parent && parent.id !== workspace.rootId ? resolveNodePath(parent, seen) : "";
    const nodePath = parentPath ? `${parentPath}/${node.title}` : node.title;
    pathsById.set(node.id, nodePath);
    return nodePath;
  };

  const entries = workspace.nodes
    .filter((node) => node.id !== workspace.rootId)
    .map((node) => ({ node, path: resolveNodePath(node) }))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
  const byPath = new Map<string, WorkspacePathEntry>();
  const caseInsensitivePaths = new Map<string, string>();
  for (const entry of entries) {
    const folded = entry.path.toLocaleLowerCase();
    const duplicate = caseInsensitivePaths.get(folded);
    if (duplicate) {
      throw new TabulaCoreError("invalid_path", "The Tabula session contains ambiguous duplicate paths.", {
        details: { paths: [duplicate, entry.path] },
      });
    }
    caseInsensitivePaths.set(folded, entry.path);
    byPath.set(entry.path, entry);
  }
  return { entries, byPath, pathsById };
};
