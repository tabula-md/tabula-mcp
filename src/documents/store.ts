import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isTruthyEnvValue, positiveIntegerFromEnv, resolveProductionMode } from "../env.js";
import { TabulaMcpError } from "../protocol.js";
import {
  maxDocumentBytes,
  maxDocumentTitleLength,
  type StoredDocument,
} from "./schema.js";

type MaybePromise<T> = T | Promise<T>;

export type DocumentStoreKind = "file" | "memory" | "upstash-redis";
export type DocumentStoreDeploymentMode = "local" | "remote";

export interface DocumentStore {
  readonly kind: DocumentStoreKind;
  checkReady?(): MaybePromise<void>;
  latestDocumentId(): MaybePromise<string | null>;
  list(): MaybePromise<StoredDocument[]>;
  get(documentId: string): MaybePromise<StoredDocument | null>;
  set(document: StoredDocument): MaybePromise<void>;
  clear(): MaybePromise<void>;
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

export type MemoryDocumentStoreOptions = {
  maxDocuments?: number;
  ttlMs?: number;
  now?: () => number;
};

export type UpstashRedisDocumentStoreOptions = {
  restUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  keyPrefix?: string;
  maxDocuments?: number;
  ttlSeconds?: number;
};

export type DefaultDocumentStoreConfig = {
  env?: NodeJS.ProcessEnv;
  deploymentMode?: DocumentStoreDeploymentMode;
  defaultDeploymentMode?: DocumentStoreDeploymentMode;
  platform?: NodeJS.Platform;
  homedir?: string;
  fetchImpl?: typeof fetch;
  production?: boolean;
  pathExists?: (candidate: string) => boolean;
};

export const defaultMaxStoredDocuments = 20;
export const defaultRemoteDocumentTtlSeconds = 30 * 24 * 60 * 60;

const documentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const storeFilename = "documents-v1.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8ByteLength = (text: string) => Buffer.byteLength(text, "utf8");

export const normalizeStoredDocument = (value: unknown): StoredDocument | null => {
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
    value.documents.map(normalizeStoredDocument).filter((document): document is StoredDocument => document !== null),
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
  pathExists = existsSync,
}: DefaultDocumentStoreConfig = {}) => {
  const configuredDirectory = env.TABULA_MCP_DOCUMENT_STORE_DIR?.trim();
  if (configuredDirectory) {
    return path.resolve(configuredDirectory);
  }

  if (platform === "darwin") {
    const parent = path.join(home, "Library", "Application Support");
    const directory = path.join(parent, "Tabula MCP", "documents");
    const legacyDirectory = path.join(parent, "Tabula.md MCP", "documents");
    return !pathExists(directory) && pathExists(legacyDirectory) ? legacyDirectory : directory;
  }

  if (platform === "win32") {
    const parent = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const directory = path.join(parent, "Tabula MCP", "documents");
    const legacyDirectory = path.join(parent, "Tabula.md MCP", "documents");
    return !pathExists(directory) && pathExists(legacyDirectory) ? legacyDirectory : directory;
  }

  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "tabula-mcp", "documents");
};

export const resolveDocumentStoreDeploymentMode = ({
  env = process.env,
  deploymentMode,
  defaultDeploymentMode = "local",
}: Pick<DefaultDocumentStoreConfig, "env" | "deploymentMode" | "defaultDeploymentMode"> = {}): DocumentStoreDeploymentMode => {
  if (deploymentMode) {
    return deploymentMode;
  }

  const configuredMode = env.TABULA_MCP_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (configuredMode === "local" || configuredMode === "remote") {
    return configuredMode;
  }

  if (isTruthyEnvValue(env.TABULA_MCP_REMOTE)) {
    return "remote";
  }

  return defaultDeploymentMode;
};

export class MemoryDocumentStore implements DocumentStore {
  readonly kind = "memory" as const;
  readonly #documents = new Map<string, { document: StoredDocument; expiresAt: number | null }>();
  readonly #maxDocuments: number;
  readonly #ttlMs: number | null;
  readonly #now: () => number;
  #latestDocumentId: string | null = null;

