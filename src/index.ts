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

import { isDirectRun, runCli } from "./cli.js";

if (isDirectRun(import.meta.url)) {
  runCli();
}
