import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionRegistry } from "./registry.js";
import { listSessionFiles, readSessionFiles } from "./workspace-file-service.js";
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

export const registerFileResources = (
  server: McpServer,
  registry: SessionRegistry,
) => {
  server.registerResource(
    "tabula-session",
    new ResourceTemplate(`${scheme}://session/{sessionId}`, {
      // Connected Room handles are capabilities. Advertise the URI shape, but
      // never enumerate handles from other host conversations.
      list: undefined,
    }),
    {
      title: "Tabula Session",
      description: "Read-only path and revision manifest for a connected Tabula session.",
      mimeType: jsonMimeType,
    },
    async (uri, variables) => {
      const sessionId = decodeVariable(variables.sessionId, "sessionId");
      const { files, truncated, nextCursor } = await listSessionFiles({ registry, sessionId });
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: jsonMimeType,
          text: JSON.stringify({ sessionId, files, truncated, ...(nextCursor ? { nextCursor } : {}) }, null, 2),
        }],
      };
    },
  );

  server.registerResource(
    "tabula-session-file",
    new ResourceTemplate(`${scheme}://session/{sessionId}/file/{path}`, {
      list: undefined,
    }),
    {
      title: "Tabula Session File",
      description: "Read-only Markdown file from a connected Tabula session.",
      mimeType: markdownMimeType,
    },
    async (uri, variables) => {
      const sessionId = decodeVariable(variables.sessionId, "sessionId");
      const filePath = normalizeWorkspaceFilePath(decodeVariable(variables.path, "path"));
      const { files } = await readSessionFiles({ registry, sessionId, paths: [filePath] });
      const file = files[0];
      if (!file) throw new Error("Tabula session file was not returned.");
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
