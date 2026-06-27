#!/usr/bin/env node

export {
  createTabulaMcpServer,
  type TabulaMcpServerInstance,
  type TabulaMcpServerOptions,
  resolveWriteEnabled,
  type WriteAccessConfig,
} from "./server/index.js";
export {
  FileDocumentStore,
  MemoryDocumentStore,
  createDefaultDocumentStore,
  defaultMaxStoredDocuments,
  resolveDefaultDocumentStoreDirectory,
  DocumentRegistry,
  assertMarkdownSize,
  createDocumentSnapshot,
  inferDocumentTitle,
  summarizeDocument,
} from "./documents/index.js";
export type {
  DefaultDocumentStoreConfig,
  DocumentStore,
  FileDocumentStoreOptions,
  StoredDocument,
  TabulaDocumentSnapshot,
  TabulaDocumentSummary,
} from "./documents/index.js";

import { isDirectRun, runCli } from "./cli.js";

if (isDirectRun(import.meta.url)) {
  runCli();
}
