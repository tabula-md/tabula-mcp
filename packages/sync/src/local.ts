import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Text } from "../../../src/crypto.js";
import { TabulaMcpError } from "../../../src/protocol.js";
import type { SyncFile, SyncStateFile } from "./model.js";

export const syncStateFileName = ".tabula-sync.json";
const ignoredDirectories = new Set([".git", ".hg", ".svn", "node_modules"]);
const markdownExtensions = new Set([".md", ".mdx"]);

export type FolderSyncState = {
  version: 1;
  roomFingerprint: string;
  files: Record<string, SyncStateFile>;
  updatedAt: string;
};

const insideRoot = (root: string, relativePath: string) => {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TabulaMcpError("A sync path escaped the selected local folder.");
  }
  return target;
};

const safeTarget = async (root: string, relativePath: string) => {
  const resolvedRoot = path.resolve(root);
  const target = insideRoot(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  let current = resolvedRoot;
  for (const [index, part] of relative.split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, part);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw new TabulaMcpError(`Refusing to traverse symlink sync path: ${relativePath}`);
    const isLeaf = index === relative.split(path.sep).filter(Boolean).length - 1;
    if (!isLeaf && !stats.isDirectory()) throw new TabulaMcpError(`A non-directory blocks sync path: ${relativePath}`);
  }
  return target;
};

export const readLocalMarkdownFiles = async (root: string): Promise<SyncFile[]> => {
  const resolvedRoot = path.resolve(root);
  const rootStats = await lstat(resolvedRoot).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new TabulaMcpError("The sync root must be an existing non-symlink directory.");
  }
  const files: SyncFile[] = [];
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !markdownExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const relative = path.relative(resolvedRoot, absolute).split(path.sep).join("/");
      const content = await readFile(absolute, "utf8");
      files.push({ path: relative, content, revision: await sha256Text(content) });
    }
  };
  await visit(resolvedRoot);
  return files;
};

export const readFolderSyncState = async (root: string): Promise<FolderSyncState | null> => {
  const statePath = await safeTarget(root, syncStateFileName);
  const raw = await readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<FolderSyncState>;
  if (value.version !== 1 || typeof value.roomFingerprint !== "string" || !value.files || typeof value.files !== "object") {
    throw new TabulaMcpError(`${syncStateFileName} is not a supported Tabula sync state file.`);
  }
  return value as FolderSyncState;
};

export const writeFolderSyncState = async (root: string, state: FolderSyncState) => {
  const statePath = await safeTarget(root, syncStateFileName);
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, statePath);
};

export const writeLocalSyncFile = async (root: string, file: Pick<SyncFile, "path" | "content">) => {
  const target = await safeTarget(root, file.path);
  const current = await lstat(target).catch(() => null);
  if (current?.isSymbolicLink() || (current && !current.isFile())) {
    throw new TabulaMcpError(`Cannot replace non-file sync path: ${file.path}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, "utf8");
};

export const moveLocalSyncFile = async (root: string, source: string, destination: string) => {
  const from = await safeTarget(root, source);
  const to = await safeTarget(root, destination);
  const destinationStats = await lstat(to).catch(() => null);
  if (destinationStats) throw new TabulaMcpError(`Cannot move onto existing sync path: ${destination}`);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
};

export const deleteLocalSyncFile = async (root: string, relativePath: string) => {
  const target = await safeTarget(root, relativePath);
  const stats = await lstat(target).catch(() => null);
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new TabulaMcpError(`Refusing to delete non-file sync path: ${relativePath}`);
  }
  await rm(target);
};
