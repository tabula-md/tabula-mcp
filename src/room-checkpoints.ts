import { webcrypto } from "node:crypto";
import { assertProductionEgressAllowed, normalizeServiceUrl } from "./egress-policy.js";
import { sha256Text } from "./crypto.js";
import { decodeBase64Url, TabulaMcpError } from "./protocol.js";
import {
  isWorkspaceRoomState,
  type WorkspaceRoomState,
} from "./room-events.js";
import type { RuntimeEnvironment } from "./env.js";

const checkpointSchema = "tabula.workspace-room-checkpoint";
const checkpointSchemaVersion = 1;
const encryptedDataMagic = new Uint8Array([0x54, 0x42, 0x45, 0x31]);
const uint32Bytes = 4;
const aesGcmIvBytes = 12;
const roomKeyBytes = 32;
const firestoreApiUrl = "https://firestore.googleapis.com";
const firestoreAllowlistEnv = "TABULA_MCP_ALLOWED_FIRESTORE_URLS";
const roomCheckpointCollection = "roomCheckpoints";
const roomCheckpointFormatVersion = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const cryptoImpl = globalThis.crypto ?? webcrypto;

type FetchLike = typeof fetch;

export type WorkspaceRoomCheckpointDocument = {
  id: string;
  title: string;
  markdown: string;
  parentId?: string | null;
};

export type WorkspaceRoomCheckpoint = {
  schema: typeof checkpointSchema;
  version: typeof checkpointSchemaVersion;
  roomId: string;
  createdAt: string;
  updatedAt: string;
  workspace: WorkspaceRoomState;
  documents: WorkspaceRoomCheckpointDocument[];
};

export type RoomCheckpointMetadata = {
  kind: "workspace-room-checkpoint";
  roomId: string;
  schemaVersion: typeof checkpointSchemaVersion;
};

export type RoomCheckpointStoreStatus = {
  enabled: boolean;
  store: "firebase-firestore" | "none";
  status: "disabled" | "missing" | "loaded" | "saved" | "failed";
  checkpointVersion?: number;
  updatedAt?: string;
  error?: string;
};

export type RoomCheckpointStore = {
  readonly enabled: boolean;
  loadEncryptedCheckpoint(roomId: string): Promise<{ encryptedCheckpoint: Uint8Array; status: RoomCheckpointStoreStatus } | null>;
  saveEncryptedCheckpoint(roomId: string, encryptedCheckpoint: Uint8Array): Promise<RoomCheckpointStoreStatus>;
  initialStatus(): RoomCheckpointStoreStatus;
};

type FirebaseConfig = {
  apiKey: string;
  projectId: string;
};

type FirestoreValue = {
  integerValue?: string | number;
  bytesValue?: string;
  timestampValue?: string;
};

type FirestoreDocument = {
  fields?: Record<string, FirestoreValue>;
  updateTime?: string;
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

const readUint32 = (bytes: Uint8Array, offset: number) => {
  if (bytes.byteLength < offset + uint32Bytes) {
    throw new TabulaMcpError("Encrypted room checkpoint is incomplete.");
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, uint32Bytes).getUint32(0, false);
};

const assertMagic = (bytes: Uint8Array) => {
  for (let index = 0; index < encryptedDataMagic.byteLength; index += 1) {
    if (bytes[index] !== encryptedDataMagic[index]) {
      throw new TabulaMcpError("Unsupported encrypted room checkpoint format.");
    }
  }
};

const importRoomCheckpointKey = async (encodedKey: string, usages: KeyUsage[]) => {
  const rawKey = decodeBase64Url(encodedKey);
  if (rawKey.byteLength !== roomKeyBytes) {
    throw new TabulaMcpError(`Room checkpoint key must decode to ${roomKeyBytes} bytes.`);
  }
  return cryptoImpl.subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, usages);
};

const roomCheckpointAdditionalData = (roomId: string) =>
  textEncoder.encode(`tabula.workspace-room-checkpoint:${roomId}`);

const encodeEncryptedData = async <TMetadata extends Record<string, unknown> | null = null>(
  data: Uint8Array,
  {
    encryptionKey,
    metadata,
    additionalData,
  }: {
    encryptionKey: string | CryptoKey;
    metadata?: TMetadata;
    additionalData?: Uint8Array;
  },
) => {
  const encodingInfoBytes = textEncoder.encode(
    JSON.stringify({
      version: 1,
      encryption: "AES-GCM",
      compression: "none",
    }),
  );
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata ?? null));
  const plaintext = concatBuffers(writeUint32(metadataBytes.byteLength), metadataBytes, data);
  const iv = new Uint8Array(aesGcmIvBytes);
  cryptoImpl.getRandomValues(iv);
  const key = typeof encryptionKey === "string"
    ? await importRoomCheckpointKey(encryptionKey, ["encrypt"])
    : encryptionKey;
  const encrypted = new Uint8Array(
    await cryptoImpl.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        ...(additionalData ? { additionalData: toArrayBuffer(additionalData) } : {}),
      },
      key,
      toArrayBuffer(plaintext),
    ),
  );

  return concatBuffers(encryptedDataMagic, writeUint32(encodingInfoBytes.byteLength), encodingInfoBytes, iv, encrypted);
};

