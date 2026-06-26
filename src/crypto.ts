import { webcrypto } from "node:crypto";
import type { EncryptedEnvelope, EnvelopeKind } from "./protocol.js";
import { decodeBase64Url, encodeBase64Url } from "./protocol.js";

const AES_GCM_IV_BYTES = 12;
const cryptoImpl = globalThis.crypto ?? webcrypto;

const toArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export const importRoomKey = async (encodedKey: string) => {
  const rawKey = decodeBase64Url(encodedKey);
  return cryptoImpl.subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, ["encrypt", "decrypt"]);
};

export const encryptBytesForRoom = async (
  roomKey: CryptoKey,
  roomId: string,
  kind: EnvelopeKind,
  version: number,
  plaintext: Uint8Array,
): Promise<EncryptedEnvelope> => {
  const iv = new Uint8Array(AES_GCM_IV_BYTES);
  cryptoImpl.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await cryptoImpl.subtle.encrypt({ name: "AES-GCM", iv }, roomKey, toArrayBuffer(plaintext)),
  );

  return {
    v: 1,
    roomId,
    kind,
    version,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
    createdAt: new Date().toISOString(),
  };
};

export const decryptEnvelopeForRoom = async (roomKey: CryptoKey, envelope: EncryptedEnvelope) => {
  const iv = decodeBase64Url(envelope.iv);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  return new Uint8Array(
    await cryptoImpl.subtle.decrypt({ name: "AES-GCM", iv }, roomKey, toArrayBuffer(ciphertext)),
  );
};

export const sha256Text = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", bytes));
  return encodeBase64Url(digest);
};
