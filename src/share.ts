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
  roomServerUrl: string;
  shareUrl: string;
  textLength: number;
  sha256: string;
  encrypted: true;
  snapshotVersion: number;
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
  const url = new URL(`/r/${encodeURIComponent(roomId)}`, appOrigin);
  url.hash = new URLSearchParams({ key: roomKey }).toString();
  return url.toString();
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
  const snapshotUrl = `${trimTrailingSlash(resolvedRoomServerUrl)}/v1/rooms/${encodeURIComponent(roomId)}/snapshot`;
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
    roomServerUrl: trimTrailingSlash(resolvedRoomServerUrl),
    shareUrl: createRoomShareUrl({ appOrigin, roomId, roomKey }),
    textLength: markdown.length,
    sha256: await sha256Text(markdown),
    encrypted: true,
    snapshotVersion: envelope.version,
  };
};
