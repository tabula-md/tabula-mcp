export type SyncFile = {
  path: string;
  content: string;
  revision: string;
};

export type SyncStateFile = {
  localRevision: string;
  remoteRevision: string;
};

export type SyncConflict = {
  path: string;
  code:
    | "initial_mismatch"
    | "both_changed"
    | "local_changed_after_remote_delete"
    | "remote_changed_after_local_delete"
    | "delete_requires_confirmation";
  message: string;
};

export type SyncPlan = {
  conflicts: SyncConflict[];
  localDeletes: string[];
  localMoves: Array<{ source: string; destination: string }>;
  localWrites: SyncFile[];
  remoteDeletes: Array<{ path: string; expectedRevision: string }>;
  remoteMoves: Array<{ source: string; destination: string; expectedRevision: string }>;
  remoteWrites: Array<{ path: string; content: string; expectedRevision?: string }>;
};

const emptyPlan = (): SyncPlan => ({
  conflicts: [],
  localDeletes: [],
  localMoves: [],
  localWrites: [],
  remoteDeletes: [],
  remoteMoves: [],
  remoteWrites: [],
});

const byPath = (files: readonly SyncFile[]) => new Map(files.map((file) => [file.path, file]));

const findUniqueUntrackedByRevision = (
  files: ReadonlyMap<string, SyncFile>,
  state: Readonly<Record<string, SyncStateFile>>,
  revision: string,
  consumed: ReadonlySet<string>,
) => {
  const matches = [...files.values()].filter((file) =>
    !state[file.path] && !consumed.has(file.path) && file.revision === revision
  );
  return matches.length === 1 ? matches[0] : undefined;
};

export const planFolderSync = ({
  localFiles,
  remoteFiles,
  state,
  deleteMissing = false,
}: {
  localFiles: readonly SyncFile[];
  remoteFiles: readonly SyncFile[];
  state: Readonly<Record<string, SyncStateFile>>;
  deleteMissing?: boolean;
}): SyncPlan => {
  const plan = emptyPlan();
  const local = byPath(localFiles);
  const remote = byPath(remoteFiles);
  const consumed = new Set<string>();

  // Recognize an unambiguous rename before treating it as a delete/create pair.
  for (const [oldPath, base] of Object.entries(state)) {
    const localOld = local.get(oldPath);
    const remoteOld = remote.get(oldPath);
    if (!localOld && remoteOld?.revision === base.remoteRevision) {
      const renamed = findUniqueUntrackedByRevision(local, state, base.localRevision, consumed);
      if (renamed && !remote.has(renamed.path)) {
        plan.remoteMoves.push({ source: oldPath, destination: renamed.path, expectedRevision: remoteOld.revision });
        consumed.add(oldPath);
        consumed.add(renamed.path);
      }
    } else if (!remoteOld && localOld?.revision === base.localRevision) {
      const renamed = findUniqueUntrackedByRevision(remote, state, base.remoteRevision, consumed);
      if (renamed && !local.has(renamed.path)) {
        plan.localMoves.push({ source: oldPath, destination: renamed.path });
        consumed.add(oldPath);
        consumed.add(renamed.path);
      }
    }
  }

  const paths = new Set([...Object.keys(state), ...local.keys(), ...remote.keys()]);
  for (const path of [...paths].sort()) {
    if (consumed.has(path)) continue;
    const localFile = local.get(path);
    const remoteFile = remote.get(path);
    const base = state[path];

    if (localFile && remoteFile) {
      if (localFile.revision === remoteFile.revision) continue;
      if (!base) {
        plan.conflicts.push({
          path,
          code: "initial_mismatch",
          message: "The local and Room files differ and no common sync base exists.",
        });
        continue;
      }
      const localChanged = localFile.revision !== base.localRevision;
      const remoteChanged = remoteFile.revision !== base.remoteRevision;
      if (localChanged && remoteChanged) {
        plan.conflicts.push({ path, code: "both_changed", message: "Both the local and Room files changed." });
      } else if (localChanged) {
        plan.remoteWrites.push({
          path,
          content: localFile.content,
          expectedRevision: remoteFile.revision,
        });
      } else if (remoteChanged) {
        plan.localWrites.push(remoteFile);
      } else {
        plan.conflicts.push({ path, code: "both_changed", message: "The file differs from its recorded sync base." });
      }
      continue;
    }

    if (localFile) {
      if (!base) {
        plan.remoteWrites.push({ path, content: localFile.content });
      } else if (localFile.revision !== base.localRevision) {
        plan.conflicts.push({
          path,
          code: "local_changed_after_remote_delete",
          message: "The Room file was deleted after the local file changed.",
        });
      } else if (deleteMissing) {
        plan.localDeletes.push(path);
      } else {
        plan.conflicts.push({
          path,
          code: "delete_requires_confirmation",
          message: "The Room file was deleted. Re-run with --delete to remove the unchanged local file.",
        });
      }
      continue;
    }

    if (remoteFile) {
      if (!base) {
        plan.localWrites.push(remoteFile);
      } else if (remoteFile.revision !== base.remoteRevision) {
        plan.conflicts.push({
          path,
          code: "remote_changed_after_local_delete",
          message: "The local file was deleted after the Room file changed.",
        });
      } else if (deleteMissing) {
        plan.remoteDeletes.push({ path, expectedRevision: remoteFile.revision });
      } else {
        plan.conflicts.push({
          path,
          code: "delete_requires_confirmation",
          message: "The local file was deleted. Re-run with --delete to remove the unchanged Room file.",
        });
      }
    }
  }

  return plan;
};
