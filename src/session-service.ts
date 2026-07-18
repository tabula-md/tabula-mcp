import type { RuntimeEnvironment } from "./env.js";
import { TabulaCoreError } from "./core-errors.js";
import { parseRoomShareUrl, resolveRoomServerUrl } from "./protocol.js";
import type { SessionRegistry } from "./registry.js";
import { createFirebaseWorkspaceRoomCheckpointStore } from "./room-checkpoints.js";
import { TabulaRoomClient } from "./room-client.js";
import { startWorkspaceRoom } from "./room-session.js";
import type { StoredWorkspace } from "./workspaces.js";
import { abortableOperation, markOperationCommitted, throwIfOperationAborted } from "./server/operation-context.js";

const summarizeSession = async (client: TabulaRoomClient) => {
  const status = await client.getStatus();
  const workspace = status.stateReceived ? await client.readWorkspace() : null;
  return {
    sessionId: status.sessionId,
    ready: status.stateReceived,
    canWrite: status.writeAccess,
    fileCount: workspace?.documents.length ?? 0,
    otherCollaboratorCount: status.collaborators.length,
  };
};

export const joinRoomSession = async ({
  registry,
  roomUrl,
  env,
  writeEnabled,
}: {
  registry: SessionRegistry;
  roomUrl: string;
  env?: RuntimeEnvironment;
  writeEnabled: boolean;
}) => {
  let parsedRoom: ReturnType<typeof parseRoomShareUrl>;
  try {
    parsedRoom = parseRoomShareUrl(roomUrl);
  } catch (error) {
    throw new TabulaCoreError("invalid_input", "The supplied URL is not a valid private Tabula room URL.", {
      details: {
        expected: "https://tabula.md/#room=<room-id>,<room-key>",
        reason: error instanceof Error ? error.message : "Invalid room URL.",
      },
      retry: "Use the complete #room URL copied from Tabula and keep it private.",
    });
  }
  const roomServerUrl = resolveRoomServerUrl({
    appOrigin: parsedRoom.appOrigin,
    ...(env ? { env } : {}),
  });
  const existing = registry.findByShareUrl(parsedRoom.shareUrl);
  if (existing) return { ...await summarizeSession(existing), reused: true };
  const client = new TabulaRoomClient({
    parsedRoom,
    roomServerUrl,
    writeAccess: writeEnabled,
    roomCheckpointStore: createFirebaseWorkspaceRoomCheckpointStore(env),
  });
  await registry.reserve(client.sessionId);
  let registered = false;
  try {
    throwIfOperationAborted();
    await abortableOperation(client.connect({ waitForStateMs: 30_000 }), () => client.disconnect());
    throwIfOperationAborted();
    const session = await summarizeSession(client);
    throwIfOperationAborted();
    if (!session.ready) {
      throw new TabulaCoreError("session_not_ready", "The Tabula session connected but its workspace state has not arrived.", {
        retry: "Keep the Tabula room open and join it again after its workspace state is available.",
      });
    }
    registry.add(client);
    registered = true;
    markOperationCommitted("join_room");
    return { ...session, reused: false };
  } catch (error) {
    if (registered) {
      await registry.leave(client.sessionId);
    } else {
      client.disconnect();
      await registry.cancelReservation(client.sessionId);
    }
    throw error;
  }
};

export const startWorkspaceSession = async ({
  registry,
  workspace,
  env,
  writeEnabled,
  allowTemporaryRooms,
}: {
  registry: SessionRegistry;
  workspace: StoredWorkspace;
  env?: RuntimeEnvironment;
  writeEnabled: boolean;
  allowTemporaryRooms: boolean;
}) => {
  const started = await startWorkspaceRoom({
    registry,
    workspace,
    env,
    appOrigin: env?.TABULA_APP_ORIGIN?.trim() || "https://tabula.md",
    allowTemporary: allowTemporaryRooms,
    writeAccess: writeEnabled,
  });
  return {
    sessionId: started.sessionId,
    ready: started.stateReceived,
    canWrite: started.writeAccess,
    fileCount: started.published.emittedDocumentCount,
    otherCollaboratorCount: started.collaborators.length,
    sessionUrl: started.roomUrl,
    applied: true as const,
    persisted: !started.checkpointPending && started.recoveryMode !== "temporary",
    checkpointPending: started.checkpointPending,
  };
};
