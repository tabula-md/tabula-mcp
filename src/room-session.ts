import type { RuntimeEnvironment } from "./env.js";
import { TabulaCoreError } from "./core-errors.js";
import { parseRoomShareUrl, resolveRoomServerUrl } from "./protocol.js";
import type { SessionRegistry } from "./registry.js";
import { createFirebaseWorkspaceRoomCheckpointStore } from "./room-checkpoints.js";
import { TabulaRoomClient } from "./room-client.js";
import { createRoomShareUrl, generateRoomId, generateRoomKey } from "./share.js";
import { withWorkspaceRoomId, type StoredWorkspace } from "./workspaces.js";
import { abortableOperation, markOperationCommitted, throwIfOperationAborted } from "./server/operation-context.js";

export const startWorkspaceRoom = async ({
  registry,
  workspace,
  env,
  appOrigin = "https://tabula.md",
  roomServerUrl,
  identityId,
  identityName,
  identityColor,
  allowTemporary = true,
  writeAccess = true,
}: {
  registry: SessionRegistry;
  workspace: StoredWorkspace;
  env?: RuntimeEnvironment;
  appOrigin?: string;
  roomServerUrl?: string;
  identityId?: string;
  identityName?: string;
  identityColor?: string;
  /** Temporary Rooms must remain attached to a local, stateful MCP process. */
  allowTemporary?: boolean;
  /** Read-only servers may join existing Rooms but cannot publish a new one. */
  writeAccess?: boolean;
}) => {
  if (!writeAccess) {
    throw new TabulaCoreError(
      "write_disabled",
      "This Tabula MCP server is read-only and cannot start a live session.",
      { retry: "Restart Tabula MCP without --read-only, then start the session again." },
    );
  }
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
    throw new TabulaCoreError(
      "write_failed",
      "Hosted Tabula MCP can start a live session only when encrypted room persistence is configured. Use a local MCP client for a temporary session, or configure TABULA_MCP_FIREBASE_CONFIG.",
      {
        details: { reason: "room_persistence_unavailable" },
        retry: "Use local Tabula MCP for a temporary session, or configure encrypted Room persistence.",
      },
    );
  }
  const client = new TabulaRoomClient({
    parsedRoom,
    roomServerUrl: resolvedRoomServerUrl,
    writeAccess,
    identityId,
    identityName,
    identityColor,
    roomCheckpointStore,
  });
  await registry.reserve(client.sessionId);
  let committed = false;

  try {
    throwIfOperationAborted();
    const published = await client.publishWorkspaceSnapshot({
      workspace: roomWorkspace.workspace,
      documents: roomWorkspace.documents,
      persistCheckpoint: false,
    });
    throwIfOperationAborted();
    const recoveryStatus = await abortableOperation(client.connect(), () => client.disconnect());
    throwIfOperationAborted();
    const status = await client.getStatus();
    throwIfOperationAborted();
    registry.add(client);
    committed = true;
    markOperationCommitted("start_session");
    const checkpoint = await client.persistCheckpointAfterMutation();
    const temporary = status.recoveryMode === "temporary";

    return {
      ...status,
      workspaceId: workspace.workspaceId,
      roomUrl,
      recoveryStatus,
      published,
      checkpointPending: checkpoint === "pending",
      note: temporary
        ? "Started a temporary Tabula session. It stays available while this Claude window or another participant remains connected. Claude is connected as a collaborator."
        : "Started a durable Tabula session with an encrypted room checkpoint. Claude is connected as a collaborator.",
    };
  } catch (error) {
    if (!committed) client.disconnect();
    if (!committed) await registry.cancelReservation(client.sessionId);
    throw error;
  }
};
