import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import {
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "./crypto.js";
import {
  encodeBase64Url,
  resolveRoomServerUrl,
  TabulaMcpError,
  trimTrailingSlash,
  type EncryptedEnvelope,
} from "./protocol.js";

const defaultTabulaAppOrigin = "https://tabula.md";
const roomIdBytes = 16;
const roomKeyBytes = 32;

type FetchLike = typeof fetch;

export type ShareMarkdownDocumentOptions = {
  title?: string;
  markdown: string;
  appOrigin?: string;
  roomServerUrl?: string;
  fetchImpl?: FetchLike;
  roomId?: string;
  roomKey?: string;
};

export type SharedMarkdownDocument = {
  title: string;
  roomId: string;
  appOrigin: string;
  roomServerUrl: string;
  roomUrl: string;
  shareUrl: string;
  textLength: number;
  sha256: string;
  encrypted: true;
  secret: true;
  keyLocation: "url-fragment";
  snapshotVersion: number;
  connect: {
    tool: "tabula_connect_room";
    arguments: {
      roomUrl: string;
      roomServerUrl: string;
    };
  };
};

export const generateRoomId = () => encodeBase64Url(randomBytes(roomIdBytes));

export const generateRoomKey = () => encodeBase64Url(randomBytes(roomKeyBytes));

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

export const shareMarkdownDocument = async ({
  title,
  markdown,
  appOrigin = defaultTabulaAppOrigin,
  roomServerUrl,
  fetchImpl = fetch,
  roomId = generateRoomId(),
  roomKey = generateRoomKey(),
}: ShareMarkdownDocumentOptions): Promise<SharedMarkdownDocument> => {
  const resolvedRoomServerUrl = resolveRoomServerUrl({
    appOrigin,
    roomServerUrl,
  });
  const envelope = await createEncryptedMarkdownSnapshot({ roomId, roomKey, markdown });
  const normalizedRoomServerUrl = trimTrailingSlash(resolvedRoomServerUrl);
  const shareUrl = createRoomShareUrl({ appOrigin, roomId, roomKey });
  const snapshotUrl = `${normalizedRoomServerUrl}/v1/rooms/${encodeURIComponent(roomId)}/snapshot`;
  const response = await fetchImpl(snapshotUrl, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
  });

  if (!response.ok) {
    throw new TabulaMcpError(`Encrypted Tabula.md share upload failed with HTTP ${response.status}.`);
  }

  return {
    title: title?.trim() || "Untitled Document",
    roomId,
    appOrigin,
    roomServerUrl: normalizedRoomServerUrl,
    roomUrl: shareUrl,
    shareUrl,
    textLength: markdown.length,
    sha256: await sha256Text(markdown),
    encrypted: true,
    secret: true,
    keyLocation: "url-fragment",
    snapshotVersion: envelope.version,
    connect: {
      tool: "tabula_connect_room",
      arguments: {
        roomUrl: shareUrl,
        roomServerUrl: normalizedRoomServerUrl,
      },
    },
  };
};
