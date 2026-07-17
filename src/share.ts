import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  createShareSnapshotPayloadFromData,
  encodeEncryptedData,
  generateEncryptionKey,
  serializeShareSnapshot,
} from "@tabula-md/tabula";
import type { ShareSnapshotPayload } from "@tabula-md/tabula/data/json";
import * as Y from "yjs";
import { assertProductionEgressAllowed, normalizeServiceUrl } from "./egress-policy.js";
import {
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "./crypto.js";
import { encodeBase64Url, TabulaMcpError, trimTrailingSlash, type EncryptedEnvelope } from "./protocol.js";

const defaultTabulaAppOrigin = "https://tabula.md";
const defaultTabulaJsonServerUrl = "https://json.tabula.md";
const localJsonServerPort = 3004;
const jsonServerAllowlistEnv = "TABULA_MCP_ALLOWED_JSON_SERVER_URLS";
const roomIdBytes = 16;
const roomKeyBytes = 32;
const jsonShareApiPrefix = "/api/v2/";
const jsonSharePostPath = "/api/v2/post/";
const mainFileId = "main";
const shareRootFolderIdBase = "tabula-mcp-root";
const shareRootFolderTitle = "Tabula.md workspace";

type FetchLike = typeof fetch;

type JsonShareCreateResponse = {
  id: string;
  data: string;
  expiresAt?: string;
};

export type ShareMarkdownWorkspaceFile = {
  id: string;
  path?: string;
  title: string;
  text: string;
};

export type ShareMarkdownDocumentOptions = {
  title?: string;
  markdown: string;
  appOrigin?: string;
  jsonServerUrl?: string;
  fetchImpl?: FetchLike;
  snapshotKey?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

export type SharedMarkdownDocument = {
  title: string;
  linkKind: "json-snapshot";
  snapshotId: string;
  appOrigin: string;
  jsonServerUrl: string;
  snapshotUrl: string;
  shareUrl: string;
  textLength: number;
  sha256: string;
  encrypted: true;
  secret: true;
  keyLocation: "url-fragment";
  expiresAt?: string;
};

export type ShareMarkdownWorkspaceOptions = {
  title?: string;
  files: readonly ShareMarkdownWorkspaceFile[];
  activeFileId?: string;
  commentsByFileId?: ShareSnapshotPayload["commentsByFileId"];
  appOrigin?: string;
  jsonServerUrl?: string;
  fetchImpl?: FetchLike;
  snapshotKey?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

export type SharedMarkdownWorkspace = {
  title: string;
  linkKind: "json-snapshot";
  snapshotId: string;
  appOrigin: string;
  jsonServerUrl: string;
  snapshotUrl: string;
  shareUrl: string;
  fileCount: number;
  textLength: number;
  sha256: string;
  encrypted: true;
  secret: true;
  keyLocation: "url-fragment";
  expiresAt?: string;
};

const toArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonEmptyString = (value: unknown, fieldName: string) => {
  if (typeof value !== "string" || !value) {
    throw new TabulaMcpError(`Encrypted Tabula.md snapshot upload returned an invalid ${fieldName}.`);
  }
  return value;
};

const optionalIsoDateString = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }
  const text = requireNonEmptyString(value, "expiresAt");
  if (!Number.isFinite(Date.parse(text))) {
    throw new TabulaMcpError("Encrypted Tabula.md snapshot upload returned an invalid expiresAt.");
  }
  return text;
};

const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

const resolveOfficialHostedJsonServerUrl = (hostname: string) => {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === "tabula.md" || normalizedHostname === "www.tabula.md"
    ? defaultTabulaJsonServerUrl
    : undefined;
};

export const resolveJsonShareServerUrl = ({
  appOrigin,
  jsonServerUrl,
  env = process.env,
}: {
  appOrigin: string;
  jsonServerUrl?: string;
  env?: NodeJS.ProcessEnv;
}) => {
  const configuredUrl = jsonServerUrl?.trim() || env.TABULA_JSON_URL?.trim() || env.VITE_TABULA_JSON_URL?.trim();
  if (configuredUrl) {
    return assertProductionEgressAllowed({
      allowedUrlsEnvName: jsonServerAllowlistEnv,
      defaultAllowedUrls: [defaultTabulaJsonServerUrl],
      env,
      serviceName: "Tabula JSON snapshot service",
      trustedUrlEnvNames: ["TABULA_JSON_URL", "VITE_TABULA_JSON_URL"],
      url: configuredUrl,
    });
  }

  const appUrl = new URL(appOrigin);
  if (isLocalHost(appUrl.hostname)) {
    const protocol = appUrl.protocol === "https:" ? "https:" : "http:";
    return assertProductionEgressAllowed({
      allowedUrlsEnvName: jsonServerAllowlistEnv,
      defaultAllowedUrls: [defaultTabulaJsonServerUrl],
      env,
      serviceName: "Tabula JSON snapshot service",
      trustedUrlEnvNames: ["TABULA_JSON_URL", "VITE_TABULA_JSON_URL"],
      url: `${protocol}//${appUrl.hostname}:${localJsonServerPort}`,
    });
  }

  const hostedJsonServerUrl = resolveOfficialHostedJsonServerUrl(appUrl.hostname);
  if (hostedJsonServerUrl) {
    return normalizeServiceUrl(hostedJsonServerUrl, "Tabula JSON snapshot service");
  }

  throw new TabulaMcpError(
    "JSON snapshot service URL is required for self-hosted Tabula links. Set TABULA_JSON_URL or pass jsonServerUrl.",
  );
};

export const generateRoomId = () => encodeBase64Url(randomBytes(roomIdBytes));

export const generateRoomKey = () => encodeBase64Url(randomBytes(roomKeyBytes));

export const generateJsonShareKey = () => generateEncryptionKey();

export const createRoomShareUrl = ({
  appOrigin = defaultTabulaAppOrigin,
  roomId,
  roomKey,
}: {
  appOrigin?: string;
  roomId: string;
  roomKey: string;
}) => {
  const url = new URL(appOrigin);
  return `${url.origin}/#room=${roomId},${roomKey}`;
};

export const createJsonShareUrl = ({
  appOrigin = defaultTabulaAppOrigin,
  snapshotId,
  snapshotKey,
}: {
  appOrigin?: string;
  snapshotId: string;
  snapshotKey: string;
}) => {
  const url = new URL(appOrigin);
  return `${url.origin}/#json=${snapshotId},${snapshotKey}`;
};

export const createEncryptedMarkdownSnapshot = async ({
  roomId,
  roomKey,
  markdown,
}: {
  roomId: string;
  roomKey: string;
  markdown: string;
}): Promise<EncryptedEnvelope> => {
  const doc = new Y.Doc();
  try {
    doc.getText("markdown").insert(0, markdown);
    const importedRoomKey = await importRoomKey(roomKey);
    return encryptBytesForRoom(importedRoomKey, roomId, "snapshot", 1, Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
};

const normalizeShareFile = (file: ShareMarkdownWorkspaceFile) => {
  const title = file.title.trim() || "Untitled Document";
  const rawPath = file.path?.replaceAll("\\", "/").trim();
  if (rawPath && (rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath))) {
    throw new TabulaMcpError("Tabula.md snapshot file paths must be relative.");
  }
  const normalizedPath = rawPath
    ? path.posix.normalize(rawPath)
    : title;
  if (!normalizedPath || normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new TabulaMcpError("Tabula.md snapshot file paths must stay inside the workspace.");
  }
  return { id: file.id.trim(), path: normalizedPath, title, text: file.text };
};

const createShareRootFolderId = (files: readonly ShareMarkdownWorkspaceFile[]) => {
  const fileIds = new Set(files.map((file) => file.id));
  let rootFolderId = shareRootFolderIdBase;
  let suffix = 1;
  while (fileIds.has(rootFolderId)) {
    rootFolderId = `${shareRootFolderIdBase}-${suffix}`;
    suffix += 1;
  }
  return rootFolderId;
};

const createMcpShareSnapshotPayload = ({
  title,
  files,
  activeFileId,
  commentsByFileId = {},
  now = () => new Date(),
}: {
  title?: string;
  files: readonly ShareMarkdownWorkspaceFile[];
  activeFileId?: string;
  commentsByFileId?: ShareSnapshotPayload["commentsByFileId"];
  now?: () => Date;
}) => {
  const snapshotFiles = files.map(normalizeShareFile).filter((file) => file.id);
  if (snapshotFiles.length === 0) {
    throw new TabulaMcpError("At least one Markdown file is required for a Tabula.md snapshot link.");
  }
  const activeFile = snapshotFiles.find((file) => file.id === activeFileId) ?? snapshotFiles[0];
  const rootFolderId = createShareRootFolderId(snapshotFiles);
  const usedIds = new Set(snapshotFiles.map((file) => file.id));
  usedIds.add(rootFolderId);
  const folderIds = new Map<string, string>([["", rootFolderId]]);
  const folders: Array<{ id: string; title: string; parentId: string | null; order: number }> = [
    { id: rootFolderId, title: title?.trim() || shareRootFolderTitle, parentId: null, order: 0 },
  ];
  const createFolderId = (folderPath: string) => {
    const base = `folder_${Buffer.from(folderPath).toString("base64url")}`;
    let candidate = base;
    let suffix = 1;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  };
  for (const file of snapshotFiles) {
    const directory = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
    let parentPath = "";
    for (const [index, part] of directory.split("/").filter(Boolean).entries()) {
      const folderPath = parentPath ? `${parentPath}/${part}` : part;
      if (!folderIds.has(folderPath)) {
        const id = createFolderId(folderPath);
        folderIds.set(folderPath, id);
        folders.push({
          id,
          title: part,
          parentId: folderIds.get(parentPath) ?? rootFolderId,
          order: folders.length,
        });
      }
      parentPath = folderPath;
    }
  }

  return createShareSnapshotPayloadFromData({
    files: snapshotFiles.map((file, index) => ({
      id: file.id,
      title: file.title,
      text: file.text,
      parentId: folderIds.get(path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path)) ?? rootFolderId,
      order: index,
    })),
    folders,
    rootFolderId,
    activeFileId: activeFile?.id ?? activeFileId ?? snapshotFiles[0]?.id ?? mainFileId,
    commentsByFileId,
    now,
  });
};

export const createEncryptedJsonShareSnapshot = async ({
  title,
  markdown,
  snapshotKey,
  now,
}: {
  title?: string;
  markdown: string;
  snapshotKey: string;
  now?: () => Date;
}) => {
  const payload = createMcpShareSnapshotPayload({
    title,
    files: [
      {
        id: mainFileId,
        title: title?.trim() || "Untitled Document",
        text: markdown,
      },
    ],
    activeFileId: mainFileId,
    now,
  });
  return encodeEncryptedData(serializeShareSnapshot(payload), {
    encryptionKey: snapshotKey,
    metadata: { kind: "json-share", schemaVersion: payload.schemaVersion },
  });
};

export const createEncryptedJsonShareWorkspaceSnapshot = async ({
  title,
  files,
  activeFileId,
  commentsByFileId,
  snapshotKey,
  now,
}: {
  title?: string;
  files: readonly ShareMarkdownWorkspaceFile[];
  activeFileId?: string;
  commentsByFileId?: ShareSnapshotPayload["commentsByFileId"];
  snapshotKey: string;
  now?: () => Date;
}) => {
  const payload = createMcpShareSnapshotPayload({ title, files, activeFileId, commentsByFileId, now });
  return encodeEncryptedData(serializeShareSnapshot(payload), {
    encryptionKey: snapshotKey,
    metadata: { kind: "json-share", schemaVersion: payload.schemaVersion },
  });
};

const validateJsonShareCreateResponse = (value: unknown, serviceUrl: string): JsonShareCreateResponse => {
  if (!isRecord(value)) {
    throw new TabulaMcpError("Encrypted Tabula.md snapshot upload returned an invalid response.");
  }

  const id = requireNonEmptyString(value.id, "id");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new TabulaMcpError("Encrypted Tabula.md snapshot upload returned an invalid id.");
  }

  const data = requireNonEmptyString(value.data, "data");
  const expectedData = `${trimTrailingSlash(serviceUrl)}${jsonShareApiPrefix}${id}`;
  if (data !== expectedData) {
    throw new TabulaMcpError("Encrypted Tabula.md snapshot upload returned an invalid data URL.");
  }

  const expiresAt = optionalIsoDateString(value.expiresAt);
  return {
    id,
    data,
    ...(expiresAt ? { expiresAt } : {}),
  };
};

