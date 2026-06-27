import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TabulaMcpError } from "../protocol.js";
import {
  maxDocumentBytes,
  maxDocumentTitleLength,
  type StoredDocument,
} from "./schema.js";

export interface DocumentStore {
  latestDocumentId(): string | null;
  list(): StoredDocument[];
  get(documentId: string): StoredDocument | null;
  set(document: StoredDocument): void;
  clear(): void;
}

type DocumentStoreFile = {
  version: 1;
  latestDocumentId: string | null;
  documents: StoredDocument[];
};

export type FileDocumentStoreOptions = {
  directory: string;
  maxDocuments?: number;
};

export type DefaultDocumentStoreConfig = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
};

export const defaultMaxStoredDocuments = 20;

const documentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const storeFilename = "documents-v1.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTruthy = (value: string | undefined) =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const utf8ByteLength = (text: string) => Buffer.byteLength(text, "utf8");

const normalizeDocument = (value: unknown): StoredDocument | null => {
  if (!isRecord(value)) {
    return null;
  }

  const documentId = value.documentId;
  const title = value.title;
  const markdown = value.markdown;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;

  if (
    typeof documentId !== "string" ||
    !documentIdPattern.test(documentId) ||
    typeof markdown !== "string" ||
    utf8ByteLength(markdown) > maxDocumentBytes ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  const normalizedTitle = typeof title === "string" && title.trim() ? title.trim() : "Untitled Document";

  return {
    documentId,
    title: normalizedTitle.slice(0, maxDocumentTitleLength),
    markdown,
    createdAt,
    updatedAt,
  };
};

const sortedRecentDocuments = (documents: Iterable<StoredDocument>, maxDocuments: number) =>
  [...documents]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxDocuments);

const normalizeStoreFile = (value: unknown, maxDocuments: number): DocumentStoreFile => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.documents)) {
    return {
      version: 1,
      latestDocumentId: null,
      documents: [],
    };
  }

  const documents = sortedRecentDocuments(
    value.documents.map(normalizeDocument).filter((document): document is StoredDocument => document !== null),
    maxDocuments,
  );
  const documentIds = new Set(documents.map((document) => document.documentId));
  const latestDocumentId =
    typeof value.latestDocumentId === "string" && documentIds.has(value.latestDocumentId)
      ? value.latestDocumentId
      : documents[0]?.documentId ?? null;

  return {
    version: 1,
    latestDocumentId,
    documents,
  };
};

export const resolveDefaultDocumentStoreDirectory = ({
  env = process.env,
  platform = process.platform,
  homedir: home = homedir(),
}: DefaultDocumentStoreConfig = {}) => {
  const configuredDirectory = env.TABULA_MCP_DOCUMENT_STORE_DIR?.trim();
  if (configuredDirectory) {
    return path.resolve(configuredDirectory);
  }

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Tabula.md MCP", "documents");
  }

  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Tabula.md MCP", "documents");
  }

  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "tabula-mcp", "documents");
};

export class MemoryDocumentStore implements DocumentStore {
  readonly #documents = new Map<string, StoredDocument>();
  #latestDocumentId: string | null = null;

  latestDocumentId() {
    return this.#latestDocumentId;
  }

  list() {
    return sortedRecentDocuments(this.#documents.values(), this.#documents.size);
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

export class FileDocumentStore implements DocumentStore {
  readonly #documents = new Map<string, StoredDocument>();
  readonly #directory: string;
  readonly #filePath: string;
  readonly #maxDocuments: number;
  #latestDocumentId: string | null = null;

  constructor({ directory, maxDocuments = defaultMaxStoredDocuments }: FileDocumentStoreOptions) {
    this.#directory = directory;
    this.#filePath = path.join(directory, storeFilename);
    this.#maxDocuments = maxDocuments;
    this.#load();
  }

  latestDocumentId() {
    return this.#latestDocumentId;
  }

  list() {
    return sortedRecentDocuments(this.#documents.values(), this.#maxDocuments);
  }

  get(documentId: string) {
    return this.#documents.get(documentId) ?? null;
  }

  set(document: StoredDocument) {
    this.#documents.set(document.documentId, document);
    this.#latestDocumentId = document.documentId;
    this.#prune();
    this.#persist();
  }

  clear() {
    this.#documents.clear();
    this.#latestDocumentId = null;
    try {
      rmSync(this.#filePath, { force: true });
    } catch {
      // Ignore checkpoint cleanup failures; clear must still drop in-memory state.
    }
  }

  #load() {
    if (!existsSync(this.#filePath)) {
      return;
    }

    try {
      const storeFile = normalizeStoreFile(JSON.parse(readFileSync(this.#filePath, "utf8")), this.#maxDocuments);
      this.#documents.clear();
      for (const document of storeFile.documents) {
        this.#documents.set(document.documentId, document);
      }
      this.#latestDocumentId = storeFile.latestDocumentId;
    } catch {
      this.#documents.clear();
      this.#latestDocumentId = null;
    }
  }

  #prune() {
    const keptDocuments = sortedRecentDocuments(this.#documents.values(), this.#maxDocuments);
    const keptDocumentIds = new Set(keptDocuments.map((document) => document.documentId));

    for (const documentId of this.#documents.keys()) {
      if (!keptDocumentIds.has(documentId)) {
        this.#documents.delete(documentId);
      }
    }

    if (this.#latestDocumentId && !keptDocumentIds.has(this.#latestDocumentId)) {
      this.#latestDocumentId = keptDocuments[0]?.documentId ?? null;
    }
  }

  #persist() {
    const storeFile: DocumentStoreFile = {
      version: 1,
      latestDocumentId: this.#latestDocumentId,
      documents: sortedRecentDocuments(this.#documents.values(), this.#maxDocuments),
    };
    const tmpPath = path.join(this.#directory, `${storeFilename}.${randomUUID()}.tmp`);

    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      writeFileSync(tmpPath, `${JSON.stringify(storeFile, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmpPath, this.#filePath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Ignore temp-file cleanup failures.
      }
    }
  }
}

export const createDefaultDocumentStore = (config: DefaultDocumentStoreConfig = {}): DocumentStore => {
  const env = config.env ?? process.env;

  if (isTruthy(env.TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS)) {
    return new MemoryDocumentStore();
  }

  return new FileDocumentStore({
    directory: resolveDefaultDocumentStoreDirectory({ ...config, env }),
  });
};

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
