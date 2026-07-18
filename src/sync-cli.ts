#!/usr/bin/env node

import "./node-runtime.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isDirectRun } from "./cli.js";
import { redactOperationalText } from "./server/operational-policy.js";
import { openFolderSyncSession, syncFolderOnce } from "./sync-service.js";
import type { SyncPlan } from "./sync-model.js";

export const SYNC_CLI_HELP = `Tabula Sync

Synchronize a local Markdown folder with one encrypted Tabula Room.

Usage:
  tabula-sync sync [folder] [--delete] [--dry-run] [--room-file <path>]
  tabula-sync status [folder] [--delete] [--room-file <path>]
  tabula-sync watch [folder] [--delete] [--interval <seconds>] [--room-file <path>]

Provide the private Room URL with TABULA_ROOM_URL or a mode-0600 room file.
The URL is never written to .tabula-sync.json or printed. Deletions propagate
only with --delete. Conflicts stop the entire cycle before any write.`;

const actionCount = (plan: SyncPlan) =>
  plan.localDeletes.length + plan.localMoves.length + plan.localWrites.length +
  plan.remoteDeletes.length + plan.remoteMoves.length + plan.remoteWrites.length;

const summarizePlan = (plan: SyncPlan) => ({
  actions: actionCount(plan),
  conflicts: plan.conflicts,
  local: {
    deletes: plan.localDeletes,
    moves: plan.localMoves,
    writes: plan.localWrites.map((file) => file.path),
  },
  room: {
    deletes: plan.remoteDeletes.map((file) => file.path),
    moves: plan.remoteMoves,
    writes: plan.remoteWrites.map((file) => file.path),
  },
});

const roomUrlFrom = async (roomFile?: string) => {
  if (roomFile) {
    const resolved = path.resolve(roomFile);
    const fileStats = await stat(resolved);
    if (process.platform !== "win32" && (fileStats.mode & 0o077) !== 0) {
      throw new Error("The --room-file must not be readable or writable by group or other users (chmod 600).");
    }
    return (await readFile(resolved, "utf8")).trim();
  }
  const roomUrl = process.env.TABULA_ROOM_URL?.trim();
  if (!roomUrl) throw new Error("Set TABULA_ROOM_URL or pass --room-file <path>.");
  return roomUrl;
};

const runCycle = async ({
  action,
  root,
  deleteMissing,
  roomUrl,
}: {
  action: "status" | "sync";
  root: string;
  deleteMissing: boolean;
  roomUrl: string;
}) => {
  const session = await openFolderSyncSession({ roomUrl, env: process.env });
  try {
    const result = await syncFolderOnce({
      session,
      root,
      deleteMissing,
      dryRun: action === "status",
    });
    console.log(JSON.stringify({
      ok: result.plan.conflicts.length === 0,
      applied: result.applied,
      ...(result.applied && "fileCount" in result ? { fileCount: result.fileCount, updatedAt: result.updatedAt } : {}),
      ...summarizePlan(result.plan),
    }, null, 2));
    if (result.plan.conflicts.length) process.exitCode = 2;
  } finally {
    await session.close();
  }
};

export const runSyncCli = async (argv = process.argv.slice(2)) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      delete: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      interval: { type: "string", default: "2" },
      "room-file": { type: "string" },
    },
  });
  if (values.help) {
    console.log(SYNC_CLI_HELP);
    return;
  }
  const action = positionals[0] ?? "sync";
  if (!new Set(["sync", "status", "watch"]).has(action)) throw new Error("Action must be sync, status, or watch.");
  const root = path.resolve(positionals[1] ?? ".");
  const roomUrl = await roomUrlFrom(values["room-file"]);
  const deleteMissing = values.delete;

  if (action !== "watch") {
    await runCycle({ action: action === "status" || values["dry-run"] ? "status" : "sync", root, deleteMissing, roomUrl });
    return;
  }

  const intervalSeconds = Number(values.interval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) throw new Error("--interval must be at least 1 second.");
  const session = await openFolderSyncSession({ roomUrl, env: process.env });
  const stop = () => { process.exitCode = 0; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (process.exitCode === undefined) {
      const result = await syncFolderOnce({ session, root, deleteMissing });
      console.log(JSON.stringify({
        ok: result.plan.conflicts.length === 0,
        applied: result.applied,
        ...summarizePlan(result.plan),
      }));
      if (result.plan.conflicts.length) {
        process.exitCode = 2;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
    }
  } finally {
    await session.close();
  }
};

if (isDirectRun(import.meta.url)) {
  runSyncCli().catch((error) => {
    console.error(redactOperationalText(error instanceof Error ? error.message : "Tabula Sync failed."));
    process.exitCode = 1;
  });
}
