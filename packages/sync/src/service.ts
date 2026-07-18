import "../../../src/node-runtime.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RuntimeEnvironment } from "../../../src/env.js";
import { sha256Text } from "../../../src/crypto.js";
import { TabulaCoreError } from "../../../src/core-errors.js";
import { parseRoomShareUrl } from "../../../src/protocol.js";
import { SessionRegistry } from "../../../src/registry.js";
import { joinRoomSession } from "../../../src/session-service.js";
import {
  createSessionDirectory,
  deleteSessionPath,
  listSessionFiles,
  moveSessionFile,
  readSessionFiles,
  writeSessionFiles,
} from "../../../src/workspace-file-service.js";
import {
  deleteLocalSyncFile,
  moveLocalSyncFile,
  readFolderSyncState,
  readLocalMarkdownFiles,
  writeFolderSyncState,
  writeLocalSyncFile,
  type FolderSyncState,
} from "./local.js";
import { planFolderSync, type SyncFile, type SyncPlan } from "./model.js";

const chunksOf = <T>(values: readonly T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const readRemoteMarkdownFiles = async (registry: SessionRegistry, sessionId: string): Promise<SyncFile[]> => {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listSessionFiles({ registry, sessionId, recursive: true, limit: 200, cursor });
    paths.push(...page.files.flatMap((entry) => entry.type === "file" ? [entry.path] : []));
    cursor = page.nextCursor;
  } while (cursor);

  const files: SyncFile[] = [];
  for (const pathsChunk of chunksOf(paths, 20)) {
    const result = await readSessionFiles({ registry, sessionId, paths: pathsChunk });
    files.push(...result.files.map((file) => ({
      path: file.path,
      content: file.content,
      revision: file.revision,
    })));
  }
  return files;
};

const createRoomFingerprint = async (roomUrl: string) => {
  const parsed = parseRoomShareUrl(roomUrl);
  return sha256Text(`${parsed.appOrigin}/${parsed.roomId}`);
};

export type FolderSyncSession = {
  registry: SessionRegistry;
  roomFingerprint: string;
  sessionId: string;
  close(): Promise<void>;
};

export const openFolderSyncSession = async ({
  roomUrl,
  env = {},
}: {
  roomUrl: string;
  env?: RuntimeEnvironment;
}): Promise<FolderSyncSession> => {
  const registry = new SessionRegistry({ maxSessions: 1 });
  try {
    const joined = await joinRoomSession({
      registry,
      roomUrl,
      env,
      writeEnabled: true,
      identity: {
        id: `tabula-sync-${randomUUID()}`,
        name: env.TABULA_MCP_ACTOR_NAME?.trim() || "Tabula Sync",
        ...(env.TABULA_MCP_ACTOR_COLOR?.trim() ? { color: env.TABULA_MCP_ACTOR_COLOR.trim() } : {}),
      },
    });
    return {
      registry,
      roomFingerprint: await createRoomFingerprint(roomUrl),
      sessionId: joined.sessionId,
      close: () => registry.clear(),
    };
  } catch (error) {
    await registry.clear();
    throw error;
  }
};

const applyRemotePlan = async (session: FolderSyncSession, plan: SyncPlan) => {
  for (const move of plan.remoteMoves) {
    const parent = path.posix.dirname(move.destination);
    if (parent !== ".") await createSessionDirectory({ registry: session.registry, sessionId: session.sessionId, path: parent });
    await moveSessionFile({ registry: session.registry, sessionId: session.sessionId, ...move });
  }
  for (const writes of chunksOf(plan.remoteWrites, 50)) {
    if (writes.length) await writeSessionFiles({ registry: session.registry, sessionId: session.sessionId, files: writes });
  }
  for (const deletion of plan.remoteDeletes) {
    await deleteSessionPath({ registry: session.registry, sessionId: session.sessionId, ...deletion });
  }
};

const applyLocalPlan = async (root: string, plan: SyncPlan) => {
  for (const move of plan.localMoves) await moveLocalSyncFile(root, move.source, move.destination);
  for (const file of plan.localWrites) await writeLocalSyncFile(root, file);
  for (const filePath of plan.localDeletes) await deleteLocalSyncFile(root, filePath);
};

const buildConvergedState = ({
  roomFingerprint,
  localFiles,
  remoteFiles,
}: {
  roomFingerprint: string;
  localFiles: readonly SyncFile[];
  remoteFiles: readonly SyncFile[];
}): FolderSyncState => {
  const local = new Map(localFiles.map((file) => [file.path, file]));
  const remote = new Map(remoteFiles.map((file) => [file.path, file]));
  if (local.size !== remote.size) {
    throw new TabulaCoreError("sync_incomplete", "The local folder and Tabula Room did not converge.", {
      details: { localFiles: local.size, remoteFiles: remote.size },
      retry: "Run Tabula Sync again. If the mismatch persists, inspect status before applying more changes.",
    });
  }
  const files: Record<string, { localRevision: string; remoteRevision: string }> = {};
  for (const [filePath, localFile] of local) {
    const remoteFile = remote.get(filePath);
    if (!remoteFile || remoteFile.revision !== localFile.revision) {
      throw new TabulaCoreError("sync_incomplete", "The local folder and Tabula Room contain different Markdown.", {
        details: { path: filePath },
        retry: "Run Tabula Sync status and resolve the reported file before retrying.",
      });
    }
    files[filePath] = { localRevision: localFile.revision, remoteRevision: remoteFile.revision };
  }
  return { version: 1, roomFingerprint, files, updatedAt: new Date().toISOString() };
};

