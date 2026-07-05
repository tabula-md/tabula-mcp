import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerDocumentAppResource } from "../app/resource.js";
import { registerDocumentAppTools } from "../app/tools.js";
import { DocumentRegistry } from "../documents/registry.js";
import {
  createDefaultDocumentStore,
  resolveDocumentStoreDeploymentMode,
  type DocumentStore,
  type DocumentStoreDeploymentMode,
  type DocumentStoreKind,
} from "../documents/store.js";
import { formatTabulaReadMe, getTabulaReadMe, tabulaReadMeTopics } from "../guidance.js";
import { readMeOutputShape } from "../output-schemas.js";
import { SessionRegistry } from "../registry.js";
import { registerRoomTools } from "./register-room-tools.js";
import { resolveWriteEnabled } from "./write-access.js";

export type TabulaMcpServerOptions = {
  allowRoomTools?: boolean;
  documentAppHtml?: string;
  writeEnabled?: boolean;
  documentStore?: DocumentStore;
  deploymentMode?: DocumentStoreDeploymentMode;
};

export type TabulaMcpServerInstance = {
  server: McpServer;
  registry: SessionRegistry;
  documents: DocumentRegistry;
  writeEnabled: boolean;
  deploymentMode: DocumentStoreDeploymentMode;
  documentStoreKind: DocumentStoreKind;
};

const tabulaReadMeTopicSchema = z.enum(tabulaReadMeTopics).default("overview");

const registerReadMeTool = (server: McpServer) => {
  server.registerTool(
    "tabula_read_me",
    {
      description:
        "Read concise Tabula.md MCP guidance for document drafting, room links, encrypted sharing, and security boundaries. Call this once before choosing a Tabula workflow.",
      inputSchema: {
        topic: tabulaReadMeTopicSchema.describe("Guidance topic to read."),
      },
      outputSchema: readMeOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic }) => {
      const readMe = getTabulaReadMe(topic);
      return {
        content: [
          {
            type: "text" as const,
            text: formatTabulaReadMe(readMe),
          },
        ],
        structuredContent: {
          readMe,
        },
      };
    },
  );
};

export const createTabulaMcpServer = (options: TabulaMcpServerOptions = {}): TabulaMcpServerInstance => {
  const writeEnabled = options.writeEnabled ?? resolveWriteEnabled();
  const allowRoomTools = options.allowRoomTools ?? true;
  const deploymentMode = resolveDocumentStoreDeploymentMode({ deploymentMode: options.deploymentMode });
  const documentStore = options.documentStore ?? createDefaultDocumentStore({ deploymentMode });
  const registry = new SessionRegistry();
  const documents = new DocumentRegistry(documentStore);
  const server = new McpServer({
    name: "tabula-mcp",
    version: "0.1.0",
  });

  registerDocumentAppResource(server, { documentAppHtml: options.documentAppHtml });

  let documentAppToolsRegistered = false;
  server.server.oninitialized = () => {
    const uiCapability = getUiCapability(server.server.getClientCapabilities());
    if (documentAppToolsRegistered || !uiCapability?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) {
      return;
    }

    registerDocumentAppTools(server, registry, documents);
    documentAppToolsRegistered = true;
    server.sendToolListChanged();
  };

  registerReadMeTool(server);
  if (allowRoomTools) {
    registerRoomTools(server, registry, { writeEnabled });
  }

  return { server, registry, documents, writeEnabled, deploymentMode, documentStoreKind: documentStore.kind };
};
