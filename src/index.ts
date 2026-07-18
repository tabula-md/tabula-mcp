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
export { resolveDeploymentMode, type DeploymentMode } from "./deployment.js";
export { assertMarkdownSize, maxMarkdownFileBytes } from "./markdown-limits.js";
export { openFolderSyncSession, syncFolderOnce, type FolderSyncSession } from "./sync-service.js";
export { planFolderSync, type SyncConflict, type SyncFile, type SyncPlan, type SyncStateFile } from "./sync-model.js";

import { isDirectRun, runCli } from "./cli.js";

if (isDirectRun(import.meta.url)) {
  runCli();
}