const readJsonShareError = async (response: Response) => {
  try {
    const parsed = (await response.json()) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `HTTP ${response.status}`;
};

export const shareMarkdownDocument = async ({
  title,
  markdown,
  appOrigin = defaultTabulaAppOrigin,
  jsonServerUrl,
  fetchImpl = fetch,
  snapshotKey = generateJsonShareKey(),
  now,
  env = process.env,
}: ShareMarkdownDocumentOptions): Promise<SharedMarkdownDocument> => {
  const normalizedJsonServerUrl = resolveJsonShareServerUrl({
    appOrigin,
    jsonServerUrl,
    env,
  });
  const encrypted = await createEncryptedJsonShareSnapshot({
    title,
    markdown,
    snapshotKey,
    now,
  });
  const response = await fetchImpl(`${normalizedJsonServerUrl}${jsonSharePostPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
    },
    body: toArrayBuffer(encrypted),
  });

  if (!response.ok) {
    throw new TabulaMcpError(`Encrypted Tabula.md snapshot upload failed with HTTP ${response.status}: ${await readJsonShareError(response)}.`);
  }

  const created = validateJsonShareCreateResponse((await response.json()) as unknown, normalizedJsonServerUrl);
  const shareUrl = createJsonShareUrl({ appOrigin, snapshotId: created.id, snapshotKey });

  return {
    title: title?.trim() || "Untitled Document",
    linkKind: "json-snapshot",
    snapshotId: created.id,
    appOrigin,
    jsonServerUrl: normalizedJsonServerUrl,
    snapshotUrl: created.data,
    shareUrl,
    textLength: markdown.length,
    sha256: await sha256Text(markdown),
    encrypted: true,
    secret: true,
    keyLocation: "url-fragment",
    ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
  };
};

export const shareMarkdownWorkspace = async ({
  title,
  files,
  activeFileId,
  commentsByFileId,
  appOrigin = defaultTabulaAppOrigin,
  jsonServerUrl,
  fetchImpl = fetch,
  snapshotKey = generateJsonShareKey(),
  now,
  env = process.env,
}: ShareMarkdownWorkspaceOptions): Promise<SharedMarkdownWorkspace> => {
  const normalizedFiles = files.map(normalizeShareFile).filter((file) => file.id);
  const normalizedJsonServerUrl = resolveJsonShareServerUrl({
    appOrigin,
    jsonServerUrl,
    env,
  });
  const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
    title,
    files: normalizedFiles,
    activeFileId,
    commentsByFileId,
    snapshotKey,
    now,
  });
  const response = await fetchImpl(`${normalizedJsonServerUrl}${jsonSharePostPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
    },
    body: toArrayBuffer(encrypted),
  });

  if (!response.ok) {
    throw new TabulaMcpError(`Encrypted Tabula.md snapshot upload failed with HTTP ${response.status}: ${await readJsonShareError(response)}.`);
  }

  const created = validateJsonShareCreateResponse((await response.json()) as unknown, normalizedJsonServerUrl);
  const shareUrl = createJsonShareUrl({ appOrigin, snapshotId: created.id, snapshotKey });
  const textLength = normalizedFiles.reduce((total, file) => total + file.text.length, 0);

  return {
    title: title?.trim() || "Workspace",
    linkKind: "json-snapshot",
    snapshotId: created.id,
    appOrigin,
    jsonServerUrl: normalizedJsonServerUrl,
    snapshotUrl: created.data,
    shareUrl,
    fileCount: normalizedFiles.length,
    textLength,
    sha256: await sha256Text(JSON.stringify(normalizedFiles)),
    encrypted: true,
    secret: true,
    keyLocation: "url-fragment",
    ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
  };
};
