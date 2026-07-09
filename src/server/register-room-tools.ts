import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, errorContent } from "../json.js";
import {
  connectRoomOutputShape,
  createWorkspaceOutputShape,
  createWorkspaceRoomOutputShape,
  disconnectRoomOutputShape,
  listSessionsOutputShape,
  proposeWorkspaceChangesOutputShape,
  readWorkspaceDocumentOutputShape,
  readWorkspaceOutputShape,
  roomStatusOutputShape,
  setPresenceOutputShape,
  shareWorkspaceOutputShape,
  waitForChangesOutputShape,
} from "../output-schemas.js";
import { parseRoomShareUrl, resolveRoomServerUrl } from "../protocol.js";
import type { SessionRegistry } from "../registry.js";
import { TabulaRoomClient } from "../room-client.js";
import type { RoomCapability } from "../room-events.js";
import { createRoomShareUrl, generateRoomId, generateRoomKey, shareMarkdownWorkspace } from "../share.js";
import {
  readStoredWorkspace,
  readStoredWorkspaceDocument,
  withWorkspaceRoomId,
  workspaceShareFiles,
  type WorkspaceRegistry,
} from "../workspaces.js";

const optionalSessionSchema = {
  sessionId: z.string().uuid().optional().describe("Session id returned by tabula_connect_room. Defaults to the latest session."),
};

const optionalWorkspaceSchema = {
  workspaceId: z.string().uuid().optional().describe("Workspace id returned by tabula_create_workspace or tabula_import_markdown_workspace."),
};

const optionalWorkspaceOrSessionSchema = {
  ...optionalSessionSchema,
  ...optionalWorkspaceSchema,
};

const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 hex value returned by tabula_read_workspace_document or tabula_room_status.");

const workspaceFileInputSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative Markdown path, for example docs/README.md."),
  title: z.string().min(1).max(200).optional().describe("Optional display title. Defaults to the file basename."),
  markdown: z.string().describe("Markdown content for this workspace document."),
});

const workspacePublisherCapabilities = [
  "presence",
  "read",
  "propose",
  "comment",
  "write",
  "create",
  "delete",
  "move",
] as const satisfies readonly RoomCapability[];

const textPatchInputSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  insert: z.string(),
});

const workspaceChangeInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("document.patch"),
    documentId: z.string().min(1),
    baseSha256: sha256HexSchema,
    patches: z.array(textPatchInputSchema).min(1),
  }),
  z.object({
    type: z.literal("document.create"),
    parentId: z.string().min(1).nullable(),
    title: z.string().min(1).max(200),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("document.rename"),
    documentId: z.string().min(1),
    title: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("document.move"),
    documentId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("document.delete"),
    documentId: z.string().min(1),
    baseSha256: sha256HexSchema.optional(),
  }),
]);

const runTool = async (handler: () => Promise<unknown>) => {
  try {
    return jsonContent(await handler());
  } catch (error) {
    return errorContent(error);
  }
};

const readWorkspaceFromSelector = async (
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  { sessionId, workspaceId }: { sessionId?: string; workspaceId?: string },
) => {
  if (workspaceId) {
    return readStoredWorkspace(workspaces.get(workspaceId));
  }
  if (sessionId) {
    return registry.get(sessionId).readWorkspace();
  }
  if (workspaces.has()) {
    return readStoredWorkspace(workspaces.get());
  }
  return registry.get().readWorkspace();
};

const readWorkspaceDocumentFromSelector = async (
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  { sessionId, workspaceId, documentId }: { sessionId?: string; workspaceId?: string; documentId: string },
) => {
  if (workspaceId) {
    return readStoredWorkspaceDocument(workspaces.get(workspaceId), documentId);
  }
  if (sessionId) {
    return registry.get(sessionId).readWorkspaceDocument({ documentId });
  }
  if (workspaces.has()) {
    return readStoredWorkspaceDocument(workspaces.get(), documentId);
  }
  return registry.get().readWorkspaceDocument({ documentId });
};

