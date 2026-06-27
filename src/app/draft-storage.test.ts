import { describe, expect, it } from "vitest";
import {
  clearDocumentDraft,
  defaultMaxDraftEntries,
  documentDraftStorageKey,
  draftStorageIndexKey,
  loadDocumentDraft,
  readDraftIndex,
  saveDocumentDraft,
} from "./draft-storage.js";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}

const documentId = "123e4567-e89b-42d3-a456-426614174000";

describe("document draft storage", () => {
  it("uses document-id scoped keys and rejects invalid ids", () => {
    expect(documentDraftStorageKey(documentId)).toBe(`tabula.md:mcp:draft:v1:${documentId}`);
    expect(documentDraftStorageKey("not-a-document-id")).toBeNull();

    const storage = new MemoryStorage();
    const result = saveDocumentDraft(storage, {
      documentId: "not-a-document-id",
      markdown: "# Draft",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid-document-id");
  });

  it("saves, loads, and clears a document draft", () => {
    const storage = new MemoryStorage();
    const result = saveDocumentDraft(storage, {
      documentId,
      title: "Draft",
      markdown: "# Draft\n\nUnsaved body",
      baseSha256: "base-hash",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(loadDocumentDraft(storage, documentId)).toMatchObject({
      documentId,
      title: "Draft",
      markdown: "# Draft\n\nUnsaved body",
      baseSha256: "base-hash",
      textLength: "# Draft\n\nUnsaved body".length,
    });

    clearDocumentDraft(storage, documentId);

    expect(loadDocumentDraft(storage, documentId)).toBeNull();
    expect(readDraftIndex(storage)).toEqual([]);
  });

  it("rejects drafts over the configured size limit", () => {
    const storage = new MemoryStorage();
    const result = saveDocumentDraft(
      storage,
      {
        documentId,
        markdown: "abcdef",
      },
      { maxDraftBytes: 4 },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("draft-too-large");
    expect(loadDocumentDraft(storage, documentId)).toBeNull();
  });

  it("prunes the oldest draft entries", () => {
    const storage = new MemoryStorage();
    const ids = [
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
      "123e4567-e89b-42d3-a456-426614174003",
    ];

    for (const [index, id] of ids.entries()) {
      saveDocumentDraft(
        storage,
        {
          documentId: id,
          markdown: `Draft ${index}`,
          updatedAt: `2026-06-28T00:00:0${index}.000Z`,
        },
        { maxDraftEntries: 2 },
      );
    }

    expect(readDraftIndex(storage).map((item) => item.documentId)).toEqual([ids[2], ids[1]]);
    expect(loadDocumentDraft(storage, ids[0])).toBeNull();
    expect(loadDocumentDraft(storage, ids[1])?.markdown).toBe("Draft 1");
    expect(loadDocumentDraft(storage, ids[2])?.markdown).toBe("Draft 2");
    expect(readDraftIndex(storage).length).toBeLessThanOrEqual(defaultMaxDraftEntries);
  });

  it("drops corrupted draft records", () => {
    const storage = new MemoryStorage();
    const key = documentDraftStorageKey(documentId);
    if (!key) {
      throw new Error("Expected a valid draft storage key.");
    }

    storage.setItem(key, "{not-json");
    storage.setItem(draftStorageIndexKey, JSON.stringify([{ documentId, updatedAt: "2026-06-28T00:00:00.000Z" }]));

    expect(loadDocumentDraft(storage, documentId)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
    expect(readDraftIndex(storage)).toEqual([]);
  });
});
