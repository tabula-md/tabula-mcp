import {
  decodeEncryptedData,
  getJsonShareImportRoute,
  JSON_SHARE_API_PREFIX,
  parseShareSnapshot,
} from "@tabula-md/tabula";
import { sha256Text } from "./crypto.js";
import { maxCopyCharacters, maxCopyFiles, maxEncryptedCopyBytes } from "./copy-limits.js";
import { TabulaCoreError } from "./core-errors.js";
import type { RuntimeEnvironment } from "./env.js";
import { resolveJsonShareServerUrl } from "./share.js";
import type { WorkspaceRoomState } from "./workspace-contract.js";
import { buildWorkspacePathIndex } from "./workspace-paths.js";
import { currentOperationSignal, throwIfOperationAborted } from "./server/operation-context.js";

export const maxImportedCopyFiles = maxCopyFiles;
export const maxImportedCopyCharacters = maxCopyCharacters;

type ImportedCopyPayload = {
  createdAt: string;
  rootFolderId: string;
  activeFileId: string;
  folders: Array<{
    id: string;
    title: string;
    parentId: string | null;
    order: number;
  }>;
  files: Array<{
    id: string;
    title: string;
    text: string;
    parentId: string;
    order: number;
  }>;
  commentsByFileId: Record<string, unknown[]>;
};

const importFailed = (
  message: string,
  retry: string,
  details: Record<string, unknown> = {},
) => new TabulaCoreError("copy_import_failed", message, { details, retry });

const parseCopyUrl = (copyUrl: string) => {
  let url: URL;
  try {
    url = new URL(copyUrl);
  } catch {
    throw new TabulaCoreError("invalid_input", "The supplied value is not a valid Tabula URL.", {
      details: { expected: "https://tabula.md/#json=<copy-id>,<client-key>" },
      retry: "Use the complete private #json URL copied from Tabula.",
    });
  }
  const importRoute = getJsonShareImportRoute({ pathname: url.pathname, hash: url.hash });
  if (!importRoute) {
    throw new TabulaCoreError("invalid_input", "The supplied URL is not a Tabula export copy.", {
      details: { expected: "A complete #json URL, not a #room URL." },
      retry: "Use Join Session for #room links or provide the complete #json URL.",
    });
  }
  if (importRoute.status === "invalid") {
    throw new TabulaCoreError("invalid_input", importRoute.errorMessage, {
      retry: "Use the complete #json URL copied from Tabula.",
    });
  }
  return { url, route: importRoute.route };
};

