import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDocumentAppResource, registerDocumentAppResource } from "../app/resource.js";
import { DocumentRegistry } from "../documents/registry.js";
import type { RuntimeEnvironment } from "../env.js";
import {
  createDefaultDocumentStore,
  resolveDocumentStoreDeploymentMode,
  type DocumentStore,
  type DocumentStoreDeploymentMode,
  type DocumentStoreKind,
} from "../documents/store.js";
import { SessionRegistry } from "../registry.js";
import { registerWorkspaceResources } from "../workspace-resources.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { TABULA_MCP_VERSION } from "../version.js";
import { createCoreInstructions } from "./instructions.js";
import { registerCoreTools } from "./register-core-tools.js";
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
  }, {
    instructions: createCoreInstructions({ deploymentMode }),
  });

  registerDocumentAppResource(server, documentAppResource);
  registerWorkspaceResources(server, registry, workspaces);

  registerCoreTools(server, registry, documents, {
    allowTemporaryRooms: allowRoomTools && allowTemporaryRooms,
    deploymentMode,
    env,
    resourceUri: documentAppResource.uri,
    writeEnabled: allowRoomTools && writeEnabled,
  });

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
