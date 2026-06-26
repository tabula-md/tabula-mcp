import { readFile } from "node:fs/promises";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DocumentRegistry, summarizeDocument, type TabulaDocumentSnapshot } from "./document-registry.js";
import { errorContent } from "./json.js";
import { TabulaMcpError } from "./protocol.js";
import type { SessionRegistry } from "./registry.js";

const documentAppResourceUri = "ui://tabula/document.html";

type RoomStatus = Awaited<ReturnType<ReturnType<SessionRegistry["get"]>["getStatus"]>>;

const optionalSessionSchema = {
  sessionId: z.string().uuid().optional().describe("Session id returned by tabula_connect_room. Defaults to the latest session."),
};

const optionalDocumentSchema = {
  documentId: z.string().uuid().optional().describe("Document id returned by tabula_create_document. Defaults to the latest document."),
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

const readDocumentAppHtml = async () => {
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

  throw new TabulaMcpError("Tabula Document App asset is missing. Run npm run build:app before opening the MCP App.");
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

const documentSnapshotContent = (document: TabulaDocumentSnapshot) => ({
  mode: "document",
  document: summarizeDocument(document),
  markdown: document.markdown,
  outline: document.outline,
});

const readRoomSnapshot = async (registry: SessionRegistry, sessionId?: string) => {
  const session = registry.get(sessionId);
  const [status, markdown, outline] = await Promise.all([
    session.getStatus(),
    session.readMarkdown(),
    session.getOutline(),
  ]);

  const room = summarizeStatus(status);

  return {
    mode: "room",
    room,
    status: room,
    markdown: markdown.markdown,
    outline: outline.outline,
  };
};

export const registerDocumentAppTools = (
  server: McpServer,
  registry: SessionRegistry,
  documents: DocumentRegistry,
) => {
  registerAppTool(
    server,
    "tabula_create_document",
    {
      title: "Create Tabula Document",
      description:
        "Create a local Tabula.md Markdown document and open the interactive MCP App editor for drafting, reviewing, and selection handoff.",
      inputSchema: {
        title: z.string().min(1).max(120).optional().describe("Optional document title. Defaults to the first H1 or Untitled Document."),
        markdown: z.string().default("").describe("Initial Markdown content for the local document."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: documentAppResourceUri,
        },
      },
    },
    async ({ title, markdown }) =>
      runStructuredTool(async () => {
        const document = await documents.create({ title, markdown });

        return {
          value: {
            ...documentSnapshotContent(document),
            resourceUri: documentAppResourceUri,
          },
          text: `Opening Tabula.md document "${document.title}".`,
        };
      }),
  );

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
          resourceUri: documentAppResourceUri,
        },
      },
    },
    async ({ sessionId }) =>
      runStructuredTool(async () => {
        const status = await registry.get(sessionId).getStatus();
        const room = summarizeStatus(status);

        return {
          value: {
            mode: "room",
            room,
            resourceUri: documentAppResourceUri,
          },
          text: `Opening Tabula Room View for room ${status.roomId}.`,
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_app_room_snapshot",
    {
      description: "Read a connected room snapshot for the Tabula Document MCP App.",
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
        value: await readRoomSnapshot(registry, sessionId),
        text: "Tabula room snapshot loaded.",
      })),
  );

  registerAppTool(
    server,
    "tabula_app_document_snapshot",
    {
      description: "Read a local document snapshot for the Tabula Document MCP App.",
      inputSchema: optionalDocumentSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ documentId }) =>
      runStructuredTool(async () => ({
        value: documentSnapshotContent(await documents.get(documentId)),
        text: "Tabula document snapshot loaded.",
      })),
  );

  registerAppTool(
    server,
    "tabula_app_save_document",
    {
      description: "Save the current Markdown for a local Tabula Document MCP App document.",
      inputSchema: {
        documentId: z.string().uuid().describe("Document id returned by tabula_create_document."),
        title: z.string().min(1).max(120).optional().describe("Optional updated document title."),
        markdown: z.string().describe("Full Markdown content to keep in the local MCP App document."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async ({ documentId, title, markdown }) =>
      runStructuredTool(async () => ({
        value: documentSnapshotContent(await documents.update({ documentId, title, markdown })),
        text: "Tabula document saved in the local MCP session.",
      })),
  );
};

export const registerDocumentAppResource = (server: McpServer) => {
  registerAppResource(
    server,
    "Tabula Document App",
    documentAppResourceUri,
    {
      description: "Interactive Markdown document editor and read-only room view for Tabula.md.",
      _meta: {
        ui: {
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: documentAppResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readDocumentAppHtml(),
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

export const tabulaDocumentAppResourceUri = documentAppResourceUri;
export const roomViewAppResourceUri = documentAppResourceUri;