  constructor({ maxDocuments = defaultMaxStoredDocuments, ttlMs, now = Date.now }: MemoryDocumentStoreOptions = {}) {
    this.#maxDocuments = maxDocuments;
    this.#ttlMs = ttlMs && ttlMs > 0 ? ttlMs : null;
    this.#now = now;
  }

  checkReady() {
    this.#pruneExpired();
  }

  latestDocumentId() {
    this.#pruneExpired();
    if (this.#latestDocumentId && this.#documents.has(this.#latestDocumentId)) {
      return this.#latestDocumentId;
    }
    this.#latestDocumentId = this.list()[0]?.documentId ?? null;
    return this.#latestDocumentId;
  }

  list() {
    this.#pruneExpired();
    return sortedRecentDocuments(
      [...this.#documents.values()].map((entry) => entry.document),
      this.#maxDocuments,
    );
  }

  get(documentId: string) {
    this.#pruneExpired();
    return this.#documents.get(documentId)?.document ?? null;
  }

  set(document: StoredDocument) {
    this.#documents.set(document.documentId, {
      document,
      expiresAt: this.#ttlMs === null ? null : this.#now() + this.#ttlMs,
    });
    this.#latestDocumentId = document.documentId;
    this.#prune();
  }

  clear() {
    this.#documents.clear();
    this.#latestDocumentId = null;
  }

  #pruneExpired() {
    const now = this.#now();
    for (const [documentId, entry] of this.#documents.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.#documents.delete(documentId);
      }
    }
    if (this.#latestDocumentId && !this.#documents.has(this.#latestDocumentId)) {
      this.#latestDocumentId = null;
    }
  }

  #prune() {
    this.#pruneExpired();
    const keptDocumentIds = new Set(this.list().map((document) => document.documentId));
    for (const documentId of this.#documents.keys()) {
      if (!keptDocumentIds.has(documentId)) {
        this.#documents.delete(documentId);
      }
    }
  }
}

export class FileDocumentStore implements DocumentStore {
  readonly kind = "file" as const;
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

  checkReady() {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
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

type UpstashResponse = {
  result?: unknown;
  error?: string;
};

const normalizeRedisRestUrl = (url: string) => url.trim().replace(/\/+$/, "");

const parseUpstashJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TabulaMcpError(
      `Remote Tabula MCP document checkpoint store returned a non-JSON response (${response.status} ${response.statusText}).`,
    );
  }
};

