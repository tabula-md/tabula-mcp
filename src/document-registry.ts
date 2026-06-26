import { randomUUID } from "node:crypto";
import { sha256Text } from "./crypto.js";
import { TabulaMcpError } from "./protocol.js";
import { getMarkdownOutline, type MarkdownHeading } from "./text.js";

const maxDocumentBytes = 5 * 1024 * 1024;
const maxTitleLength = 120;

type StoredDocument = {
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

const assertMarkdownSize = (markdown: string) => {
  if (Buffer.byteLength(markdown, "utf8") > maxDocumentBytes) {
    throw new TabulaMcpError("Tabula document is too large for the local MCP App session.");
  }
};

const trimTitle = (title: string) => title.trim().slice(0, maxTitleLength);

const inferTitle = (title: string | undefined, markdown: string) => {
  const explicitTitle = title ? trimTitle(title) : "";
  if (explicitTitle) {
    return explicitTitle;
  }

  const headingTitle = getMarkdownOutline(markdown).find((heading) => heading.depth === 1)?.text;
  return headingTitle ? trimTitle(headingTitle) : "Untitled Document";
};

const createSnapshot = async (document: StoredDocument): Promise<TabulaDocumentSnapshot> => ({
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

export class DocumentRegistry {
  readonly #documents = new Map<string, StoredDocument>();
  #latestDocumentId: string | null = null;

  async create({ title, markdown = "" }: { title?: string; markdown?: string }) {
    assertMarkdownSize(markdown);

    const createdAt = new Date().toISOString();
    const document: StoredDocument = {
      documentId: randomUUID(),
      title: inferTitle(title, markdown),
      markdown,
      createdAt,
      updatedAt: createdAt,
    };

    this.#documents.set(document.documentId, document);
    this.#latestDocumentId = document.documentId;

    return createSnapshot(document);
  }

  async get(documentId?: string) {
    const resolvedDocumentId = documentId ?? this.#latestDocumentId;
    if (!resolvedDocumentId) {
      throw new TabulaMcpError("Create a Tabula document before opening the Document App.");
    }

    const document = this.#documents.get(resolvedDocumentId);
    if (!document) {
      throw new TabulaMcpError(`Unknown Tabula document: ${resolvedDocumentId}`);
    }

    return createSnapshot(document);
  }

  async update({ documentId, title, markdown }: { documentId: string; title?: string; markdown: string }) {
    assertMarkdownSize(markdown);

    const document = this.#documents.get(documentId);
    if (!document) {
      throw new TabulaMcpError(`Unknown Tabula document: ${documentId}`);
    }

    document.title = title ? inferTitle(title, markdown) : document.title;
    document.markdown = markdown;
    document.updatedAt = new Date().toISOString();
    this.#latestDocumentId = document.documentId;

    return createSnapshot(document);
  }

  clear() {
    this.#documents.clear();
    this.#latestDocumentId = null;
  }
}
