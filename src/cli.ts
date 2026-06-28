#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTabulaMcpServer, type TabulaMcpServerInstance } from "./server/create-server.js";

export const runStdioServer = async () => {
  const instance = createTabulaMcpServer();
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);
  return instance;
};

const realpathFileUrl = (filePath: string) => pathToFileURL(realpathSync(filePath)).href;

export const isDirectRun = (importMetaUrl: string, argv: readonly string[] = process.argv) => {
  const entrypoint = argv[1];
  if (!entrypoint) {
    return false;
  }

  try {
    return realpathFileUrl(fileURLToPath(importMetaUrl)) === realpathFileUrl(entrypoint);
  } catch {
    return importMetaUrl === pathToFileURL(entrypoint).href;
  }
};

export const runCli = () => {
  let instance: TabulaMcpServerInstance | null = null;

  runStdioServer()
    .then((startedInstance) => {
      instance = startedInstance;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Fatal Tabula MCP error.");
      instance?.registry.clear();
      instance?.documents.clear();
      process.exit(1);
    });
};

if (isDirectRun(import.meta.url)) {
  runCli();
}
