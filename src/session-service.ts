import type { RuntimeEnvironment } from "./env.js";
import { parseRoomShareUrl, resolveRoomServerUrl } from "./protocol.js";
import type { SessionRegistry } from "./registry.js";
import { createFirebaseWorkspaceRoomCheckpointStore } from "./room-checkpoints.js";
import { TabulaRoomClient } from "./room-client.js";
import { startWorkspaceRoom } from "./room-session.js";
import type { StoredWorkspace } from "./workspaces.js";

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
  const parsedRoom = parseRoomShareUrl(roomUrl);
  const roomServerUrl = resolveRoomServerUrl({
    appOrigin: parsedRoom.appOrigin,
    ...(env ? { env } : {}),
  });
  const client = new TabulaRoomClient({
    parsedRoom,
    roomServerUrl,
    writeAccess: writeEnabled,
    roomCheckpointStore: createFirebaseWorkspaceRoomCheckpointStore(env),
  });
  try {
    await client.connect({ waitForStateMs: 10_000 });
    registry.add(client);
    return summarizeSession(client);
  } catch (error) {
    client.disconnect();
    throw error;
  }
};

export const startDraftSession = async ({
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
  const client = registry.get(started.sessionId);
  return {
    ...(await summarizeSession(client)),
    sessionUrl: started.roomUrl,
  };
};
