import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeEnvironment } from "./env.js";
import { TabulaMcpError } from "./protocol.js";

const allowedImportRootsEnv = "TABULA_MCP_ALLOWED_IMPORT_ROOTS";

type ImportRoot = {
  path: string;
  source: "client-roots" | "env";
};

const splitEnvPaths = (value: string | undefined) =>
  value
    ?.split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

const pathContains = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const resolveExistingPath = async (value: string) => realpath(path.resolve(value));

const rootsFromEnvironment = (env: RuntimeEnvironment | undefined): ImportRoot[] =>
  splitEnvPaths(env?.[allowedImportRootsEnv]).map((entry) => ({
    path: path.resolve(entry),
    source: "env" as const,
  }));

export const hasExplicitImportRoots = (env: RuntimeEnvironment | undefined) =>
  rootsFromEnvironment(env).length > 0;

const rootsFromClient = async (server: McpServer): Promise<ImportRoot[]> => {
  if (!server.server.getClientCapabilities()?.roots) {
    return [];
  }

  try {
    const response = await server.server.listRoots();
    return response.roots.flatMap((root) => {
      try {
        const url = new URL(root.uri);
        if (url.protocol !== "file:") {
          return [];
        }
        return [{ path: fileURLToPath(url), source: "client-roots" as const }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

export const assertLocalImportRootAllowed = async ({
  env,
  rootPath,
  server,
}: {
  env?: RuntimeEnvironment;
  rootPath: string;
  server: McpServer;
}) => {
  const requestedRoot = await resolveExistingPath(rootPath).catch(() => null);
  if (!requestedRoot) {
    throw new TabulaMcpError("Markdown workspace import rootPath must be an existing directory.");
  }

  const roots = [...(await rootsFromClient(server)), ...rootsFromEnvironment(env)];
  if (roots.length === 0) {
    throw new TabulaMcpError(
      "Local Markdown workspace import requires MCP client roots or TABULA_MCP_ALLOWED_IMPORT_ROOTS. Use source.files when the MCP client cannot grant filesystem roots.",
    );
  }

  for (const root of roots) {
    const resolvedRoot = await resolveExistingPath(root.path).catch(() => null);
    if (resolvedRoot && pathContains(resolvedRoot, requestedRoot)) {
      return {
        rootPath: requestedRoot,
        allowedBy: root.source,
        allowedRoot: resolvedRoot,
      };
    }
  }

  throw new TabulaMcpError(
    `Local Markdown workspace import rootPath is outside MCP client roots and ${allowedImportRootsEnv}.`,
  );
};
