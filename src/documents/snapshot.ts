import { sha256Text } from "../crypto.js";
import { TabulaMcpError } from "../protocol.js";
import { getMarkdownOutline } from "../text.js";
import {
  maxDocumentBytes,
  maxDocumentTitleLength,
  type StoredDocument,
  type TabulaDocumentSnapshot,
  type TabulaDocumentSummary,
} from "./schema.js";

export const assertMarkdownSize = (markdown: string) => {
  if (Buffer.byteLength(markdown, "utf8") > maxDocumentBytes) {
    throw new TabulaMcpError("Tabula document is too large for the local MCP App session.");
  }
};

const trimTitle = (title: string) => title.trim().slice(0, maxDocumentTitleLength);

export const inferDocumentTitle = (title: string | undefined, markdown: string) => {
  const explicitTitle = title ? trimTitle(title) : "";
  if (explicitTitle) {
    return explicitTitle;
  }

  const headingTitle = getMarkdownOutline(markdown).find((heading) => heading.depth === 1)?.text;
  return headingTitle ? trimTitle(headingTitle) : "Untitled Document";
};

export const createDocumentSnapshot = async (document: StoredDocument): Promise<TabulaDocumentSnapshot> => ({
  documentId: document.documentId,
  title: document.title,
  source: "local-document",
  status: "draft",
  textLength: document.markdown.length,
  sha256: await sha256Text(document.markdown),
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  outline: getMarkdownOutline(document.markdown),
  markdown: document.markdown,
});

export const summarizeDocument = (document: TabulaDocumentSnapshot): TabulaDocumentSummary => ({
  documentId: document.documentId,
  title: document.title,
  source: document.source,
  status: document.status,
  textLength: document.textLength,
  sha256: document.sha256,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  outlineCount: document.outline.length,
});