const parseStoredDocumentJson = (value: unknown): StoredDocument | null => {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return normalizeStoredDocument(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

export class UpstashRedisDocumentStore implements DocumentStore {
  readonly kind = "upstash-redis" as const;
  readonly #restUrl: string;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;
  readonly #keyPrefix: string;
  readonly #maxDocuments: number;
  readonly #ttlSeconds: number;

  constructor({
    restUrl,
    token,
    fetchImpl = fetch,
    keyPrefix = "tabula-mcp:documents",
    maxDocuments = defaultMaxStoredDocuments,
    ttlSeconds = defaultRemoteDocumentTtlSeconds,
  }: UpstashRedisDocumentStoreOptions) {
    this.#restUrl = normalizeRedisRestUrl(restUrl);
    this.#token = token;
    this.#fetchImpl = fetchImpl;
    this.#keyPrefix = keyPrefix.replace(/:+$/, "");
    this.#maxDocuments = maxDocuments;
    this.#ttlSeconds = ttlSeconds;
  }

  async latestDocumentId() {
    const latest = await this.#command(["GET", this.#latestKey()]);
    if (typeof latest === "string" && documentIdPattern.test(latest) && (await this.get(latest))) {
      return latest;
    }

    return (await this.list())[0]?.documentId ?? null;
  }

  async checkReady() {
    await this.#command(["PING"]);
  }

  async list() {
    const documentIds = await this.#command(["ZREVRANGE", this.#indexKey(), 0, this.#maxDocuments - 1]);
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return [];
    }

    const validDocumentIds = documentIds.filter(
      (documentId): documentId is string => typeof documentId === "string" && documentIdPattern.test(documentId),
    );
    if (validDocumentIds.length === 0) {
      return [];
    }

    const responses = await this.#pipeline(validDocumentIds.map((documentId) => ["GET", this.#documentKey(documentId)]));
    return sortedRecentDocuments(
      responses.map((response) => parseStoredDocumentJson(response.result)).filter((document): document is StoredDocument => document !== null),
      this.#maxDocuments,
    );
  }

  async get(documentId: string) {
    const value = await this.#command(["GET", this.#documentKey(documentId)]);
    return parseStoredDocumentJson(value);
  }

  async set(document: StoredDocument) {
    const updatedAtMs = Date.parse(document.updatedAt);
    const score = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
    await this.#pipeline([
      ["SET", this.#documentKey(document.documentId), JSON.stringify(document), "EX", this.#ttlSeconds],
      ["SET", this.#latestKey(), document.documentId, "EX", this.#ttlSeconds],
      ["ZADD", this.#indexKey(), score, document.documentId],
      ["EXPIRE", this.#indexKey(), this.#ttlSeconds],
      ["ZREMRANGEBYRANK", this.#indexKey(), 0, -this.#maxDocuments - 1],
    ]);
  }

  async clear() {
    const documentIds = await this.#command(["ZREVRANGE", this.#indexKey(), 0, -1]);
    const deleteKeys = [
      this.#latestKey(),
      this.#indexKey(),
      ...(Array.isArray(documentIds)
        ? documentIds
            .filter((documentId): documentId is string => typeof documentId === "string" && documentIdPattern.test(documentId))
            .map((documentId) => this.#documentKey(documentId))
        : []),
    ];

    if (deleteKeys.length > 0) {
      await this.#command(["DEL", ...deleteKeys]);
    }
  }

  #documentKey(documentId: string) {
    return `${this.#keyPrefix}:doc:${documentId}`;
  }

  #indexKey() {
    return `${this.#keyPrefix}:updated`;
  }

  #latestKey() {
    return `${this.#keyPrefix}:latest`;
  }

  async #command(command: readonly unknown[]) {
    return (await this.#request(command)).result;
  }

  async #pipeline(commands: readonly (readonly unknown[])[]) {
    const response = await this.#fetchImpl.call(globalThis, `${this.#restUrl}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    const parsed = await parseUpstashJson<unknown>(response);
    if (!response.ok || !Array.isArray(parsed)) {
      throw new TabulaMcpError(
        `Remote Tabula MCP document checkpoint store request failed (${response.status} ${response.statusText}).`,
      );
    }

    const failures = parsed.filter((entry): entry is { error: string } => isRecord(entry) && typeof entry.error === "string");
    if (failures.length > 0) {
      throw new TabulaMcpError(`Remote Tabula MCP document checkpoint store failed: ${failures[0]?.error ?? "Unknown error"}`);
    }

    return parsed.filter(isRecord) as UpstashResponse[];
  }

  async #request(command: readonly unknown[]) {
    const response = await this.#fetchImpl.call(globalThis, this.#restUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    const parsed = await parseUpstashJson<UpstashResponse>(response);

    if (!response.ok || parsed.error) {
      throw new TabulaMcpError(
        `Remote Tabula MCP document checkpoint store failed (${response.status} ${response.statusText}): ${parsed.error ?? "Unknown error"}`,
      );
    }

    return parsed;
  }
}

const resolveUpstashRedisConfig = (env: NodeJS.ProcessEnv) => {
  const restUrl =
    env.TABULA_MCP_REDIS_REST_URL?.trim() ||
    env.UPSTASH_REDIS_REST_URL?.trim() ||
    env.KV_REST_API_URL?.trim();
  const token =
    env.TABULA_MCP_REDIS_REST_TOKEN?.trim() ||
    env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
    env.KV_REST_API_TOKEN?.trim();

  return restUrl && token ? { restUrl, token } : null;
};

