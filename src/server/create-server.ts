import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDocumentAppResource, registerDocumentAppResource } from "../app/resource.js";
import { registerDocumentAppTools } from "../app/tools.js";
import { DocumentRegistry } from "../documents/registry.js";
import type { RuntimeEnvironment } from "../env.js";
import {
  createDefaultDocumentStore,
  resolveDocumentStoreDeploymentMode,
  type DocumentStore,
  type DocumentStoreDeploymentMode,
  type DocumentStoreKind,
} from "../documents/store.js";
import { formatTabulaReadMe, getTabulaReadMe, tabulaReadMeTopics } from "../guidance.js";
import { SessionRegistry } from "../registry.js";
import { registerWorkspaceResources } from "../workspace-resources.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { TABULA_MCP_VERSION } from "../version.js";
import { registerRoomTools } from "./register-room-tools.js";
import { resolveWriteEnabled } from "./write-access.js";

export type TabulaMcpServerOptions = {
  allowRoomTools?: boolean;
  documentAppHtml?: string;
  forceDocumentAppTools?: boolean;
  writeEnabled?: boolean;
  documentStore?: DocumentStore;
  deploymentMode?: DocumentStoreDeploymentMode;
  env?: RuntimeEnvironment;
};

export type TabulaMcpServerInstance = {
  server: McpServer;
  documentAppResourceUri: string;
  registry: SessionRegistry;
  workspaces: WorkspaceRegistry;
  documents: DocumentRegistry;
  writeEnabled: boolean;
  deploymentMode: DocumentStoreDeploymentMode;
  documentStoreKind: DocumentStoreKind;
};

const tabulaReadMeTopicSchema = z.enum(tabulaReadMeTopics).default("overview");

const registerReadMeTool = (
  server: McpServer,
  runtime: {
    deploymentMode: DocumentStoreDeploymentMode;
    writeEnabled: boolean;
  },
) => {
  server.registerTool(
    "tabula_read_me",
    {
      title: "Read Tabula Guidance",
      description:
        "Read concise Tabula.md MCP guidance for document drafting, room links, encrypted sharing, and security boundaries. Call this once before choosing a Tabula workflow.",
      inputSchema: {
        topic: tabulaReadMeTopicSchema.describe("Guidance topic to read."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic }) => {
      const readMe = getTabulaReadMe(topic);
      const runtimeSummary = {
        version: TABULA_MCP_VERSION,
        deploymentMode: runtime.deploymentMode,
        writeAccess: runtime.writeEnabled ? "enabled" : "read-only",
        trustBoundary: runtime.deploymentMode === "local"
          ? "The Tabula room client runs on this device. The model provider receives content returned by tools."
          : "This hosted MCP runtime is a trusted plaintext room participant for the active session.",
      } as const;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              formatTabulaReadMe(readMe),
              "",
              "Runtime:",
              `- Version: ${runtimeSummary.version}`,
              `- Deployment: ${runtimeSummary.deploymentMode}`,
              `- Write access: ${runtimeSummary.writeAccess}`,
              `- Trust: ${runtimeSummary.trustBoundary}`,
            ].join("\n"),
          },
        ],
        structuredContent: {
          readMe,
          runtime: runtimeSummary,
        },
      };
    },
  );
};

export const createTabulaMcpServer = (options: TabulaMcpServerOptions = {}): TabulaMcpServerInstance => {
  const env = options.env ?? process.env;
  const writeEnabled = options.writeEnabled ?? resolveWriteEnabled({ env: env as NodeJS.ProcessEnv | undefined });
  const allowRoomTools = options.allowRoomTools ?? true;
  const deploymentMode = resolveDocumentStoreDeploymentMode({ deploymentMode: options.deploymentMode });
  const allowTemporaryRooms = deploymentMode === "local";
  const documentStore = options.documentStore ?? createDefaultDocumentStore({ deploymentMode });
  const registry = new SessionRegistry();
  const workspaces = new WorkspaceRegistry();
  const documents = new DocumentRegistry(documentStore);
  const documentAppResource = createDocumentAppResource({ documentAppHtml: options.documentAppHtml });
  const server = new McpServer({
    name: "tabula-mcp",
    version: TABULA_MCP_VERSION,
  });

  registerDocumentAppResource(server, documentAppResource);
  registerWorkspaceResources(server, registry, workspaces);

  let documentAppToolsRegistered = false;
  const registerAppTools = () => {
    registerDocumentAppTools(server, registry, documents, {
      allowRoomTools,
      allowTemporaryRooms,
      writeEnabled,
      env,
      resourceUri: documentAppResource.uri,
    });
    documentAppToolsRegistered = true;
  };
  if (options.forceDocumentAppTools) {
    registerAppTools();
  }

  server.server.oninitialized = () => {
    const uiCapability = getUiCapability(server.server.getClientCapabilities());
    if (documentAppToolsRegistered || !uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) {
      return;
    }

    registerAppTools();
    server.sendToolListChanged();
  };

  registerReadMeTool(server, { deploymentMode, writeEnabled });
  if (allowRoomTools) {
    registerRoomTools(server, registry, workspaces, { env, writeEnabled, allowTemporaryRooms });
  }

  return {
    server,
    documentAppResourceUri: documentAppResource.uri,
    registry,
    workspaces,
    documents,
    writeEnabled,
    deploymentMode,
    documentStoreKind: documentStore.kind,
  };
};
