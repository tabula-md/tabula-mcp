import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentRegistry } from "../documents/registry.js";
import { errorContent } from "../json.js";
import type { SessionRegistry } from "../registry.js";
import { shareMarkdownDocument } from "../share.js";
import {
  documentSnapshotContent,
  readDocumentSnapshot,
  readRoomSnapshot,
  summarizeRoomStatus,
} from "./snapshots.js";
import { tabulaDocumentAppResourceUri } from "./types.js";

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
          resourceUri: tabulaDocumentAppResourceUri,
        },
      },
    },
    async ({ title, markdown }) =>
      runStructuredTool(async () => {
        const document = await documents.create({ title, markdown });

        return {
          value: {
            ...documentSnapshotContent(document),
            resourceUri: tabulaDocumentAppResourceUri,
          },
          text: `Opening Tabula.md document "${document.title}".`,
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_list_documents",
    {
      title: "List Tabula Documents",
      description:
        "List local Tabula.md MCP App documents saved in this local server checkpoint store, newest first.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {},
      },
    },
    async () =>
      runStructuredTool(async () => {
        const localDocuments = await documents.list();

        return {
          value: {
            documents: localDocuments,
          },
          text: localDocuments.length
            ? `Found ${localDocuments.length} local Tabula.md document checkpoint(s).`
            : "No local Tabula.md document checkpoints found.",
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_open_document",
    {
      title: "Open Tabula Document",
      description:
        "Open the latest or selected local Tabula.md document checkpoint in the interactive MCP App editor.",
      inputSchema: optionalDocumentSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: tabulaDocumentAppResourceUri,
        },
      },
    },
    async ({ documentId }) =>
      runStructuredTool(async () => {
        const document = await documents.get(documentId);

        return {
          value: {
            ...documentSnapshotContent(document),
            resourceUri: tabulaDocumentAppResourceUri,
          },
          text: `Opening local Tabula.md document checkpoint "${document.title}".`,
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
          resourceUri: tabulaDocumentAppResourceUri,
        },
      },
    },
    async ({ sessionId }) =>
      runStructuredTool(async () => {
        const status = await registry.get(sessionId).getStatus();
        const room = summarizeRoomStatus(status);

        return {
          value: {
            mode: "room",
            room,
            resourceUri: tabulaDocumentAppResourceUri,
          },
          text: `Opening Tabula Room View for room ${status.roomId}.`,
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_share_document",
    {
      title: "Share Tabula Document",
      description:
        "Export a local Tabula.md App document as an encrypted Tabula.md room link. The room key stays in the URL fragment, and the room server receives only an encrypted snapshot.",
      inputSchema: {
        ...optionalDocumentSchema,
        appOrigin: z
          .string()
          .url()
          .optional()
          .describe("Tabula.md app origin for the returned share URL. Defaults to https://tabula.md."),
        roomServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula Room service URL. Defaults from appOrigin or TABULA_ROOM_URL."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {},
      },
    },
    async ({ documentId, appOrigin, roomServerUrl }) =>
      runStructuredTool(async () => {
        const document = await documents.get(documentId);
        const sharedDocument = await shareMarkdownDocument({
          title: document.title,
          markdown: document.markdown,
          appOrigin,
          roomServerUrl,
        });

        return {
          value: {
            share: sharedDocument,
          },
          text: [
            `Encrypted Tabula.md share link for "${document.title}":`,
            sharedDocument.shareUrl,
            "",
            "Treat this URL as a bearer secret because the #key fragment can decrypt the room.",
          ].join("\n"),
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
        value: await readDocumentSnapshot(documents, documentId),
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
