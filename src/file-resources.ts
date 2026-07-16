import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionRegistry } from "./registry.js";
import { listSessionFiles, readSessionFile } from "./workspace-file-service.js";
import { normalizeWorkspaceFilePath } from "./workspace-paths.js";

const scheme = "tabula";
const jsonMimeType = "application/json";
const markdownMimeType = "text/markdown";

const encodePart = (value: string) => encodeURIComponent(value);
const decodeVariable = (value: string | string[] | undefined, label: string) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) throw new Error(`Missing ${label} in Tabula resource URI.`);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(`Invalid ${label} in Tabula resource URI.`);
  }
};

export const sessionResourceUri = (sessionId: string) =>
  `${scheme}://session/${encodePart(sessionId)}`;

export const sessionFileResourceUri = (sessionId: string, filePath: string) =>
  `${sessionResourceUri(sessionId)}/file/${encodePart(normalizeWorkspaceFilePath(filePath))}`;

const listSessionManifestResources = (registry: SessionRegistry) =>
  registry.list().map((session) => ({
    uri: sessionResourceUri(session.sessionId),
    name: `session:${session.sessionId}`,
    title: "Tabula session files",
    description: "Read-only path and revision manifest for a connected Tabula session.",
    mimeType: jsonMimeType,
  }));

const listSessionFileResources = async (registry: SessionRegistry) => {
  const resources = [];
  for (const session of registry.list()) {
    const listed = await listSessionFiles({ registry, sessionId: session.sessionId }).catch(() => null);
    if (!listed) continue;
    for (const file of listed.files) {
      if (file.type !== "file") continue;
      resources.push({
        uri: sessionFileResourceUri(session.sessionId, file.path),
        name: `session:${session.sessionId}:file:${file.path}`,
        title: file.path,
        description: "Read-only Markdown from a connected Tabula session.",
        mimeType: markdownMimeType,
      });
    }
  }
  return resources;
};

export const registerFileResources = (
  server: McpServer,
  registry: SessionRegistry,
) => {
  server.registerResource(
    "tabula-session",
    new ResourceTemplate(`${scheme}://session/{sessionId}`, {
      list: async () => ({ resources: listSessionManifestResources(registry) }),
    }),
    {
      title: "Tabula Session",
      description: "Read-only path and revision manifest for a connected Tabula session.",
      mimeType: jsonMimeType,
    },
    async (uri, variables) => {
      const sessionId = decodeVariable(variables.sessionId, "sessionId");
      const { files, truncated } = await listSessionFiles({ registry, sessionId });
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: jsonMimeType,
          text: JSON.stringify({ sessionId, files, truncated }, null, 2),
        }],
      };
    },
  );

  server.registerResource(
    "tabula-session-file",
    new ResourceTemplate(`${scheme}://session/{sessionId}/file/{path}`, {
      list: async () => ({ resources: await listSessionFileResources(registry) }),
    }),
    {
      title: "Tabula Session File",
      description: "Read-only Markdown file from a connected Tabula session.",
      mimeType: markdownMimeType,
    },
    async (uri, variables) => {
      const sessionId = decodeVariable(variables.sessionId, "sessionId");
      const filePath = normalizeWorkspaceFilePath(decodeVariable(variables.path, "path"));
      const file = await readSessionFile({ registry, sessionId, path: filePath });
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: markdownMimeType,
          text: file.content,
          _meta: {
            sessionId,
            path: file.path,
            revision: file.revision,
            textLength: file.textLength,
          },
        }],
      };
    },
  );
};