const fetchCopyPayload = async ({
  copyUrl,
  env,
  fetchImpl = fetch,
}: {
  copyUrl: string;
  env?: RuntimeEnvironment;
  fetchImpl?: typeof fetch;
}) => {
  const { url, route } = parseCopyUrl(copyUrl);
  const serviceUrl = resolveJsonShareServerUrl({
    appOrigin: url.origin,
    ...(env ? { env } : {}),
  });
  const response = await fetchImpl(
    `${serviceUrl}${JSON_SHARE_API_PREFIX}${encodeURIComponent(route.snapshotId)}`,
    { signal: currentOperationSignal() },
  );
  if (response.status === 404) {
    throw importFailed(
      "The Tabula copy was not found or has expired.",
      "Ask the sender for a new Export Copy link.",
    );
  }
  if (!response.ok) {
    throw importFailed(
      "Tabula could not download the encrypted copy.",
      "Retry once, then ask the sender for a new Export Copy link.",
      { status: response.status },
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxEncryptedCopyBytes) {
    throw importFailed(
      "The encrypted Tabula copy is too large to import.",
      "Ask the sender to export fewer or smaller Markdown files.",
      { maxBytes: maxEncryptedCopyBytes },
    );
  }
  const encrypted = new Uint8Array(await response.arrayBuffer());
  if (encrypted.byteLength > maxEncryptedCopyBytes) {
    throw importFailed(
      "The encrypted Tabula copy is too large to import.",
      "Ask the sender to export fewer or smaller Markdown files.",
      { maxBytes: maxEncryptedCopyBytes },
    );
  }

  let decrypted: Uint8Array;
  throwIfOperationAborted();
  try {
    decrypted = (await decodeEncryptedData(encrypted, { decryptionKey: route.key })).data;
  } catch {
    throw importFailed(
      "The Tabula copy could not be decrypted.",
      "Use the complete #json URL, including its client-only key.",
    );
  }
  try {
    return parseShareSnapshot(decrypted) as ImportedCopyPayload;
  } catch {
    throw importFailed(
      "The Tabula copy uses an unsupported or invalid snapshot format.",
      "Ask the sender to create a new copy with the current Tabula version.",
    );
  }
};

const projectCopyFiles = async (payload: ImportedCopyPayload) => {
  if (payload.files.length > maxImportedCopyFiles) {
    throw importFailed(
      "The Tabula copy contains too many Markdown files to import through this MCP host.",
      "Ask the sender to export a smaller copy or open it in Tabula.",
      { fileCount: payload.files.length, maxFiles: maxImportedCopyFiles },
    );
  }
  const documents = Object.fromEntries(payload.files.map((file) => [file.id, file.text]));
  const documentNodes = await Promise.all(payload.files.map(async (file) => ({
    id: file.id,
    type: "document" as const,
    parentId: file.parentId,
    title: file.title,
    order: file.order,
    createdAt: payload.createdAt,
    updatedAt: payload.createdAt,
    sha256: await sha256Text(file.text),
    textLength: file.text.length,
  })));
  const workspace: WorkspaceRoomState = {
    roomId: "imported-copy",
    mode: "workspace",
    version: 1,
    rootId: payload.rootFolderId,
    nodes: [
      ...payload.folders.map((folder) => ({
        id: folder.id,
        type: "folder" as const,
        parentId: folder.parentId,
        title: folder.title,
        order: folder.order,
        createdAt: payload.createdAt,
        updatedAt: payload.createdAt,
      })),
      ...documentNodes,
    ],
    activeDocumentId: payload.activeFileId,
  };
  let index: ReturnType<typeof buildWorkspacePathIndex>;
  try {
    index = buildWorkspacePathIndex(workspace);
  } catch (error) {
    throw importFailed(
      "The Tabula copy contains an unsafe or invalid file structure.",
      "Ask the sender to create a new copy after fixing its file or folder names.",
      { reason: error instanceof Error ? error.message : "Invalid file structure." },
    );
  }
  const files = index.entries.flatMap((entry) => entry.node.type === "document"
    ? [{ path: entry.path, content: documents[entry.node.id] ?? "" }]
    : []);
  const totalCharacters = files.reduce((total, file) => total + file.content.length, 0);
  if (totalCharacters > maxImportedCopyCharacters) {
    throw importFailed(
      "The Tabula copy contains too much Markdown to import through this MCP host.",
      "Ask the sender to export a smaller copy or open it in Tabula.",
      { totalCharacters, maxCharacters: maxImportedCopyCharacters },
    );
  }
  const root = payload.folders.find((folder) => folder.id === payload.rootFolderId);
  const activePath = index.pathsById.get(payload.activeFileId);
  const commentCount = Object.values(payload.commentsByFileId)
    .reduce((total, comments) => total + comments.length, 0);
  return {
    title: root?.title || "Tabula copy",
    files,
    fileCount: files.length,
    totalCharacters,
    ...(activePath ? { activePath } : {}),
    createdAt: payload.createdAt,
    commentCount,
  };
};

export const importCopy = async ({
  copyUrl,
  env,
  fetchImpl,
}: {
  copyUrl: string;
  env?: RuntimeEnvironment;
  fetchImpl?: typeof fetch;
}) => projectCopyFiles(await fetchCopyPayload({
  copyUrl,
  env,
  ...(fetchImpl ? { fetchImpl } : {}),
}));
