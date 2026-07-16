#!/usr/bin/env node

import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TabulaMcpServerInstance } from "./server/create-server.js";
import type { TabulaMcpHttpServer } from "./server/http.js";
import { TABULA_MCP_PRODUCT_DESCRIPTION } from "./public-copy.js";

export type CliTransportMode = "stdio" | "http";

export type CliOptions = {
  action: "doctor" | "help" | "serve" | "version";
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
    action: argv.includes("--help") || argv.includes("-h")
      ? "help"
      : argv.includes("--version") || argv.includes("-v")
        ? "version"
        : argv.includes("--doctor")
          ? "doctor"
          : "serve",
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

const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

export const getPackageVersion = () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "unknown";
};

export const CLI_HELP = `Tabula.md MCP

${TABULA_MCP_PRODUCT_DESCRIPTION}

Local stdio is the default. Use --http only for a trusted remote deployment.

Usage:
  tabula-mcp [--stdio]
  tabula-mcp --http [--host <host>] [--port <port>]
  tabula-mcp --doctor
  tabula-mcp --version

Install for Codex:
  codex mcp add tabula -- npx -y @tabula-md/mcp@latest

Install for Claude Code:
  claude mcp add tabula -- npx -y @tabula-md/mcp@latest

Options:
  --stdio          Run the local stdio MCP server (default for MCP clients)
  --http           Run a Streamable HTTP MCP server
  --host <host>    HTTP listen host
  --port <port>    HTTP listen port
  --enable-write   Compatibility alias; writes are enabled by default
  --read-only      Disable writes to live session files
  --doctor         Check the local runtime without printing secrets
  -h, --help       Show this help
  -v, --version    Show the package version

Room URLs contain bearer secrets. Pass them through MCP tool calls, not CLI arguments.`;

export type DoctorCheck = {
  detail: string;
  label: string;
  status: "pass" | "warn";
};

const nodeVersionSupported = () => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
};

export const collectDoctorChecks = (): DoctorCheck[] => {
  const checks: DoctorCheck[] = [
    {
      label: "Node.js",
      status: nodeVersionSupported() ? "pass" : "warn",
      detail: `${process.versions.node} (requires ^20.19.0 or >=22.12.0)`,
    },
    {
      label: "Package",
      status: "pass",
      detail: `@tabula-md/mcp ${getPackageVersion()}`,
    },
    {
      label: "Default transport",
      status: "pass",
      detail: "local stdio; room keys and decrypted Markdown stay in this MCP process",
    },
  ];

  const configuredStore = process.env.TABULA_MCP_DOCUMENT_STORE_DIR?.trim();
  if (configuredStore) {
    try {
      accessSync(configuredStore, constants.R_OK | constants.W_OK);
      checks.push({ label: "Document store", status: "pass", detail: "configured directory is readable and writable" });
    } catch {
      checks.push({ label: "Document store", status: "warn", detail: "configured directory is not readable and writable" });
    }
  } else {
    checks.push({ label: "Document store", status: "pass", detail: "using the platform-local default" });
  }

  checks.push({
    label: "Room writes",
    status: "pass",
    detail: "file replacements are revision-guarded; mutating calls remain visible to the MCP host",
  });
  return checks;
};

export const formatDoctorReport = (checks = collectDoctorChecks()) => [
  `Tabula MCP ${getPackageVersion()} doctor`,
  "",
  ...checks.map((check) => `${check.status === "pass" ? "PASS" : "WARN"}  ${check.label}: ${check.detail}`),
  "",
  "No room URLs, keys, Markdown, tokens, or share links were inspected or printed.",
].join("\n");

export const runStdioServer = async () => {
  const [{ StdioServerTransport }, { createTabulaMcpServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./server/create-server.js"),
  ]);
  const instance = createTabulaMcpServer();
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);
  return instance;
};

export const runHttpServer = async ({ host, port }: Pick<CliOptions, "host" | "port"> = {}) => {
  const { createTabulaMcpHttpServer } = await import("./server/http.js");
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

export const runCli = (
  argv: readonly string[] = process.argv.slice(2),
  stdinIsTty = Boolean(process.stdin.isTTY),
) => {
  let instance: TabulaMcpServerInstance | null = null;
  let httpServer: TabulaMcpHttpServer | null = null;
  const options = parseCliOptions(argv);

  if (options.action === "help" || (options.action === "serve" && argv.length === 0 && stdinIsTty)) {
    console.log(CLI_HELP);
    return;
  }
  if (options.action === "version") {
    console.log(getPackageVersion());
    return;
  }
  if (options.action === "doctor") {
    console.log(formatDoctorReport());
    return;
  }

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
