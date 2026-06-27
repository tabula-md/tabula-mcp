#!/usr/bin/env node

export { createTabulaMcpServer } from "./server/create-server.js";
export type { TabulaMcpServerInstance, TabulaMcpServerOptions } from "./server/create-server.js";
export {
  FileDocumentStore,
  MemoryDocumentStore,
  createDefaultDocumentStore,
  resolveDefaultDocumentStoreDirectory,
} from "./documents/store.js";
export type {
  DefaultDocumentStoreConfig,
  DocumentStore,
  FileDocumentStoreOptions,
} from "./documents/store.js";
export { resolveWriteEnabled } from "./server/write-access.js";
export type { WriteAccessConfig } from "./server/write-access.js";

import { isDirectRun, runCli } from "./cli.js";

if (isDirectRun(import.meta.url)) {
  runCli();
}
