import { readFile } from "node:fs/promises";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent } from "./json.js";
import { TabulaMcpError } from "./protocol.js";
import type { SessionRegistry } from "./registry.js";

const roomViewResourceUri = "ui://tabula/room-view.html";

type RoomStatus = Awaited<ReturnType<ReturnType<SessionRegistry["get"]>["getStatus"]>>;

const optionalSessionSchema = {
  sessionId: z.string().uuid().optional().describe("Session id returned by tabula_connect_room. Defaults to the latest session."),
};

const structuredContent = (value: Record<string, unknown>, text: string) => ({
  content: [
    {
      type: "text" as const,
      text,
    },
  ],
  structuredContent: value,
});

const runStructuredTool = async (
  handler: () => Promise<{ value: Record<string, unknown>; text: string }>,
) => {
  try {
    const result = await handler();
    return structuredContent(result.value, result.text);
  } catch (error) {
    return errorContent(error);
  }
};

const readRoomViewHtml = async () => {
  const candidateUrls = [
    new URL("./room-view.html", import.meta.url),
    new URL("../dist/room-view.html", import.meta.url),
  ];

  for (const url of candidateUrls) {
    try {
      return await readFile(url, "utf8");
    } catch {
      // Try the next runtime layout.
    }
  }

  throw new TabulaMcpError("Tabula Room View asset is missing. Run npm run build:app before opening the MCP App.");
};

const summarizeStatus = (status: RoomStatus) => ({
  sessionId: status.sessionId,
  roomId: status.roomId,
  status: status.status,
  writeAccess: status.writeAccess,
  textLength: status.textLength,
  sha256: status.sha256,
  peerCount: status.peerCount,
  collaboratorCount: status.collaborators.length,
});

const readSnapshot = async (registry: SessionRegistry, sessionId?: string) => {
  const session = registry.get(sessionId);
  const [status, markdown, outline] = await Promise.all([
    session.getStatus(),
    session.readMarkdown(),
    session.getOutline(),
  ]);

  return {
    status: summarizeStatus(status),
    markdown: markdown.markdown,
    outline: outline.outline,
  };
};

export const registerRoomViewTools = (server: McpServer, registry: SessionRegistry) => {
  registerAppTool(
    server,
    "tabula_open_room_view",
    {
      title: "Open Tabula Room View",
      description:
        "Open a read-only MCP App view for a connected Tabula.md room, including status, outline, Markdown preview, refresh, and selection handoff.",
      inputSchema: optionalSessionSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: roomViewResourceUri,
        },
      },
    },
    async ({ sessionId }) =>
      runStructuredTool(async () => {
        const status = await registry.get(sessionId).getStatus();
        const room = summarizeStatus(status);

        return {
          value: {
            room,
            resourceUri: roomViewResourceUri,
          },
          text: `Opening Tabula Room View for room ${status.roomId}.`,
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_app_room_snapshot",
    {
      description: "Read a connected room snapshot for the Tabula Room View MCP App.",
      inputSchema: optionalSessionSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ sessionId }) =>
      runStructuredTool(async () => ({
        value: await readSnapshot(registry, sessionId),
        text: "Tabula Room View snapshot loaded.",
      })),
  );

};

export const registerRoomViewResource = (server: McpServer) => {
  registerAppResource(
    server,
    "Tabula Room View",
    roomViewResourceUri,
    {
      description: "Interactive read-only view for connected Tabula.md rooms.",
      _meta: {
        ui: {
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: roomViewResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readRoomViewHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {},
            },
          },
        },
      ],
    }),
  );
};

export const roomViewAppResourceUri = roomViewResourceUri;
