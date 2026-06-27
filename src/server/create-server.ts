import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerDocumentAppResource } from "../app/resource.js";
import { registerDocumentAppTools } from "../app/tools.js";
import { DocumentRegistry } from "../documents/registry.js";
import { createDefaultDocumentStore, type DocumentStore } from "../documents/store.js";
import { formatTabulaReadMe, getTabulaReadMe, tabulaReadMeTopics } from "../guidance.js";
import { SessionRegistry } from "../registry.js";
import { registerRoomTools } from "./register-room-tools.js";
import { resolveWriteEnabled } from "./write-access.js";

export type TabulaMcpServerOptions = {
  writeEnabled?: boolean;
  documentStore?: DocumentStore;
};

export type TabulaMcpServerInstance = {
  server: McpServer;
  registry: SessionRegistry;
  documents: DocumentRegistry;
  writeEnabled: boolean;
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
  const registry = new SessionRegistry();
  const documents = new DocumentRegistry(options.documentStore ?? createDefaultDocumentStore());
  const server = new McpServer({
    name: "tabula-mcp",
    version: "0.1.0",
  });

  registerDocumentAppResource(server);

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
  registerRoomTools(server, registry, { writeEnabled });

  return { server, registry, documents, writeEnabled };
};