export const registerRoomTools = (
  server: McpServer,
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  { writeEnabled }: { writeEnabled: boolean },
) => {
  server.registerTool(
    "tabula_create_workspace",
    {
      description:
        "Create a local Tabula workspace in this MCP session from zero or more inline Markdown files. Use tabula_create_workspace_room to turn it into a live room or tabula_share_workspace to export it.",
      inputSchema: {
        title: z.string().min(1).max(120).optional().describe("Optional workspace title."),
        files: z.array(workspaceFileInputSchema).optional().describe("Optional initial Markdown files."),
      },
      outputSchema: createWorkspaceOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, files }) =>
      runTool(async () => readStoredWorkspace(await workspaces.create({ title, files: files ?? [] }))),
  );

  server.registerTool(
    "tabula_import_markdown_workspace",
    {
      description:
        "Import Markdown into a local Tabula workspace from either this MCP server's filesystem or an inline files array. Filesystem paths are resolved where the MCP server is running.",
      inputSchema: {
        title: z.string().min(1).max(120).optional().describe("Optional workspace title."),
        source: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("local-path"),
            rootPath: z.string().min(1).describe("Directory path visible to the MCP server."),
            maxFiles: z.number().int().min(1).max(1000).default(200),
            excludeDirectories: z
              .array(z.string().min(1))
              .optional()
              .describe("Directory names to skip. Defaults include node_modules, .git, dist, build, and cache folders."),
          }),
          z.object({
            type: z.literal("files"),
            files: z.array(workspaceFileInputSchema).min(1).describe("Inline Markdown files for hosted or local MCP clients."),
          }),
        ]),
      },
      outputSchema: createWorkspaceOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, source }) =>
      runTool(async () => {
        if (source.type === "local-path") {
          return readStoredWorkspace(
            await workspaces.importMarkdown({
              title,
              rootPath: source.rootPath,
              maxFiles: source.maxFiles,
              excludeDirectories: source.excludeDirectories,
            }),
          );
        }

        return readStoredWorkspace(await workspaces.create({ title, files: source.files, source: "imported" }));
      }),
  );

  server.registerTool(
    "tabula_share_workspace",
    {
      description:
        "Export a local/imported Tabula workspace as an encrypted Tabula.md #json snapshot link. The JSON snapshot service receives only encrypted bytes.",
      inputSchema: {
        ...optionalWorkspaceSchema,
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
      outputSchema: shareWorkspaceOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, appOrigin, jsonServerUrl }) =>
      runTool(async () => {
        const workspace = workspaces.get(workspaceId);
        return {
          workspaceId: workspace.workspaceId,
          share: await shareMarkdownWorkspace({
            title: workspace.title,
            files: workspaceShareFiles(workspace),
            activeFileId: workspace.workspace.activeDocumentId,
            appOrigin,
            jsonServerUrl,
          }),
        };
      }),
  );

  server.registerTool(
    "tabula_create_workspace_room",
    {
      description:
        "Create a new encrypted Tabula.md live workspace room from a local/imported MCP workspace, publish initial workspace state, and return a shareable #room URL.",
      inputSchema: {
        ...optionalWorkspaceSchema,
        appOrigin: z.string().url().default("https://tabula.md").describe("Tabula.md app origin for the returned #room URL."),
        roomServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula Room service URL. Can also be set with TABULA_ROOM_URL."),
        identityName: z.string().min(1).max(40).optional().describe("Presence name shown to collaborators."),
        identityColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Presence color as a hex value."),
      },
      outputSchema: createWorkspaceRoomOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, appOrigin, roomServerUrl, identityName, identityColor }) =>
      runTool(async () => {
        const workspace = workspaces.get(workspaceId);
        const roomId = generateRoomId();
        const roomKey = generateRoomKey();
        const roomUrl = createRoomShareUrl({ appOrigin, roomId, roomKey });
        const parsedRoom = parseRoomShareUrl(roomUrl);
        const resolvedRoomServerUrl = resolveRoomServerUrl({
          appOrigin: parsedRoom.appOrigin,
          roomServerUrl,
        });
        const roomWorkspace = withWorkspaceRoomId(workspace, roomId);
        workspaces.add(roomWorkspace);

        const client = new TabulaRoomClient({
          parsedRoom,
          roomServerUrl: resolvedRoomServerUrl,
          writeAccess: false,
          identityName,
          identityColor,
          actorCapabilities: workspacePublisherCapabilities,
        });
        let recoveryStatus: Awaited<ReturnType<TabulaRoomClient["connect"]>>;
        let published: Awaited<ReturnType<TabulaRoomClient["publishWorkspaceSnapshot"]>>;
        try {
          recoveryStatus = await client.connect();
          published = await client.publishWorkspaceSnapshot({
            workspace: roomWorkspace.workspace,
            documents: roomWorkspace.documents,
          });
        } catch (error) {
          client.disconnect();
          throw error;
        }
        registry.add(client);
        const status = await client.getStatus();

        return {
          ...status,
          workspaceId: roomWorkspace.workspaceId,
          roomUrl,
          recoveryStatus,
          published,
          note:
            "Created a Tabula workspace room and published encrypted workspace.updated plus document-scoped text.updated room events. Continue with proposal-first workspace tools for edits.",
        };
      }),
  );

  server.registerTool(
    "tabula_connect_room",
    {
      description:
        "Connect this local MCP process to an encrypted Tabula.md live room URL. The #room fragment contains the room key, is used locally, and is never sent to the room server.",
      inputSchema: {
        roomUrl: z.string().url().describe("Full Tabula room invite URL, including /#room=<roomId>,<roomKey>."),
        roomServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula Room service URL. Can also be set with TABULA_ROOM_URL."),
        identityName: z.string().min(1).max(40).optional().describe("Presence name shown to collaborators."),
        identityColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Presence color as a hex value."),
      },
      outputSchema: connectRoomOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ roomUrl, roomServerUrl, identityName, identityColor }) =>
      runTool(async () => {
        const parsedRoom = parseRoomShareUrl(roomUrl);
        const resolvedRoomServerUrl = resolveRoomServerUrl({
          appOrigin: parsedRoom.appOrigin,
          roomServerUrl,
        });
        const client = new TabulaRoomClient({
          parsedRoom,
          roomServerUrl: resolvedRoomServerUrl,
          writeAccess: writeEnabled,
          identityName,
          identityColor,
        });
        const recoveryStatus = await client.connect();
        registry.add(client);
        const status = await client.getStatus();
        const hydrationNote =
          status.hydrationStatus === "ready"
            ? "Room state has been received."
            : "Room content is relay-only and may remain empty until a live peer sends state-init/yjs-update.";

        return {
          ...status,
          recoveryStatus,
          note: writeEnabled
            ? `Connected with server-level write capability. ${hydrationNote} Use tabula_read_workspace, tabula_read_workspace_document, and tabula_propose_workspace_changes for reviewable agent edits.`
            : `Connected as a proposal-first agent. ${hydrationNote} Use tabula_read_workspace, tabula_read_workspace_document, and tabula_propose_workspace_changes for reviewable edits.`,
        };
      }),
  );

  server.registerTool(
    "tabula_list_sessions",
    {
      description: "List Tabula room sessions currently connected in this MCP process.",
      inputSchema: {},
      outputSchema: listSessionsOutputShape,
      annotations: {
        readOnlyHint: true,
      },
    },
    async () =>
      runTool(async () => ({
        sessions: await Promise.all(registry.list().map((session) => session.getStatus())),
      })),
  );

  server.registerTool(
    "tabula_room_status",
    {
      description: "Return connection, metadata, collaborator, hash, and write-access state for a connected Tabula room.",
      inputSchema: optionalSessionSchema,
      outputSchema: roomStatusOutputShape,
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ sessionId }) => runTool(async () => registry.get(sessionId).getStatus()),
  );

  server.registerTool(
    "tabula_read_workspace",
    {
      description:
        "Read decrypted Tabula workspace tree metadata from a connected room session or a local/imported MCP workspace.",
      inputSchema: optionalWorkspaceOrSessionSchema,
      outputSchema: readWorkspaceOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, workspaceId }) => runTool(async () => readWorkspaceFromSelector(registry, workspaces, { sessionId, workspaceId })),
  );

  server.registerTool(
    "tabula_read_workspace_document",
    {
      description:
        "Read decrypted Markdown for one document from a connected room session or local/imported MCP workspace. Use tabula_read_workspace first to get document ids.",
      inputSchema: {
        ...optionalWorkspaceOrSessionSchema,
        documentId: z.string().min(1).describe("Workspace document id from tabula_read_workspace."),
      },
      outputSchema: readWorkspaceDocumentOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, workspaceId, documentId }) =>
      runTool(async () => readWorkspaceDocumentFromSelector(registry, workspaces, { sessionId, workspaceId, documentId })),
  );

  server.registerTool(
    "tabula_propose_workspace_changes",
    {
      description:
        "Propose one or more workspace document changes as an encrypted workspace.proposal.created room-event. This can patch, create, rename, move, or delete documents and does not directly mutate the room.",
      inputSchema: {
        ...optionalSessionSchema,
        title: z.string().min(1).max(120).optional().describe("Short human-readable proposal title."),
        description: z.string().min(1).max(2000).optional().describe("Optional rationale or summary for collaborators."),
        changes: z
          .array(workspaceChangeInputSchema)
          .min(1)
          .describe("Workspace changes to submit together in one proposal."),
      },
      outputSchema: proposeWorkspaceChangesOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, title, description, changes }) =>
      runTool(async () => registry.get(sessionId).proposeWorkspaceChanges({ title, description, changes })),
  );

  server.registerTool(
    "tabula_set_presence",
    {
      description: "Publish this MCP client's current cursor/selection presence to collaborators.",
      inputSchema: {
        ...optionalSessionSchema,
        fileTitle: z.string().min(1).max(120).optional(),
        selection: z
          .object({
            documentId: z.string().min(1).optional(),
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
          })
          .optional(),
      },
      outputSchema: setPresenceOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, selection, fileTitle }) =>
      runTool(async () => registry.get(sessionId).setPresence(selection, fileTitle)),
  );

  server.registerTool(
    "tabula_wait_for_changes",
    {
      description:
        "Wait for a connected room's Markdown hash to differ from sinceSha256 or for an encrypted room event such as a patch proposal, then return the latest Markdown.",
      inputSchema: {
        ...optionalSessionSchema,
        sinceSha256: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(0).max(30_000).default(15_000),
      },
      outputSchema: waitForChangesOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, sinceSha256, timeoutMs }) =>
      runTool(async () => registry.get(sessionId).waitForChange(sinceSha256, timeoutMs)),
  );

  server.registerTool(
    "tabula_disconnect_room",
    {
      description: "Disconnect one connected Tabula room session.",
      inputSchema: optionalSessionSchema,
      outputSchema: disconnectRoomOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runTool(async () => ({
        disconnectedSessionId: registry.remove(sessionId),
      })),
  );
};