export const createDefaultDocumentStore = (config: DefaultDocumentStoreConfig = {}): DocumentStore => {
  const env = config.env ?? process.env;
  const deploymentMode = resolveDocumentStoreDeploymentMode(config);
  const maxDocuments = positiveIntegerFromEnv(env.TABULA_MCP_MAX_DOCUMENT_CHECKPOINTS, defaultMaxStoredDocuments);
  const requestedDriver = env.TABULA_MCP_DOCUMENT_STORE_DRIVER?.trim().toLowerCase();
  const production = resolveProductionMode({ env, production: config.production });
  const allowProductionMemoryStore = isTruthyEnvValue(env.TABULA_MCP_ALLOW_MEMORY_STORE);
  const publicUnauthenticated =
    deploymentMode === "remote" && production && isTruthyEnvValue(env.TABULA_MCP_PUBLIC_UNAUTHENTICATED);

  if (deploymentMode === "remote") {
    if (requestedDriver && !["memory", "redis", "upstash-redis"].includes(requestedDriver)) {
      throw new TabulaMcpError("Remote Tabula MCP document store driver must be memory or redis.");
    }

    if (publicUnauthenticated && requestedDriver === "memory") {
      throw new TabulaMcpError("Public unauthenticated production Tabula MCP requires Redis checkpoints.");
    }

    if (production && requestedDriver === "memory" && !allowProductionMemoryStore) {
      throw new TabulaMcpError(
        "Production remote Tabula MCP requires Redis unless TABULA_MCP_ALLOW_MEMORY_STORE=1 is explicitly set.",
      );
    }

    const redisConfig = requestedDriver === "memory" ? null : resolveUpstashRedisConfig(env);
    if (redisConfig) {
      return new UpstashRedisDocumentStore({
        ...redisConfig,
        fetchImpl: config.fetchImpl,
        keyPrefix: env.TABULA_MCP_REDIS_KEY_PREFIX?.trim() || undefined,
        maxDocuments,
        ttlSeconds: positiveIntegerFromEnv(env.TABULA_MCP_DOCUMENT_TTL_SECONDS, defaultRemoteDocumentTtlSeconds),
      });
    }

    if (publicUnauthenticated) {
      throw new TabulaMcpError(
        "Public unauthenticated production Tabula MCP requires TABULA_MCP_REDIS_REST_URL/UPSTASH_REDIS_REST_URL and a matching REST token.",
      );
    }

    if (production && !(requestedDriver === "memory" && allowProductionMemoryStore)) {
      throw new TabulaMcpError(
        "Production remote Tabula MCP requires TABULA_MCP_REDIS_REST_URL/UPSTASH_REDIS_REST_URL and a matching REST token, or explicit TABULA_MCP_DOCUMENT_STORE_DRIVER=memory with TABULA_MCP_ALLOW_MEMORY_STORE=1.",
      );
    }

    return new MemoryDocumentStore({
      maxDocuments,
      ttlMs: positiveIntegerFromEnv(env.TABULA_MCP_DOCUMENT_TTL_SECONDS, defaultRemoteDocumentTtlSeconds) * 1000,
    });
  }

  if (isTruthyEnvValue(env.TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS)) {
    return new MemoryDocumentStore({ maxDocuments });
  }

  return new FileDocumentStore({
    directory: resolveDefaultDocumentStoreDirectory({ ...config, env }),
    maxDocuments,
  });
};

export const checkDocumentStoreReadiness = async (store: DocumentStore) => {
  if (store.checkReady) {
    await store.checkReady();
    return;
  }

  await store.list();
};

export const requireStoredDocument = async (store: DocumentStore, documentId?: string) => {
  const resolvedDocumentId = documentId ?? (await store.latestDocumentId());
  if (!resolvedDocumentId) {
    throw new TabulaMcpError("Create a Tabula document before opening the Document App.");
  }

  const document = await store.get(resolvedDocumentId);
  if (!document) {
    throw new TabulaMcpError(`Unknown Tabula document: ${resolvedDocumentId}`);
  }

  return document;
};
