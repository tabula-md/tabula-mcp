#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTabulaMcpServer, type TabulaMcpServerInstance } from "./server/create-server.js";
import { createTabulaMcpHttpServer, type TabulaMcpHttpServer } from "./server/http.js";

export type CliTransportMode = "stdio" | "http";

export type CliOptions = {
  host?: string;
  mode: CliTransportMode;
  port?: number;
};

const positiveIntegerArg = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const parseCliOptions = (argv: readonly string[] = process.argv.slice(2)): CliOptions => {
  const options: CliOptions = {
    mode: argv.includes("--http") ? "http" : "stdio",
  };

  if (argv.includes("--stdio")) {
    options.mode = "stdio";
  }

  const portIndex = argv.indexOf("--port");
  const inlinePort = argv.find((argument) => argument.startsWith("--port="))?.slice("--port=".length);
  options.port = positiveIntegerArg(inlinePort ?? (portIndex >= 0 ? argv[portIndex + 1] : undefined));

  const hostIndex = argv.indexOf("--host");
  const inlineHost = argv.find((argument) => argument.startsWith("--host="))?.slice("--host=".length);
  options.host = inlineHost ?? (hostIndex >= 0 ? argv[hostIndex + 1] : undefined);

  return options;
};

export const runStdioServer = async () => {
  const instance = createTabulaMcpServer();
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);
  return instance;
};

export const runHttpServer = async ({ host, port }: Pick<CliOptions, "host" | "port"> = {}) => {
  const httpServer = createTabulaMcpHttpServer({ host, port });
  await httpServer.listen();
  console.error(
    `Tabula MCP HTTP server listening on http://${httpServer.host}:${httpServer.port}/mcp (${httpServer.deploymentMode}, ${httpServer.documentStoreKind})`,
  );
  return httpServer;
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
  let httpServer: TabulaMcpHttpServer | null = null;
  const options = parseCliOptions();

  (options.mode === "http" ? runHttpServer(options) : runStdioServer())
    .then((started) => {
      if ("server" in started && "registry" in started) {
        instance = started;
      } else {
        httpServer = started;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Fatal Tabula MCP error.");
      instance?.registry.clear();
      void instance?.documents.clear();
      void httpServer?.close();
      process.exit(1);
    });
};

if (isDirectRun(import.meta.url)) {
  runCli();
}
