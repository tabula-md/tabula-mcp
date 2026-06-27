import type { MarkdownHeading } from "../text.js";

export const maxDocumentBytes = 5 * 1024 * 1024;
export const maxDocumentTitleLength = 120;

export type StoredDocument = {
  documentId: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
};

export type TabulaDocumentSnapshot = {
  documentId: string;
  title: string;
  source: "local-document";
  status: "draft";
  textLength: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  outline: MarkdownHeading[];
  markdown: string;
};

export type TabulaDocumentSummary = Omit<TabulaDocumentSnapshot, "markdown" | "outline"> & {
  outlineCount: number;
};
