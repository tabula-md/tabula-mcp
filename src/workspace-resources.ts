import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionRegistry } from "./registry.js";
import { TabulaMcpError } from "./protocol.js";
import {
  readStoredWorkspace,
  readStoredWorkspaceDocument,
  type WorkspaceRegistry,
} from "./workspaces.js";

const workspaceScheme = "tabula";
const jsonMimeType = "application/json";
const markdownMimeType = "text/markdown";

const encodeUriPart = (value: string) => encodeURIComponent(value);
const decodeUriVariable = (value: string | string[] | undefined, label: string) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    throw new TabulaMcpError(`Missing ${label} in Tabula resource URI.`);
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new TabulaMcpError(`Invalid ${label} in Tabula resource URI.`);
  }
};

const jsonResourceText = (value: unknown) => JSON.stringify(value, null, 2);

export const workspaceResourceUri = (workspaceId: string) =>
  `${workspaceScheme}://workspace/${encodeUriPart(workspaceId)}`;

export const workspaceDocumentResourceUri = (workspaceId: string, documentId: string) =>
  `${workspaceScheme}://workspace/${encodeUriPart(workspaceId)}/document/${encodeUriPart(documentId)}`;

export const roomWorkspaceResourceUri = (sessionId: string) =>
  `${workspaceScheme}://room/${encodeUriPart(sessionId)}/workspace`;

export const roomDocumentResourceUri = (sessionId: string, documentId: string) =>
  `${workspaceScheme}://room/${encodeUriPart(sessionId)}/document/${encodeUriPart(documentId)}`;

export const addWorkspaceResourceUris = <T extends { workspaceId?: string; sessionId?: string; documents?: unknown[] }>(
  value: T,
): T => {
  const workspaceId = value.workspaceId;
  const sessionId = value.sessionId;
  const resourceUri = workspaceId
    ? workspaceResourceUri(workspaceId)
    : sessionId
      ? roomWorkspaceResourceUri(sessionId)
      : undefined;
  const documents = Array.isArray(value.documents)
    ? value.documents.map((document) => {
        if (!document || typeof document !== "object") {
          return document;
        }
        const documentId =
          "id" in document && typeof document.id === "string"
            ? document.id
            : "documentId" in document && typeof document.documentId === "string"
              ? document.documentId
              : undefined;
        if (!documentId) {
          return document;
        }
        const documentResourceUri = workspaceId
          ? workspaceDocumentResourceUri(workspaceId, documentId)
          : sessionId
            ? roomDocumentResourceUri(sessionId, documentId)
            : undefined;
        return documentResourceUri ? { ...document, resourceUri: documentResourceUri } : document;
      })
    : value.documents;

  return {
    ...value,
    ...(resourceUri ? { resourceUri } : {}),
    ...(documents ? { documents } : {}),
  };
};

export const addWorkspaceDocumentResourceUri = <T extends { workspaceId?: string; sessionId?: string; documentId: string }>(
  value: T,
): T & { resourceUri?: string } => {
  const resourceUri = value.workspaceId
    ? workspaceDocumentResourceUri(value.workspaceId, value.documentId)
    : value.sessionId
      ? roomDocumentResourceUri(value.sessionId, value.documentId)
      : undefined;
  return {
    ...value,
    ...(resourceUri ? { resourceUri } : {}),
  };
};

const listStoredWorkspaceResources = (workspaces: WorkspaceRegistry) =>
  workspaces.list().flatMap((workspace) => [
    {
      uri: workspaceResourceUri(workspace.workspaceId),
      name: `workspace:${workspace.workspaceId}`,
      title: `Tabula Workspace: ${workspace.title}`,
      description: "Read-only Tabula workspace metadata JSON.",
      mimeType: jsonMimeType,
    },
    ...workspace.documents.map((document) => ({
      uri: workspaceDocumentResourceUri(workspace.workspaceId, document.documentId),
      name: `workspace:${workspace.workspaceId}:document:${document.documentId}`,
      title: document.path || document.title,
      description: `Read-only Markdown document from Tabula workspace ${workspace.title}.`,
      mimeType: markdownMimeType,
    })),
  ]);

