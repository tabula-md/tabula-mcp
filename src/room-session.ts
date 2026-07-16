import type { RoomCapability } from "@tabula-md/tabula/collaboration";
import type { RuntimeEnvironment } from "./env.js";
import { TabulaMcpError, parseRoomShareUrl, resolveRoomServerUrl } from "./protocol.js";
import type { SessionRegistry } from "./registry.js";
import { createFirebaseWorkspaceRoomCheckpointStore } from "./room-checkpoints.js";
import { TabulaRoomClient } from "./room-client.js";
import { createRoomShareUrl, generateRoomId, generateRoomKey } from "./share.js";
import { withWorkspaceRoomId, type StoredWorkspace } from "./workspaces.js";

const workspacePublisherCapabilities = [
  "presence",
  "read",
  "write",
] as const satisfies readonly RoomCapability[];

export const startWorkspaceRoom = async ({
  registry,
  workspace,
  env,
  appOrigin = "https://tabula.md",
  roomServerUrl,
  identityName,
  identityColor,
  allowTemporary = true,
}: {
  registry: SessionRegistry;
  workspace: StoredWorkspace;
  env?: RuntimeEnvironment;
  appOrigin?: string;
  roomServerUrl?: string;
  identityName?: string;
  identityColor?: string;
  /** Temporary Rooms must remain attached to a local, stateful MCP process. */
  allowTemporary?: boolean;
}) => {
  const roomId = generateRoomId();
  const roomKey = generateRoomKey();
  const roomUrl = createRoomShareUrl({ appOrigin, roomId, roomKey });
  const parsedRoom = parseRoomShareUrl(roomUrl);
  const resolvedRoomServerUrl = resolveRoomServerUrl({
    appOrigin: parsedRoom.appOrigin,
    roomServerUrl,
    ...(env ? { env } : {}),
  });
  const roomWorkspace = withWorkspaceRoomId(workspace, roomId);
  const roomCheckpointStore = createFirebaseWorkspaceRoomCheckpointStore(env);
  if (!roomCheckpointStore.enabled && !allowTemporary) {
    throw new TabulaMcpError(
      "Hosted Tabula MCP can start a live session only when encrypted room persistence is configured. Use a local MCP client for a temporary session, or configure TABULA_MCP_FIREBASE_CONFIG.",
    );
  }
  const client = new TabulaRoomClient({
    parsedRoom,
    roomServerUrl: resolvedRoomServerUrl,
    writeAccess: false,
    identityName,
    identityColor,
    actorCapabilities: workspacePublisherCapabilities,
    roomCheckpointStore,
  });

  try {
    const published = await client.publishWorkspaceSnapshot({
      workspace: roomWorkspace.workspace,
      documents: roomWorkspace.documents,
    });
    const recoveryStatus = await client.connect();
    registry.add(client);
    const status = await client.getStatus();
    const temporary = status.recoveryMode === "temporary";

    return {
      ...status,
      workspaceId: workspace.workspaceId,
      roomUrl,
      recoveryStatus,
      published,
      note: temporary
        ? "Started a temporary Tabula session. Keep this MCP process or another participant connected; without an encrypted checkpoint, the room cannot be recovered after every participant leaves."
        : "Started a durable Tabula session with an encrypted room checkpoint. Continue through the connected Room session for all collaborative reads and edits.",
    };
  } catch (error) {
    client.disconnect();
    throw error;
  }
};
