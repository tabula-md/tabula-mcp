import { randomBytes, webcrypto } from "node:crypto";
import * as Y from "yjs";
import {
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "./crypto.js";
import {
  decodeBase64Url,
  encodeBase64Url,
  TabulaMcpError,
  trimTrailingSlash,
  type EncryptedEnvelope,
} from "./protocol.js";

const defaultTabulaAppOrigin = "https://tabula.md";
const defaultTabulaJsonServerUrl = "https://json.tabula.md";
const localJsonServerPort = 3004;
const roomIdBytes = 16;
const roomKeyBytes = 32;
const jsonShareKeyBytes = 32;
const jsonShareApiPrefix = "/api/v2/";
const jsonSharePostPath = "/api/v2/post/";
const shareSnapshotSchemaVersion = 1;
const mainFileId = "main";
const encryptedDataMagic = new Uint8Array([0x54, 0x42, 0x45, 0x31]);
const uint32Bytes = 4;
const aesGcmIvBytes = 12;
const textEncoder = new TextEncoder();
const cryptoImpl = globalThis.crypto ?? webcrypto;

type FetchLike = typeof fetch;

type ShareSnapshotPayload = {
  schemaVersion: typeof shareSnapshotSchemaVersion;
  createdAt: string;
  activeFileId: string;
  files: Array<{
    id: string;
    title: string;
    text: string;
  }>;
  commentsByFileId: Record<string, []>;
};

type JsonShareCreateResponse = {
  id: string;
  data: string;
  expiresAt?: string;
};

export type ShareMarkdownDocumentOptions = {
  title?: string;
  markdown: string;
  appOrigin?: string;
  jsonServerUrl?: string;
  fetchImpl?: FetchLike;
  snapshotKey?: string;
  now?: () => Date;
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

const toArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const concatBuffers = (...buffers: Uint8Array[]) => {
  const output = new Uint8Array(buffers.reduce((total, buffer) => total + buffer.byteLength, 0));
  let offset = 0;
  for (const buffer of buffers) {
    output.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return output;
};

const writeUint32 = (value: number) => {
  const bytes = new Uint8Array(uint32Bytes);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

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
    return trimTrailingSlash(configuredUrl);
  }

  const appUrl = new URL(appOrigin);
  if (isLocalHost(appUrl.hostname)) {
    const protocol = appUrl.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${appUrl.hostname}:${localJsonServerPort}`;
  }

  const hostedJsonServerUrl = resolveOfficialHostedJsonServerUrl(appUrl.hostname);
  if (hostedJsonServerUrl) {
    return hostedJsonServerUrl;
  }

  throw new TabulaMcpError(
    "JSON snapshot service URL is required for self-hosted Tabula links. Set TABULA_JSON_URL or pass jsonServerUrl.",
  );
};

export const generateRoomId = () => encodeBase64Url(randomBytes(roomIdBytes));

export const generateRoomKey = () => encodeBase64Url(randomBytes(roomKeyBytes));

export const generateJsonShareKey = () => encodeBase64Url(randomBytes(jsonShareKeyBytes));

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

const createShareSnapshotPayload = ({
  title,
  markdown,
  now = () => new Date(),
}: {
  title?: string;
  markdown: string;
  now?: () => Date;
}): ShareSnapshotPayload => ({
  schemaVersion: shareSnapshotSchemaVersion,
  createdAt: now().toISOString(),
  activeFileId: mainFileId,
  files: [
    {
      id: mainFileId,
      title: title?.trim() || "Untitled Document",
      text: markdown,
    },
  ],
  commentsByFileId: {},
});

const serializeShareSnapshot = (payload: ShareSnapshotPayload) => textEncoder.encode(JSON.stringify(payload));

const importJsonShareKey = async (encodedKey: string) => {
  const rawKey = decodeBase64Url(encodedKey);
  if (rawKey.byteLength !== jsonShareKeyBytes) {
    throw new TabulaMcpError(`JSON share key must decode to ${jsonShareKeyBytes} bytes.`);
  }
  return cryptoImpl.subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, ["encrypt"]);
};

const encodeEncryptedData = async (
  data: Uint8Array,
  {
    encryptionKey,
    metadata,
  }: {
    encryptionKey: string;
    metadata: Record<string, unknown>;
  },
) => {
  const encodingInfoBytes = textEncoder.encode(
    JSON.stringify({
      version: 1,
      encryption: "AES-GCM",
      compression: "none",
    }),
  );
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const plaintext = concatBuffers(writeUint32(metadataBytes.byteLength), metadataBytes, data);
  const iv = new Uint8Array(aesGcmIvBytes);
  cryptoImpl.getRandomValues(iv);
  const encrypted = new Uint8Array(
    await cryptoImpl.subtle.encrypt(
      { name: "AES-GCM", iv },
      await importJsonShareKey(encryptionKey),
      toArrayBuffer(plaintext),
    ),
  );

  return concatBuffers(encryptedDataMagic, writeUint32(encodingInfoBytes.byteLength), encodingInfoBytes, iv, encrypted);
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
  const payload = createShareSnapshotPayload({ title, markdown, now });
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
}: ShareMarkdownDocumentOptions): Promise<SharedMarkdownDocument> => {
  const normalizedJsonServerUrl = resolveJsonShareServerUrl({
    appOrigin,
    jsonServerUrl,
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
