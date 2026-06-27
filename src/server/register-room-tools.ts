import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent, errorContent } from "../json.js";
import {
  applyTextPatchesOutputShape,
  connectRoomOutputShape,
  disconnectRoomOutputShape,
  listSessionsOutputShape,
  outlineOutputShape,
  readMarkdownOutputShape,
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
        "Connect this local MCP process to an encrypted Tabula.md live room URL. The #key fragment is used locally and is never sent to the room server.",
      inputSchema: {
        roomUrl: z.string().url().describe("Full Tabula room invite URL, including /r/:roomId#key=..."),
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
        const snapshotStatus = await client.connect();
        registry.add(client);
        const status = await client.getStatus();

        return {
          ...status,
          snapshotStatus,
          note: writeEnabled
            ? "Connected with server-level write access. Use tabula_apply_text_patches with a current base hash."
            : "Connected read-only. Restart tabula-mcp with TABULA_MCP_ENABLE_WRITE=1 or --enable-write to edit.",
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
    "tabula_read_markdown",
    {
      description: "Read the current decrypted Markdown text from a connected Tabula room.",
      inputSchema: optionalSessionSchema,
      outputSchema: readMarkdownOutputShape,
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ sessionId }) => runTool(async () => registry.get(sessionId).readMarkdown()),
  );

  server.registerTool(
    "tabula_get_outline",
    {
      description: "Return Markdown headings for the current room text.",
      inputSchema: optionalSessionSchema,
      outputSchema: outlineOutputShape,
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ sessionId }) => runTool(async () => registry.get(sessionId).getOutline()),
  );

  if (writeEnabled) {
    server.registerTool(
      "tabula_apply_text_patches",
      {
        description:
          "Apply non-overlapping text patches to a connected Tabula room. Requires server-level write mode and a current baseSha256.",
        inputSchema: {
          ...optionalSessionSchema,
          baseSha256: z.string().min(1).describe("sha256 value returned by tabula_read_markdown or tabula_room_status."),
          patches: z
            .array(
              z.object({
                from: z.number().int().nonnegative(),
                to: z.number().int().nonnegative(),
                insert: z.string(),
              }),
            )
            .min(1)
            .describe("Patches in old-document character offsets. They must not overlap."),
        },
        outputSchema: applyTextPatchesOutputShape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ sessionId, baseSha256, patches }) =>
        runTool(async () => registry.get(sessionId).applyPatches({ baseSha256, patches })),
    );
  }

  server.registerTool(
    "tabula_set_presence",
    {
      description: "Publish this MCP client's current cursor/selection presence to collaborators.",
      inputSchema: {
        ...optionalSessionSchema,
        fileTitle: z.string().min(1).max(120).optional(),
        selection: z
          .object({
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
        "Wait for a connected room's Markdown hash to differ from sinceSha256, then return the latest Markdown.",
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
