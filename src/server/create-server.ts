import "../node-runtime.js";
import { createSessionAgentIdentity } from "../agent-identity.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDocumentAppResource, registerDocumentAppResource } from "../app/resource.js";
import { resolveDeploymentMode, type DeploymentMode } from "../deployment.js";
import { positiveIntegerFromEnv, type RuntimeEnvironment } from "../env.js";
import { registerFileResources } from "../file-resources.js";
import { SessionRegistry, type SessionRegistryLifecycle } from "../registry.js";
import { TABULA_MCP_VERSION } from "../version.js";
import { createCoreInstructions } from "./instructions.js";
import { registerCoreTools } from "./register-core-tools.js";
import { resolveWriteEnabled } from "./write-access.js";

export type TabulaMcpServerOptions = {
  allowRoomTools?: boolean;
  documentAppHtml?: string;
  forceDocumentAppTools?: boolean;
  writeEnabled?: boolean;
  deploymentMode?: DeploymentMode;
  env?: RuntimeEnvironment;
  roomSessionLifecycle?: SessionRegistryLifecycle;
};

export type TabulaMcpServerInstance = {
  server: McpServer;
  documentAppResourceUri: string;
  registry: SessionRegistry;
  writeEnabled: boolean;
  deploymentMode: DeploymentMode;
};

export const createTabulaMcpServer = (options: TabulaMcpServerOptions = {}): TabulaMcpServerInstance => {
  const env = options.env ?? process.env;
  const writeEnabled = options.writeEnabled ?? resolveWriteEnabled({ env: env as NodeJS.ProcessEnv | undefined });
  const allowRoomTools = options.allowRoomTools ?? true;
  const deploymentMode = resolveDeploymentMode({ deploymentMode: options.deploymentMode, env });
  const allowTemporaryRooms = deploymentMode === "local";
  const registry = new SessionRegistry({
    lifecycle: options.roomSessionLifecycle,
    maxSessions: positiveIntegerFromEnv(env?.TABULA_MCP_MAX_ROOMS_PER_SESSION, 8),
  });
  const documentAppResource = createDocumentAppResource({ documentAppHtml: options.documentAppHtml });
  const resolveAgentIdentity = createSessionAgentIdentity({ env });
  const server = new McpServer({
    name: "tabula-mcp",
    version: TABULA_MCP_VERSION,
  }, {
    instructions: createCoreInstructions({ deploymentMode }),
  });

  registerDocumentAppResource(server, documentAppResource);
  registerFileResources(server, registry);

  registerCoreTools(server, registry, {
    allowTemporaryRooms: allowRoomTools && allowTemporaryRooms,
    env,
    resourceUri: documentAppResource.uri,
    resolveAgentIdentity: () => resolveAgentIdentity(server.server.getClientVersion()?.name),
    writeEnabled: allowRoomTools && writeEnabled,
  });

  return {
    server,
    documentAppResourceUri: documentAppResource.uri,
    registry,
    writeEnabled,
    deploymentMode,
  };
};
