import { randomUUID } from "node:crypto";
import {
  assertMarkdownSize,
  createDocumentSnapshot,
  inferDocumentTitle,
  summarizeDocument,
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

    await this.#store.set(document);

    return createDocumentSnapshot(document);
  }

  async get(documentId?: string) {
    return createDocumentSnapshot(await requireStoredDocument(this.#store, documentId));
  }

  async list() {
    const snapshots = await Promise.all((await this.#store.list()).map(createDocumentSnapshot));
    return snapshots.map(summarizeDocument);
  }

  async update({ documentId, title, markdown }: { documentId: string; title?: string; markdown: string }) {
    assertMarkdownSize(markdown);

    const document = await requireStoredDocument(this.#store, documentId);
    const updatedDocument = {
      ...document,
      title: title ? inferDocumentTitle(title, markdown) : document.title,
      markdown,
      updatedAt: new Date().toISOString(),
    };

    await this.#store.set(updatedDocument);

    return createDocumentSnapshot(updatedDocument);
  }

  async clear() {
    await this.#store.clear();
  }
}
