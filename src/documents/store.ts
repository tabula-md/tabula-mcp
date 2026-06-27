import { TabulaMcpError } from "../protocol.js";
import type { StoredDocument } from "./schema.js";

export interface DocumentStore {
  latestDocumentId(): string | null;
  get(documentId: string): StoredDocument | null;
  set(document: StoredDocument): void;
  clear(): void;
}

export class MemoryDocumentStore implements DocumentStore {
  readonly #documents = new Map<string, StoredDocument>();
  #latestDocumentId: string | null = null;

  latestDocumentId() {
    return this.#latestDocumentId;
  }

  get(documentId: string) {
    return this.#documents.get(documentId) ?? null;
  }

  set(document: StoredDocument) {
    this.#documents.set(document.documentId, document);
    this.#latestDocumentId = document.documentId;
  }

  clear() {
    this.#documents.clear();
    this.#latestDocumentId = null;
  }
}

export const requireStoredDocument = (store: DocumentStore, documentId?: string) => {
  const resolvedDocumentId = documentId ?? store.latestDocumentId();
  if (!resolvedDocumentId) {
    throw new TabulaMcpError("Create a Tabula document before opening the Document App.");
  }

  const document = store.get(resolvedDocumentId);
  if (!document) {
    throw new TabulaMcpError(`Unknown Tabula document: ${resolvedDocumentId}`);
  }

  return document;
};
