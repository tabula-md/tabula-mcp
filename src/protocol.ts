export type EnvelopeKind = "yjs-update" | "presence" | "state-init" | "snapshot";

export type EncryptedEnvelope = {
  v: 1;
  roomId: string;
  kind: EnvelopeKind;
  version: number;
  iv: string;
  ciphertext: string;
  createdAt: string;
};

export type ParsedRoomShareUrl = {
  roomId: string;
  roomKey: string;
  appOrigin: string;
  shareUrl: string;
};

export class TabulaMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabulaMcpError";
  }
}

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const ROOM_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const ROOM_KEY_BYTES = 32;
const LOCAL_ROOM_SERVER_PORT = 3002;
const TABULA_MD_ROOM_SERVER_URL = "https://rooms.tabula.md";
const ENVELOPE_KINDS = ["yjs-update", "presence", "state-init", "snapshot"] as const;
const ENVELOPE_FIELDS = new Set(["v", "roomId", "kind", "version", "iv", "ciphertext", "createdAt"]);
const FORBIDDEN_PLAINTEXT_FIELDS = new Set(["roomKey", "key", "plaintext", "markdown", "text", "content"]);
const AES_GCM_IV_BYTES = 12;
const MAX_ENCRYPTED_ENVELOPE_BYTES = 1024 * 1024;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const decodeBase64Url = (value: string) => {
  if (!ROOM_KEY_PATTERN.test(value) || value.length % 4 === 1) {
    throw new TabulaMcpError("Invalid base64url value.");
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) {
    throw new TabulaMcpError("Invalid base64url value.");
  }
  return decoded;
};

export const encodeBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const parseRoomShareUrl = (roomUrl: string): ParsedRoomShareUrl => {
  let url: URL;
  try {
    url = new URL(roomUrl);
  } catch {
    throw new TabulaMcpError("Room URL must be an absolute Tabula room URL.");
  }

  if (url.pathname !== "/") {
    throw new TabulaMcpError("Room URL must use the root /#room=<roomId>,<roomKey> format.");
  }

  const fragment = url.hash.replace(/^#/, "").trim();
  if (!fragment.startsWith("room=")) {
    throw new TabulaMcpError("Room URL must include a client-only #room=<roomId>,<roomKey> fragment.");
  }

  const roomValue = fragment.slice("room=".length);
  const [roomId, roomKey, extra] = roomValue.split(",");
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) {
    throw new TabulaMcpError("Room URL must include a valid room id in the #room fragment.");
  }
  if (extra !== undefined || roomValue.includes("&") || !roomKey || !ROOM_KEY_PATTERN.test(roomKey)) {
    throw new TabulaMcpError("Room URL must include exactly one room id and one room key in the #room fragment.");
  }

  try {
    if (decodeBase64Url(roomKey).byteLength !== ROOM_KEY_BYTES) {
      throw new TabulaMcpError("Room key must decode to 32 bytes.");
    }
  } catch (error) {
    if (error instanceof TabulaMcpError) {
      throw error;
    }
    throw new TabulaMcpError("Room key is not valid base64url.");
  }

  return {
    roomId,
    roomKey,
    appOrigin: url.origin,
    shareUrl: `${url.origin}/#room=${roomId},${roomKey}`,
  };
};

const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

const resolveOfficialHostedRoomServerUrl = (hostname: string) => {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === "tabula.md" || normalizedHostname === "www.tabula.md"
    ? TABULA_MD_ROOM_SERVER_URL
    : undefined;
};

export const resolveRoomServerUrl = ({
  appOrigin,
  roomServerUrl,
  env = process.env,
}: {
  appOrigin: string;
  roomServerUrl?: string;
  env?: NodeJS.ProcessEnv;
}) => {
  const configuredUrl = roomServerUrl?.trim() || env.TABULA_ROOM_URL?.trim() || env.VITE_TABULA_ROOM_URL?.trim();
  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  const appUrl = new URL(appOrigin);
  if (isLocalHost(appUrl.hostname)) {
    const protocol = appUrl.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${appUrl.hostname}:${LOCAL_ROOM_SERVER_PORT}`;
  }

  const officialHostedRoomServerUrl = resolveOfficialHostedRoomServerUrl(appUrl.hostname);
  if (officialHostedRoomServerUrl) {
    return officialHostedRoomServerUrl;
  }

  throw new TabulaMcpError(
    "Room server URL is required for self-hosted Tabula links. Set TABULA_ROOM_URL or pass roomServerUrl.",
  );
};

const validateBase64UrlField = (value: unknown, fieldName: "iv" | "ciphertext", options: { expectedBytes?: number; maxBytes?: number } = {}) => {
  if (typeof value !== "string") {
    throw new TabulaMcpError("Encrypted room envelope is not valid for this room.");
  }

  const decoded = decodeBase64Url(value);
  if (options.expectedBytes !== undefined && decoded.byteLength !== options.expectedBytes) {
    throw new TabulaMcpError(`Encrypted room envelope has an invalid ${fieldName}.`);
  }
  if (options.maxBytes !== undefined && decoded.byteLength > options.maxBytes) {
    throw new TabulaMcpError("Encrypted room envelope is too large.");
  }

  return value;
};

export const assertEncryptedEnvelope = (value: unknown, expectedRoomId: string, expectedKind?: EnvelopeKind) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TabulaMcpError("Encrypted room envelope must be an object.");
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PLAINTEXT_FIELDS.has(key) || !ENVELOPE_FIELDS.has(key)) {
      throw new TabulaMcpError("Encrypted room envelope is not valid for this room.");
    }
  }

  const envelope = value as Partial<EncryptedEnvelope>;
  const version = envelope.version;
  if (
    envelope.v !== 1 ||
    envelope.roomId !== expectedRoomId ||
    (expectedKind && envelope.kind !== expectedKind) ||
    !ENVELOPE_KINDS.includes(envelope.kind as EnvelopeKind) ||
    !Number.isSafeInteger(version) ||
    version === undefined ||
    version < 0 ||
    typeof envelope.createdAt !== "string" ||
    !ISO_UTC_TIMESTAMP_PATTERN.test(envelope.createdAt)
  ) {
    throw new TabulaMcpError("Encrypted room envelope is not valid for this room.");
  }

  validateBase64UrlField(envelope.iv, "iv", { expectedBytes: AES_GCM_IV_BYTES });
  validateBase64UrlField(envelope.ciphertext, "ciphertext", { maxBytes: MAX_ENCRYPTED_ENVELOPE_BYTES });

  return envelope as EncryptedEnvelope;
};
