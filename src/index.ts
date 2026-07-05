#!/usr/bin/env node

export {
  createTabulaMcpServer,
  createTabulaMcpHttpServer,
  createTabulaMcpWebHandler,
  resolveHttpServerOptions,
  type TabulaMcpServerInstance,
  type TabulaMcpServerOptions,
  type TabulaMcpHttpServer,
  type TabulaMcpHttpServerOptions,
  type TabulaMcpWebHandler,
  type TabulaMcpWebHandlerOptions,
  type WebEnvironment,
  resolveWriteEnabled,
  type WriteAccessConfig,
} from "./server/index.js";
export {
  FileDocumentStore,
  MemoryDocumentStore,
  UpstashRedisDocumentStore,
  createDefaultDocumentStore,
  defaultRemoteDocumentTtlSeconds,
  defaultMaxStoredDocuments,
  normalizeStoredDocument,
  resolveDefaultDocumentStoreDirectory,
  resolveDocumentStoreDeploymentMode,
  DocumentRegistry,
  assertMarkdownSize,
  createDocumentSnapshot,
  inferDocumentTitle,
  summarizeDocument,
} from "./documents/index.js";
export type {
  DefaultDocumentStoreConfig,
  DocumentStore,
  DocumentStoreDeploymentMode,
  DocumentStoreKind,
  FileDocumentStoreOptions,
  MemoryDocumentStoreOptions,
  StoredDocument,
  TabulaDocumentSnapshot,
  TabulaDocumentSummary,
  UpstashRedisDocumentStoreOptions,
} from "./documents/index.js";

import { isDirectRun, runCli } from "./cli.js";

if (isDirectRun(import.meta.url)) {
  runCli();
}
