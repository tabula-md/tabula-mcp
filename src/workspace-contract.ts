import type { WorkspaceRoomNode } from "@tabula-md/tabula/collaboration";
import type { TextPatch } from "./text.js";

export type WorkspaceFolderNode = WorkspaceRoomNode & { type: "folder" };
export type WorkspaceDocumentNode = WorkspaceRoomNode & {
  type: "document";
  sha256: string;
  textLength: number;
};
export type WorkspaceNode = WorkspaceFolderNode | WorkspaceDocumentNode;

export type WorkspaceRoomState = {
  roomId: string;
  mode: "workspace";
  version: number;
  rootId: string;
  nodes: WorkspaceNode[];
  activeDocumentId?: string;
};

export type WorkspaceChange =
  | {
      type: "document.patch";
      documentId: string;
      baseSha256: string;
      patches: TextPatch[];
    }
  | {
      type: "document.create";
      parentId: string | null;
      title: string;
      markdown: string;
    }
  | {
      type: "document.rename";
      documentId: string;
      title: string;
    }
  | {
      type: "document.move";
      documentId: string;
      parentId: string | null;
    }
  | {
      type: "document.delete";
      documentId: string;
      baseSha256?: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isTextPatch = (value: unknown): value is TextPatch =>
  isRecord(value) &&
  Number.isInteger(value.from) &&
  Number.isInteger(value.to) &&
  typeof value.from === "number" &&
  typeof value.to === "number" &&
  value.from >= 0 &&
  value.to >= value.from &&
  typeof value.insert === "string";

export const isWorkspaceChange = (value: unknown): value is WorkspaceChange => {
  if (!isRecord(value)) return false;
  if (value.type === "document.patch") {
    return typeof value.documentId === "string" &&
      typeof value.baseSha256 === "string" &&
      Array.isArray(value.patches) &&
      value.patches.every(isTextPatch);
  }
  if (value.type === "document.create") {
    return (value.parentId === null || typeof value.parentId === "string") &&
      typeof value.title === "string" &&
      typeof value.markdown === "string";
  }
  if (value.type === "document.rename") {
    return typeof value.documentId === "string" && typeof value.title === "string";
  }
  if (value.type === "document.move") {
    return typeof value.documentId === "string" &&
      (value.parentId === null || typeof value.parentId === "string");
  }
  return value.type === "document.delete" &&
    typeof value.documentId === "string" &&
    (value.baseSha256 === undefined || typeof value.baseSha256 === "string");
};