const listRoomSessionResources = async (registry: SessionRegistry) => {
  const resources = [];
  for (const session of registry.list()) {
    resources.push({
      uri: roomWorkspaceResourceUri(session.sessionId),
      name: `room:${session.sessionId}:workspace`,
      title: `Tabula Room Workspace: ${session.roomId}`,
      description: "Read-only connected Tabula room workspace metadata JSON. The room key is not exposed.",
      mimeType: jsonMimeType,
    });

    const workspace = await session.readWorkspace().catch(() => null);
    for (const document of workspace?.documents ?? []) {
      resources.push({
        uri: roomDocumentResourceUri(session.sessionId, document.id),
        name: `room:${session.sessionId}:document:${document.id}`,
        title: document.title,
        description: `Read-only cached Markdown document from connected Tabula room ${session.roomId}.`,
        mimeType: markdownMimeType,
      });
    }
  }
  return resources;
};

export const registerWorkspaceResources = (
  server: McpServer,
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
) => {
  server.registerResource(
    "tabula-workspace",
    new ResourceTemplate(`${workspaceScheme}://workspace/{workspaceId}`, {
      list: async () => ({ resources: listStoredWorkspaceResources(workspaces).filter((resource) => resource.mimeType === jsonMimeType) }),
    }),
    {
      title: "Tabula Workspace",
      description: "Read-only Tabula workspace metadata JSON.",
      mimeType: jsonMimeType,
    },
    async (uri, variables) => {
      const workspaceId = decodeUriVariable(variables.workspaceId, "workspaceId");
      const workspace = addWorkspaceResourceUris(readStoredWorkspace(workspaces.get(workspaceId)));
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: jsonMimeType,
            text: jsonResourceText(workspace),
          },
        ],
      };
    },
  );

  server.registerResource(
    "tabula-workspace-document",
    new ResourceTemplate(`${workspaceScheme}://workspace/{workspaceId}/document/{documentId}`, {
      list: async () => ({
        resources: listStoredWorkspaceResources(workspaces).filter((resource) => resource.mimeType === markdownMimeType),
      }),
    }),
    {
      title: "Tabula Workspace Document",
      description: "Read-only Markdown document from a local/imported Tabula workspace.",
      mimeType: markdownMimeType,
    },
    async (uri, variables) => {
      const workspaceId = decodeUriVariable(variables.workspaceId, "workspaceId");
      const documentId = decodeUriVariable(variables.documentId, "documentId");
      const document = addWorkspaceDocumentResourceUri(readStoredWorkspaceDocument(workspaces.get(workspaceId), documentId));
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: markdownMimeType,
            text: document.markdown,
            _meta: {
              workspaceId,
              documentId,
              path: document.path,
              title: document.title,
              sha256: document.sha256,
            },
          },
        ],
      };
    },
  );

  server.registerResource(
    "tabula-room-workspace",
    new ResourceTemplate(`${workspaceScheme}://room/{sessionId}/workspace`, {
      list: async () => ({
        resources: (await listRoomSessionResources(registry)).filter((resource) => resource.mimeType === jsonMimeType),
      }),
    }),
    {
      title: "Tabula Room Workspace",
      description: "Read-only connected Tabula room workspace metadata JSON. The room key is not exposed.",
      mimeType: jsonMimeType,
    },
    async (uri, variables) => {
      const sessionId = decodeUriVariable(variables.sessionId, "sessionId");
      const workspace = addWorkspaceResourceUris(await registry.get(sessionId).readWorkspace());
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: jsonMimeType,
            text: jsonResourceText(workspace),
          },
        ],
      };
    },
  );

  server.registerResource(
    "tabula-room-document",
    new ResourceTemplate(`${workspaceScheme}://room/{sessionId}/document/{documentId}`, {
      list: async () => ({
        resources: (await listRoomSessionResources(registry)).filter((resource) => resource.mimeType === markdownMimeType),
      }),
    }),
    {
      title: "Tabula Room Document",
      description: "Read-only cached Markdown document from a connected Tabula room.",
      mimeType: markdownMimeType,
    },
    async (uri, variables) => {
      const sessionId = decodeUriVariable(variables.sessionId, "sessionId");
      const documentId = decodeUriVariable(variables.documentId, "documentId");
      const document = addWorkspaceDocumentResourceUri(await registry.get(sessionId).readWorkspaceDocument({ documentId }));
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: markdownMimeType,
            text: document.markdown,
            _meta: {
              sessionId,
              documentId,
              ...("path" in document && typeof document.path === "string" ? { path: document.path } : {}),
              title: document.title,
              sha256: document.sha256,
            },
          },
        ],
      };
    },
  );
};
