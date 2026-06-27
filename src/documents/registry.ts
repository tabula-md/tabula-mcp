import { randomUUID } from "node:crypto";
import {
  assertMarkdownSize,
  createDocumentSnapshot,
  inferDocumentTitle,
} from "./snapshot.js";
import { MemoryDocumentStore, requireStoredDocument, type DocumentStore } from "./store.js";

export class DocumentRegistry {
  readonly #store: DocumentStore;

  constructor(store: DocumentStore = new MemoryDocumentStore()) {
    this.#store = store;
  }

  async create({ title, markdown = "" }: { title?: string; markdown?: string }) {
    assertMarkdownSize(markdown);

    const createdAt = new Date().toISOString();
    const document = {
      documentId: randomUUID(),
      title: inferDocumentTitle(title, markdown),
      markdown,
      createdAt,
      updatedAt: createdAt,
    };

    this.#store.set(document);

    return createDocumentSnapshot(document);
  }

  async get(documentId?: string) {
    return createDocumentSnapshot(requireStoredDocument(this.#store, documentId));
  }

  async update({ documentId, title, markdown }: { documentId: string; title?: string; markdown: string }) {
    assertMarkdownSize(markdown);

    const document = requireStoredDocument(this.#store, documentId);
    const updatedDocument = {
      ...document,
      title: title ? inferDocumentTitle(title, markdown) : document.title,
      markdown,
      updatedAt: new Date().toISOString(),
    };

    this.#store.set(updatedDocument);

    return createDocumentSnapshot(updatedDocument);
  }

  clear() {
    this.#store.clear();
  }
}
