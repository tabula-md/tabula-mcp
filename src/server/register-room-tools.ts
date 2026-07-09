import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, errorContent } from "../json.js";
import {
  connectRoomOutputShape,
  disconnectRoomOutputShape,
  listSessionsOutputShape,
  proposeWorkspaceChangesOutputShape,
  readWorkspaceDocumentOutputShape,
  readWorkspaceOutputShape,
  roomStatusOutputShape,
  setPresenceOutputShape,
  waitForChangesOutputShape,
} from "../output-schemas.js";
import { parseRoomShareUrl, resolveRoomServerUrl } from "../protocol.js";
import type { SessionRegistry } from "../registry.js";
import { TabulaRoomClient } from "../room-client.js";

const optionalSessionSchema = {
  sessionId: z.string().uuid().optional().describe("Session id returned by tabula_connect_room. Defaults to the latest session."),
};

const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 hex value returned by tabula_read_workspace_document or tabula_room_status.");

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

export const registerRoomTools = (
  server: McpServer,
  registry: SessionRegistry,
  { writeEnabled }: { writeEnabled: boolean },
) => {
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
        "Read the latest decrypted Tabula workspace tree metadata received by this MCP session, including document ids, titles, hashes, and which document bodies are cached locally.",
      inputSchema: optionalSessionSchema,
      outputSchema: readWorkspaceOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId }) => runTool(async () => registry.get(sessionId).readWorkspace()),
  );

  server.registerTool(
    "tabula_read_workspace_document",
    {
      description:
        "Read decrypted Markdown for one workspace document that this MCP session has received. Use tabula_read_workspace first to get document ids and cached status.",
      inputSchema: {
        ...optionalSessionSchema,
        documentId: z.string().min(1).describe("Workspace document id from tabula_read_workspace."),
      },
      outputSchema: readWorkspaceDocumentOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, documentId }) => runTool(async () => registry.get(sessionId).readWorkspaceDocument({ documentId })),
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
