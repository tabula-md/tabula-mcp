export type EnvelopeKind = "yjs-update" | "presence" | "snapshot";

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

export const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const decodeBase64Url = (value: string) => {
  if (!ROOM_KEY_PATTERN.test(value) || value.length % 4 === 1) {
    throw new TabulaMcpError("Invalid base64url value.");
  }

  return Buffer.from(value, "base64url");
};

export const encodeBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const parseRoomShareUrl = (roomUrl: string): ParsedRoomShareUrl => {
  let url: URL;
  try {
    url = new URL(roomUrl);
  } catch {
    throw new TabulaMcpError("Room URL must be an absolute Tabula room URL.");
  }

  const roomId = url.pathname.match(/^\/r\/([^/]+)\/?$/)?.[1];
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) {
    throw new TabulaMcpError("Room URL must use /r/:roomId with a valid room id.");
  }

  const roomKey = new URLSearchParams(url.hash.replace(/^#/, "")).get("key")?.trim();
  if (!roomKey || !ROOM_KEY_PATTERN.test(roomKey)) {
    throw new TabulaMcpError("Room URL must include a client-only #key fragment.");
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

export const assertEncryptedEnvelope = (value: unknown, expectedRoomId: string, expectedKind?: EnvelopeKind) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TabulaMcpError("Encrypted room envelope must be an object.");
  }

  const envelope = value as Partial<EncryptedEnvelope>;
  if (
    envelope.v !== 1 ||
    envelope.roomId !== expectedRoomId ||
    (expectedKind && envelope.kind !== expectedKind) ||
    !["yjs-update", "presence", "snapshot"].includes(String(envelope.kind)) ||
    typeof envelope.version !== "number" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.createdAt !== "string"
  ) {
    throw new TabulaMcpError("Encrypted room envelope is not valid for this room.");
  }

  return envelope as EncryptedEnvelope;
};
