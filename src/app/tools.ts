import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentRegistry } from "../documents/registry.js";
import { inferDocumentTitle } from "../documents/snapshot.js";
import type { RuntimeEnvironment } from "../env.js";
import { errorContent } from "../json.js";
import type { SessionRegistry } from "../registry.js";
import { startWorkspaceRoom } from "../room-session.js";
import { shareMarkdownDocument } from "../share.js";
import { createWorkspaceFromFiles } from "../workspaces.js";
import {
  documentSnapshotContent,
  readDocumentSnapshot,
  readRoomSnapshot,
  summarizeRoomStatus,
} from "./snapshots.js";

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
  options: {
    allowRoomTools?: boolean;
    allowTemporaryRooms?: boolean;
    writeEnabled?: boolean;
    env?: RuntimeEnvironment;
    resourceUri: string;
  },
) => {
  const allowRoomTools = options.allowRoomTools ?? true;
  const writeEnabled = options.writeEnabled ?? true;
  const resourceUri = options.resourceUri;

  const roomCard = (
    room: Record<string, unknown>,
    { agentConnected }: { agentConnected: boolean },
  ) => ({
    ...room,
    agentConnected,
  });

  const readAgentRoomCard = async (sessionId: string) => {
    const snapshot = await readRoomSnapshot(registry, sessionId);
    return {
      ...snapshot,
      room: roomCard(snapshot.room, {
        agentConnected: true,
      }),
    };
  };

  registerAppTool(
    server,
    "tabula_create_document",
    {
      title: "Create Tabula Document",
      description:
        "Create a Markdown document in the current writable Tabula session, or a private local draft when Claude is not connected to a session. Open a compact handoff card.",
      inputSchema: {
        title: z.string().min(1).max(120).optional().describe("Optional document title. Defaults to the first H1 or Untitled Document."),
        markdown: z.string().default("").describe("Initial Markdown content for the document checkpoint."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri,
        },
      },
    },
    async ({ title, markdown }) =>
      runStructuredTool(async () => {
        if (registry.has()) {
          const session = registry.get();
          const status = await session.getStatus();
          if (!status.writeAccess) {
            throw new Error("This Tabula MCP connection was started with --read-only. Restart without --read-only before changing the shared workspace.");
          }

          const documentTitle = inferDocumentTitle(title, markdown);
          const changed = await session.applyWorkspaceChanges({
            changes: [{ type: "document.create", parentId: null, title: documentTitle, markdown }],
          });
          const createdDocumentId = changed.changedDocumentIds[0];
          const room = await readAgentRoomCard(status.sessionId);

          return {
            value: {
              ...room,
              createdDocumentId,
              resourceUri,
            },
            text: `Created "${documentTitle}" in the current Tabula session.`,
          };
        }

        const document = await documents.create({ title, markdown });

        return {
          value: {
            ...documentSnapshotContent(document),
            resourceUri,
          },
          text: `Created local Tabula.md draft "${document.title}".`,
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_update_document",
    {
      title: "Update Tabula Document",
      description:
        "Update the latest or selected private Tabula Markdown draft. To change a connected shared session, use tabula_apply_workspace_changes.",
      inputSchema: {
        ...optionalDocumentSchema,
        title: z.string().min(1).max(120).optional().describe("Optional new document title."),
        markdown: z.string().describe("Replacement Markdown for the private draft."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri,
        },
      },
    },
    async ({ documentId, title, markdown }) =>
      runStructuredTool(async () => {
        const current = await documents.get(documentId);
        const document = await documents.update({ documentId: current.documentId, title, markdown });
        return {
          value: {
            ...documentSnapshotContent(document),
            resourceUri,
          },
          text: `Updated private Tabula.md draft "${document.title}".`,
        };
      }),
  );

  if (allowRoomTools) {
    registerAppTool(
      server,
      "tabula_app_start_room_from_document",
      {
        title: "Start Tabula Session",
        description:
          "Turn a private Tabula draft into an encrypted live session and connect Claude as a collaborator. A configured checkpoint makes the session durable; otherwise it stays available while a participant remains connected.",
        inputSchema: {
          ...optionalDocumentSchema,
          appOrigin: z.string().url().default("https://tabula.md").describe("Tabula.md app origin for the returned #room URL."),
          roomServerUrl: z.string().url().optional().describe("Tabula Room service URL. Can also be set with TABULA_ROOM_URL."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
      },
      async ({ documentId, appOrigin, roomServerUrl }) =>
        runStructuredTool(async () => {
          const document = await documents.get(documentId);
          const workspace = await createWorkspaceFromFiles({
            title: document.title,
            files: [{ path: document.title || "Untitled.md", title: document.title, markdown: document.markdown }],
          });
          const started = await startWorkspaceRoom({
            registry,
            workspace,
            env: options.env,
            appOrigin,
            roomServerUrl,
            allowTemporary: options.allowTemporaryRooms,
            writeAccess: writeEnabled,
          });
          const room = await readAgentRoomCard(started.sessionId);

          return {
            value: {
              ...room,
              resourceUri,
            },
            text: "Started a Tabula session. Claude is connected to the shared workspace.",
          };
        }),
    );
  }

  registerAppTool(
    server,
    "tabula_list_documents",
    {
      title: "List Tabula Documents",
      description:
        "List Tabula.md MCP App document checkpoints saved in this MCP server's document checkpoint store, newest first.",
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
            ? `Found ${localDocuments.length} Tabula.md document checkpoint(s).`
            : "No Tabula.md document checkpoints found.",
        };
      }),
  );

  registerAppTool(
    server,
    "tabula_open_document",
    {
      title: "Open Tabula Document",
      description:
        "Open a compact Tabula.md handoff card for the latest or selected local checkpoint. The actual editing surface opens in Tabula.md.",
      inputSchema: optionalDocumentSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri,
        },
      },
    },
    async ({ documentId }) =>
      runStructuredTool(async () => {
        const document = await documents.get(documentId);

        return {
          value: {
            ...documentSnapshotContent(document),
            resourceUri,
          },
          text: `Opening Tabula.md document checkpoint "${document.title}".`,
        };
      }),
  );

  if (allowRoomTools) {
    registerAppTool(
    server,
    "tabula_open_room_view",
    {
        title: "Open Tabula Room View",
        description:
          "Open a compact handoff card for a connected Tabula.md room. Open session to continue in the actual Tabula.md collaboration surface.",
        inputSchema: optionalSessionSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: {
          ui: {
            resourceUri,
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
              room: roomCard(room, {
                agentConnected: true,
              }),
              resourceUri,
            },
            text: `Opening Tabula Room View for room ${status.roomId}.`,
          };
        }),
    );
  }

  registerAppTool(
    server,
    "tabula_share_document",
    {
      title: "Share Tabula Document",
      description:
        "Export a Tabula.md MCP App document checkpoint as an encrypted Tabula.md snapshot link. The snapshot key stays in the URL fragment, and the JSON snapshot service receives only encrypted bytes.",
      inputSchema: {
        ...optionalDocumentSchema,
        appOrigin: z
          .string()
          .url()
          .optional()
          .describe("Tabula.md app origin for the returned share URL. Defaults to https://tabula.md."),
        jsonServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula JSON snapshot service URL. Defaults from appOrigin or TABULA_JSON_URL."),
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
    async ({ documentId, appOrigin, jsonServerUrl }) =>
      runStructuredTool(async () => {
        const document = await documents.get(documentId);
        const sharedDocument = await shareMarkdownDocument({
          title: document.title,
          markdown: document.markdown,
          appOrigin,
          jsonServerUrl,
        });

        return {
          value: {
            share: sharedDocument,
          },
          text: [
            `Encrypted Tabula.md snapshot link for "${document.title}":`,
            sharedDocument.shareUrl,
            "",
            "Treat this URL as a bearer secret because the #json fragment contains the snapshot key.",
          ].join("\n"),
        };
      }),
  );

  if (allowRoomTools) {
    registerAppTool(
      server,
      "tabula_app_room_snapshot",
      {
        title: "Read Tabula Room App Snapshot",
        description: "Read a connected room snapshot for the Tabula Document MCP App.",
        inputSchema: optionalSessionSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
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
  }

  registerAppTool(
    server,
    "tabula_app_document_snapshot",
    {
      title: "Read Tabula Document App Snapshot",
      description: "Read a document checkpoint snapshot for the Tabula Document MCP App.",
      inputSchema: optionalDocumentSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
      title: "Save Tabula Document",
      description: "Save the current Markdown for a local Tabula Document MCP App document.",
      inputSchema: {
        documentId: z.string().uuid().describe("Document id returned by tabula_create_document."),
        title: z.string().min(1).max(120).optional().describe("Optional updated document title."),
        markdown: z.string().describe("Full Markdown content to keep in the MCP App document checkpoint."),
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
        text: "Tabula document saved in the MCP document checkpoint store.",
      })),
  );
};
