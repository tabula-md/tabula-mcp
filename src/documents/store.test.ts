import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileDocumentStore,
  MemoryDocumentStore,
  createDefaultDocumentStore,
  resolveDefaultDocumentStoreDirectory,
} from "./store.js";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tabula-mcp-store-"));
  tempDirs.push(directory);
  return directory;
};

const storedDocument = (documentId: string, markdown: string, updatedAt = "2026-01-01T00:00:00.000Z") => ({
  documentId,
  title: "Draft",
  markdown,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FileDocumentStore", () => {
  it("persists documents and the latest document id across store instances", () => {
    const directory = createTempDir();
    const document = storedDocument("11111111-1111-4111-8111-111111111111", "# Draft\n\nBody");

    const firstStore = new FileDocumentStore({ directory });
    firstStore.set(document);

    const secondStore = new FileDocumentStore({ directory });

    expect(secondStore.latestDocumentId()).toBe(document.documentId);
    expect(secondStore.get(document.documentId)).toEqual(document);
  });

  it("prunes older checkpoints by updatedAt", () => {
    const directory = createTempDir();
    const store = new FileDocumentStore({ directory, maxDocuments: 2 });

    store.set(storedDocument("11111111-1111-4111-8111-111111111111", "one", "2026-01-01T00:00:00.000Z"));
    store.set(storedDocument("22222222-2222-4222-8222-222222222222", "two", "2026-01-02T00:00:00.000Z"));
    store.set(storedDocument("33333333-3333-4333-8333-333333333333", "three", "2026-01-03T00:00:00.000Z"));

    const restoredStore = new FileDocumentStore({ directory, maxDocuments: 2 });

    expect(restoredStore.get("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(restoredStore.get("22222222-2222-4222-8222-222222222222")?.markdown).toBe("two");
    expect(restoredStore.get("33333333-3333-4333-8333-333333333333")?.markdown).toBe("three");
  });

  it("ignores corrupted checkpoint files and starts empty", () => {
    const directory = createTempDir();
    const store = new FileDocumentStore({ directory });
    store.set(storedDocument("11111111-1111-4111-8111-111111111111", "valid"));
    writeFileSync(path.join(directory, "documents-v1.json"), "{not-json", "utf8");

    const emptyStore = new FileDocumentStore({ directory });

    expect(emptyStore.latestDocumentId()).toBeNull();
  });
});

describe("default document store", () => {
  it("uses a configured checkpoint directory when provided", () => {
    const directory = createTempDir();
    const store = createDefaultDocumentStore({
      env: {
        TABULA_MCP_DOCUMENT_STORE_DIR: directory,
      },
    });
    const document = storedDocument("11111111-1111-4111-8111-111111111111", "checkpoint");

    store.set(document);

    expect(new FileDocumentStore({ directory }).get(document.documentId)).toEqual(document);
  });

  it("can disable file checkpoints for memory-only sessions", () => {
    const store = createDefaultDocumentStore({
      env: {
        TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS: "1",
      },
    });

    expect(store).toBeInstanceOf(MemoryDocumentStore);
  });

  it("resolves stable platform-specific default directories", () => {
    expect(
      resolveDefaultDocumentStoreDirectory({
        env: {},
        platform: "darwin",
        homedir: "/Users/taeha",
      }),
    ).toBe("/Users/taeha/Library/Application Support/Tabula.md MCP/documents");
    expect(
      resolveDefaultDocumentStoreDirectory({
        env: { LOCALAPPDATA: "C:\\Users\\taeha\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\taeha",
      }),
    ).toContain("Tabula.md MCP");
    expect(
      resolveDefaultDocumentStoreDirectory({
        env: { XDG_STATE_HOME: "/home/taeha/.local/state" },
        platform: "linux",
        homedir: "/home/taeha",
      }),
    ).toBe("/home/taeha/.local/state/tabula-mcp/documents");
  });
});