const decodeEncryptedData = async <TMetadata extends Record<string, unknown> | null = null>(
  encoded: Uint8Array,
  {
    decryptionKey,
    additionalData,
  }: {
    decryptionKey: string | CryptoKey;
    additionalData?: Uint8Array;
  },
): Promise<{ metadata: TMetadata; data: Uint8Array }> => {
  const view = new Uint8Array(encoded);
  if (view.byteLength < encryptedDataMagic.byteLength + uint32Bytes + aesGcmIvBytes) {
    throw new TabulaMcpError("Encrypted room checkpoint is too short.");
  }

  assertMagic(view);
  const encodingInfoLength = readUint32(view, encryptedDataMagic.byteLength);
  const encodingInfoStart = encryptedDataMagic.byteLength + uint32Bytes;
  const encodingInfoEnd = encodingInfoStart + encodingInfoLength;
  const ivStart = encodingInfoEnd;
  const ivEnd = ivStart + aesGcmIvBytes;
  if (view.byteLength <= ivEnd) {
    throw new TabulaMcpError("Encrypted room checkpoint is incomplete.");
  }

  const encodingInfo = JSON.parse(textDecoder.decode(view.slice(encodingInfoStart, encodingInfoEnd))) as {
    version?: number;
    encryption?: string;
  };
  if (encodingInfo.version !== 1 || encodingInfo.encryption !== "AES-GCM") {
    throw new TabulaMcpError("Unsupported encrypted room checkpoint format.");
  }

  const key = typeof decryptionKey === "string"
    ? await importRoomCheckpointKey(decryptionKey, ["decrypt"])
    : decryptionKey;
  const decrypted = new Uint8Array(
    await cryptoImpl.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(view.slice(ivStart, ivEnd)),
        ...(additionalData ? { additionalData: toArrayBuffer(additionalData) } : {}),
      },
      key,
      toArrayBuffer(view.slice(ivEnd)),
    ),
  );
  const metadataLength = readUint32(decrypted, 0);
  const metadataStart = uint32Bytes;
  const metadataEnd = metadataStart + metadataLength;
  if (decrypted.byteLength < metadataEnd) {
    throw new TabulaMcpError("Encrypted room checkpoint metadata is incomplete.");
  }

  return {
    metadata: JSON.parse(textDecoder.decode(decrypted.slice(metadataStart, metadataEnd))) as TMetadata,
    data: decrypted.slice(metadataEnd),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isWorkspaceRoomCheckpointDocument = (value: unknown): value is WorkspaceRoomCheckpointDocument =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.title === "string" &&
  typeof value.markdown === "string" &&
  (value.parentId === undefined || value.parentId === null || typeof value.parentId === "string");

export const isWorkspaceRoomCheckpoint = (value: unknown): value is WorkspaceRoomCheckpoint => {
  if (
    !isRecord(value) ||
    value.schema !== checkpointSchema ||
    value.version !== checkpointSchemaVersion ||
    typeof value.roomId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isWorkspaceRoomState(value.workspace) ||
    value.workspace.roomId !== value.roomId ||
    !Array.isArray(value.documents) ||
    !value.documents.every(isWorkspaceRoomCheckpointDocument)
  ) {
    return false;
  }

  const documentIds = new Set(value.documents.map((document) => document.id));
  return value.workspace.nodes.every((node) => node.type !== "document" || documentIds.has(node.id));
};

export const encodeWorkspaceRoomCheckpoint = (checkpoint: WorkspaceRoomCheckpoint) =>
  textEncoder.encode(JSON.stringify(checkpoint));

export const decodeWorkspaceRoomCheckpoint = (bytes: Uint8Array): WorkspaceRoomCheckpoint | null => {
  try {
    const decoded = JSON.parse(textDecoder.decode(bytes)) as unknown;
    return isWorkspaceRoomCheckpoint(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

export const createWorkspaceRoomCheckpoint = async ({
  createdAt,
  documents,
  now = () => new Date(),
  roomId,
  workspace,
}: {
  createdAt?: string;
  documents: readonly WorkspaceRoomCheckpointDocument[];
  now?: () => Date;
  roomId: string;
  workspace: WorkspaceRoomState;
}): Promise<WorkspaceRoomCheckpoint> => {
  if (workspace.roomId !== roomId) {
    throw new TabulaMcpError("Workspace roomId must match the room checkpoint roomId.");
  }

  const updatedAt = now().toISOString();
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const checkpointDocuments = await Promise.all(
    workspace.nodes
      .filter((node) => node.type === "document")
      .map(async (node) => {
        const document = documentsById.get(node.id);
        if (!document) {
          throw new TabulaMcpError(`Workspace checkpoint is missing document ${node.id}.`);
        }
        const sha256 = await sha256Text(document.markdown);
        if (sha256 !== node.sha256) {
          throw new TabulaMcpError(`Workspace checkpoint document ${node.id} does not match workspace hash.`);
        }
        return {
          id: document.id,
          title: document.title,
          markdown: document.markdown,
          parentId: document.parentId ?? node.parentId ?? null,
        };
      }),
  );

  return {
    schema: checkpointSchema,
    version: checkpointSchemaVersion,
    roomId,
    createdAt: createdAt ?? updatedAt,
    updatedAt,
    workspace,
    documents: checkpointDocuments,
  };
};

export const encryptWorkspaceRoomCheckpoint = async ({
  checkpoint,
  roomKey,
}: {
  checkpoint: WorkspaceRoomCheckpoint;
  roomKey: string | CryptoKey;
}) =>
  encodeEncryptedData(encodeWorkspaceRoomCheckpoint(checkpoint), {
    encryptionKey: roomKey,
    metadata: {
      kind: "workspace-room-checkpoint",
      roomId: checkpoint.roomId,
      schemaVersion: checkpointSchemaVersion,
    } satisfies RoomCheckpointMetadata,
    additionalData: roomCheckpointAdditionalData(checkpoint.roomId),
  });

export const decryptWorkspaceRoomCheckpoint = async ({
  encryptedCheckpoint,
  roomId,
  roomKey,
}: {
  encryptedCheckpoint: Uint8Array;
  roomId: string;
  roomKey: string | CryptoKey;
}) => {
  const decoded = await decodeEncryptedData<RoomCheckpointMetadata>(encryptedCheckpoint, {
    decryptionKey: roomKey,
    additionalData: roomCheckpointAdditionalData(roomId),
  });

  if (
    decoded.metadata.kind !== "workspace-room-checkpoint" ||
    decoded.metadata.roomId !== roomId ||
    decoded.metadata.schemaVersion !== checkpointSchemaVersion
  ) {
    throw new TabulaMcpError("Room checkpoint metadata does not match this room.");
  }

  const checkpoint = decodeWorkspaceRoomCheckpoint(decoded.data);
  if (!checkpoint || checkpoint.roomId !== roomId) {
    throw new TabulaMcpError("Room checkpoint payload does not match this room.");
  }

  return checkpoint;
};

const parseFirebaseConfig = (rawConfig: string | undefined): FirebaseConfig | null => {
  if (!rawConfig?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    if (!isRecord(parsed) || typeof parsed.projectId !== "string" || typeof parsed.apiKey !== "string") {
      return null;
    }
    return {
      projectId: parsed.projectId,
      apiKey: parsed.apiKey,
    };
  } catch {
    return null;
  }
};

const resolveFirebaseConfig = ({
  env,
  firebaseConfig,
}: {
  env: RuntimeEnvironment;
  firebaseConfig?: string;
}) =>
  parseFirebaseConfig(
    firebaseConfig ??
      env.TABULA_MCP_FIREBASE_CONFIG ??
      env.TABULA_FIREBASE_CONFIG ??
      env.VITE_TABULA_FIREBASE_CONFIG,
  );

const firestoreDocumentName = (projectId: string, roomId: string) =>
  `projects/${projectId}/databases/(default)/documents/${roomCheckpointCollection}/${roomId}`;

const firestoreDocumentUrl = (baseUrl: string, config: FirebaseConfig, roomId: string) =>
  `${baseUrl}/v1/${firestoreDocumentName(config.projectId, encodeURIComponent(roomId))}?key=${encodeURIComponent(config.apiKey)}`;

const firestoreCommitUrl = (baseUrl: string, projectId: string, apiKey: string) =>
  `${baseUrl}/v1/projects/${projectId}/databases/(default)/documents:commit?key=${encodeURIComponent(apiKey)}`;

const integerValue = (value: FirestoreValue | undefined) => {
  const raw = value?.integerValue;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseFirestoreCheckpointDocument = (value: unknown) => {
  if (!isRecord(value) || !isRecord((value as FirestoreDocument).fields)) {
    throw new TabulaMcpError("Invalid Firebase room checkpoint document.");
  }
  const document = value as FirestoreDocument;
  const fields = document.fields ?? {};
  const formatVersion = integerValue(fields.formatVersion);
  const checkpointVersion = integerValue(fields.checkpointVersion);
  const checkpoint = fields.checkpoint?.bytesValue;
  if (
    formatVersion !== roomCheckpointFormatVersion ||
    checkpointVersion === undefined ||
    checkpointVersion < 0 ||
    typeof checkpoint !== "string"
  ) {
    throw new TabulaMcpError("Invalid Firebase room checkpoint document.");
  }

  return {
    checkpointVersion,
    encryptedCheckpoint: new Uint8Array(Buffer.from(checkpoint, "base64")),
    updatedAt: typeof fields.updatedAt?.timestampValue === "string" ? fields.updatedAt.timestampValue : document.updateTime,
  };
};

const readStoreError = async (response: Response) => {
  try {
    const parsed = (await response.json()) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `HTTP ${response.status}`;
};

const safeErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error";

const disabledStore = (): RoomCheckpointStore => ({
  enabled: false,
  async loadEncryptedCheckpoint() {
    return null;
  },
  async saveEncryptedCheckpoint() {
    return this.initialStatus();
  },
  initialStatus() {
    return {
      enabled: false,
      store: "none",
      status: "disabled",
    };
  },
});

export const createFirebaseRoomCheckpointStore = ({
  env = process.env,
  fetchImpl = fetch,
  firebaseConfig,
  firestoreBaseUrl,
}: {
  env?: RuntimeEnvironment;
  fetchImpl?: FetchLike;
  firebaseConfig?: string;
  firestoreBaseUrl?: string;
} = {}): RoomCheckpointStore => {
  const config = resolveFirebaseConfig({ env, firebaseConfig });
  if (!config) {
    return disabledStore();
  }

  const baseUrl = firestoreBaseUrl
    ? assertProductionEgressAllowed({
        allowedUrlsEnvName: firestoreAllowlistEnv,
        defaultAllowedUrls: [firestoreApiUrl],
        env,
        serviceName: "Firebase Firestore",
        trustedUrlEnvNames: ["TABULA_MCP_FIRESTORE_URL"],
        url: firestoreBaseUrl,
      })
    : normalizeServiceUrl(firestoreApiUrl, "Firebase Firestore");

  return {
    enabled: true,
    async loadEncryptedCheckpoint(roomId) {
      const response = await fetchImpl(firestoreDocumentUrl(baseUrl, config, roomId), {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new TabulaMcpError(`Firebase room checkpoint load failed with HTTP ${response.status}: ${await readStoreError(response)}.`);
      }

      const checkpoint = parseFirestoreCheckpointDocument((await response.json()) as unknown);
      return {
        encryptedCheckpoint: checkpoint.encryptedCheckpoint,
        status: {
          enabled: true,
          store: "firebase-firestore",
          status: "loaded",
          checkpointVersion: checkpoint.checkpointVersion,
          ...(checkpoint.updatedAt ? { updatedAt: checkpoint.updatedAt } : {}),
        },
      };
    },
    async saveEncryptedCheckpoint(roomId, encryptedCheckpoint) {
      const response = await fetchImpl(firestoreCommitUrl(baseUrl, config.projectId, config.apiKey), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: firestoreDocumentName(config.projectId, roomId),
                fields: {
                  formatVersion: { integerValue: String(roomCheckpointFormatVersion) },
                  checkpoint: { bytesValue: Buffer.from(encryptedCheckpoint).toString("base64") },
                },
              },
              updateMask: {
                fieldPaths: ["formatVersion", "checkpoint"],
              },
              updateTransforms: [
                {
                  fieldPath: "checkpointVersion",
                  increment: { integerValue: "1" },
                },
                {
                  fieldPath: "updatedAt",
                  setToServerValue: "REQUEST_TIME",
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok) {
        throw new TabulaMcpError(`Firebase room checkpoint save failed with HTTP ${response.status}: ${await readStoreError(response)}.`);
      }

      return {
        enabled: true,
        store: "firebase-firestore",
        status: "saved",
      };
    },
    initialStatus() {
      return {
        enabled: true,
        store: "firebase-firestore",
        status: "missing",
      };
    },
  };
};

export const failedCheckpointStatus = (store: "firebase-firestore" | "none", error: unknown): RoomCheckpointStoreStatus => ({
  enabled: store !== "none",
  store,
  status: "failed",
  error: safeErrorMessage(error),
});