const mergePlans = (plans: readonly SyncPlan[]): SyncPlan => ({
  conflicts: plans.flatMap((plan) => plan.conflicts),
  localDeletes: plans.flatMap((plan) => plan.localDeletes),
  localMoves: plans.flatMap((plan) => plan.localMoves),
  localWrites: plans.flatMap((plan) => plan.localWrites),
  remoteDeletes: plans.flatMap((plan) => plan.remoteDeletes),
  remoteMoves: plans.flatMap((plan) => plan.remoteMoves),
  remoteWrites: plans.flatMap((plan) => plan.remoteWrites),
});

const projectedSyncBase = async ({
  localFiles,
  remoteFiles,
  plan,
}: {
  localFiles: readonly SyncFile[];
  remoteFiles: readonly SyncFile[];
  plan: SyncPlan;
}) => {
  const local = new Map(localFiles.map((file) => [file.path, file]));
  const remote = new Map(remoteFiles.map((file) => [file.path, file]));

  for (const move of plan.remoteMoves) {
    const source = remote.get(move.source);
    if (source) remote.set(move.destination, { ...source, path: move.destination });
    remote.delete(move.source);
  }
  for (const file of plan.remoteWrites) {
    remote.set(file.path, { path: file.path, content: file.content, revision: await sha256Text(file.content) });
  }
  for (const file of plan.remoteDeletes) remote.delete(file.path);

  for (const move of plan.localMoves) {
    const source = local.get(move.source);
    if (source) local.set(move.destination, { ...source, path: move.destination });
    local.delete(move.source);
  }
  for (const file of plan.localWrites) local.set(file.path, file);
  for (const filePath of plan.localDeletes) local.delete(filePath);

  const state: Record<string, { localRevision: string; remoteRevision: string }> = {};
  for (const [filePath, localFile] of local) {
    const remoteFile = remote.get(filePath);
    if (remoteFile?.revision === localFile.revision) {
      state[filePath] = { localRevision: localFile.revision, remoteRevision: remoteFile.revision };
    }
  }
  return state;
};

export const syncFolderOnce = async ({
  session,
  root,
  deleteMissing = false,
  dryRun = false,
}: {
  session: FolderSyncSession;
  root: string;
  deleteMissing?: boolean;
  dryRun?: boolean;
}) => {
  const [storedState, localFiles, remoteFiles] = await Promise.all([
    readFolderSyncState(root),
    readLocalMarkdownFiles(root),
    readRemoteMarkdownFiles(session.registry, session.sessionId),
  ]);
  if (storedState && storedState.roomFingerprint !== session.roomFingerprint) {
    throw new TabulaCoreError("sync_room_mismatch", "This local folder is paired with a different Tabula Room.", {
      retry: "Use another folder or remove .tabula-sync.json only after verifying the intended Room.",
    });
  }
  let currentLocalFiles = localFiles;
  let currentRemoteFiles = remoteFiles;
  let syncBase = storedState?.files ?? {};
  const appliedPlans: SyncPlan[] = [];

  // A collaborator can edit while a sync cycle is running. Re-plan from the
  // state this process just attempted to establish instead of turning that
  // safe one-sided edit into an unrecoverable first-sync mismatch.
  for (let pass = 0; pass < 3; pass += 1) {
    const plan = planFolderSync({
      localFiles: currentLocalFiles,
      remoteFiles: currentRemoteFiles,
      state: syncBase,
      deleteMissing,
    });
    if (plan.conflicts.length || dryRun) {
      return { applied: appliedPlans.length > 0, plan: mergePlans([...appliedPlans, plan]) };
    }

    const nextSyncBase = await projectedSyncBase({
      localFiles: currentLocalFiles,
      remoteFiles: currentRemoteFiles,
      plan,
    });
    await applyRemotePlan(session, plan);
    await applyLocalPlan(root, plan);
    appliedPlans.push(plan);

    [currentLocalFiles, currentRemoteFiles] = await Promise.all([
      readLocalMarkdownFiles(root),
      readRemoteMarkdownFiles(session.registry, session.sessionId),
    ]);
    try {
      const state = buildConvergedState({
        roomFingerprint: session.roomFingerprint,
        localFiles: currentLocalFiles,
        remoteFiles: currentRemoteFiles,
      });
      await writeFolderSyncState(root, state);
      return {
        applied: true,
        plan: mergePlans(appliedPlans),
        fileCount: Object.keys(state.files).length,
        updatedAt: state.updatedAt,
      };
    } catch (error) {
      if (pass === 2) throw error;
      syncBase = nextSyncBase;
    }
  }

  throw new TabulaCoreError("sync_incomplete", "The local folder and Tabula Room did not converge.", {
    details: { applied: appliedPlans.length > 0 },
    retry: "Run Tabula Sync again. If the mismatch persists, inspect status before applying more changes.",
  });
};
