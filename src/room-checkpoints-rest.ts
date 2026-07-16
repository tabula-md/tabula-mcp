import { randomBytes } from "node:crypto";
import type {
  SaveWorkspaceRoomCheckpointRequest,
  WorkspaceRoomCheckpointStore,
} from "@tabula-md/tabula/collaboration";

export type FirebaseRestConfig = {
  apiKey: string;
  projectId: string;
  storageBucket: string;
};

type FirebaseRestRoomCheckpointPointer = {
  formatVersion: 2;
  generation: number;
  blobPath: string;
  byteLength: number;
  expiresAt: number;
  updateTime: string;
};

type FirestoreRestValue = {
  integerValue?: string;
  stringValue?: string;
  timestampValue?: string;
};

type FirestoreRestDocument = {
  fields?: Record<string, FirestoreRestValue>;
  updateTime?: string;
};

const roomCheckpointFormatVersion = 2;
const roomCheckpointCollection = "roomCheckpointPointers";

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
};

const readRestInteger = (value: FirestoreRestValue | undefined) => {
  const parsed = Number(value?.integerValue);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const readRestPointer = (value: unknown): FirebaseRestRoomCheckpointPointer => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Firebase room checkpoint pointer.");
  }
  const document = value as FirestoreRestDocument;
  const fields = document.fields;
  const formatVersion = readRestInteger(fields?.formatVersion);
  const generation = readRestInteger(fields?.generation);
  const blobPath = fields?.blobPath?.stringValue;
  const byteLength = readRestInteger(fields?.byteLength);
  const expiresAt = Date.parse(fields?.expiresAt?.timestampValue ?? "");
  if (
    formatVersion !== roomCheckpointFormatVersion ||
    generation === null || generation < 1 ||
    typeof blobPath !== "string" || !blobPath.startsWith("roomCheckpoints/") ||
    byteLength === null || byteLength < 1 ||
    !Number.isFinite(expiresAt) ||
    typeof document.updateTime !== "string" || !Number.isFinite(Date.parse(document.updateTime))
  ) {
    throw new Error("Invalid Firebase room checkpoint pointer.");
  }
  return {
    formatVersion: roomCheckpointFormatVersion,
    generation,
    blobPath,
    byteLength,
    expiresAt,
    updateTime: document.updateTime,
  };
};

const firebaseRequestError = (operation: string, response: Response) =>
  new Error(`${operation} failed (${response.status}).`);

export const createFirebaseRestWorkspaceRoomCheckpointStore = (
  config: FirebaseRestConfig,
  fetchImpl: typeof fetch = fetch,
): WorkspaceRoomCheckpointStore => {
  const storageRoot = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(config.storageBucket)}/o`;
  const databaseRoot = `projects/${config.projectId}/databases/(default)`;
  const firestoreRoot = `https://firestore.googleapis.com/v1/${databaseRoot}`;
  const withKey = (url: URL) => {
    url.searchParams.set("key", config.apiKey);
    return url;
  };
  const pointerUrl = (roomId: string) => withKey(new URL(
    `${firestoreRoot}/documents/${roomCheckpointCollection}/${encodeURIComponent(roomId)}`,
  ));
  const pointerName = (roomId: string) =>
    `${databaseRoot}/documents/${roomCheckpointCollection}/${roomId}`;
  const commitUrl = () => withKey(new URL(`${firestoreRoot}/documents:commit`));
  const blobCollectionUrl = (blobPath: string) => {
    const url = withKey(new URL(storageRoot));
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", blobPath);
    return url;
  };
  const blobUrl = (blobPath: string, download = false) => {
    const url = withKey(new URL(`${storageRoot}/${encodeURIComponent(blobPath)}`));
    if (download) url.searchParams.set("alt", "media");
    return url;
  };
  const readPointerDocument = async (roomId: string, signal?: AbortSignal) => {
    const response = await fetchImpl(pointerUrl(roomId), { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw firebaseRequestError("Firebase checkpoint pointer read", response);
    return readRestPointer(await response.json());
  };
  const deleteBlob = async (blobPath: string) => {
    await fetchImpl(blobUrl(blobPath), { method: "DELETE" }).catch(() => undefined);
  };

  return {
    enabled: true,
    async loadEncryptedCheckpoint(roomId: string, signal?: AbortSignal) {
      let failedPointer: FirebaseRestRoomCheckpointPointer | null = null;
      let failedRead: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(signal);
        const pointer = await readPointerDocument(roomId, signal);
        if (!pointer) return null;
        if (
          failedPointer &&
          failedPointer.generation === pointer.generation &&
          failedPointer.blobPath === pointer.blobPath
        ) {
          throw failedRead;
        }
        if (pointer.expiresAt <= Date.now()) {
          return { status: "expired", generation: pointer.generation, expiresAt: pointer.expiresAt };
        }
        try {
          const response = await fetchImpl(blobUrl(pointer.blobPath, true), { signal });
          if (!response.ok) throw firebaseRequestError("Firebase checkpoint blob read", response);
          const encryptedCheckpoint = new Uint8Array(await response.arrayBuffer());
          throwIfAborted(signal);
          if (encryptedCheckpoint.byteLength !== pointer.byteLength) {
            throw new Error("Room checkpoint blob length does not match its pointer.");
          }
          return {
            status: "ready",
            generation: pointer.generation,
            encryptedCheckpoint,
            expiresAt: pointer.expiresAt,
          };
        } catch (error) {
          failedPointer = pointer;
          failedRead = error;
        }
      }
      throw failedRead;
    },
    async saveEncryptedCheckpoint(
      roomId: string,
      request: SaveWorkspaceRoomCheckpointRequest,
      signal?: AbortSignal,
    ) {
      throwIfAborted(signal);
      const blobPath = `roomCheckpoints/${roomId}/${randomBytes(16).toString("hex")}.bin`;
      const uploadResponse = await fetchImpl(blobCollectionUrl(blobPath), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Uint8Array.from(request.encryptedCheckpoint).buffer,
        signal,
      });
      if (!uploadResponse.ok) throw firebaseRequestError("Firebase checkpoint blob upload", uploadResponse);
      throwIfAborted(signal);

      try {
        const previous = await readPointerDocument(roomId, signal);
        const generation = previous?.generation ?? 0;
        if (generation !== request.expectedGeneration) {
          await deleteBlob(blobPath);
          return { ok: false, reason: "conflict", generation };
        }
        const nextGeneration = generation + 1;
        const write = {
          update: {
            name: pointerName(roomId),
            fields: {
              formatVersion: { integerValue: String(roomCheckpointFormatVersion) },
              generation: { integerValue: String(nextGeneration) },
              blobPath: { stringValue: blobPath },
              byteLength: { integerValue: String(request.encryptedCheckpoint.byteLength) },
              expiresAt: { timestampValue: new Date(request.expiresAt).toISOString() },
            },
          },
          currentDocument: previous ? { updateTime: previous.updateTime } : { exists: false },
          updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
        };
        const commitResponse = await fetchImpl(commitUrl(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ writes: [write] }),
          signal,
        });
        if (!commitResponse.ok) {
          const latest = await readPointerDocument(roomId, signal);
          const latestGeneration = latest?.generation ?? 0;
          if (latestGeneration !== generation) {
            await deleteBlob(blobPath);
            return { ok: false, reason: "conflict", generation: latestGeneration };
          }
          throw firebaseRequestError("Firebase checkpoint pointer write", commitResponse);
        }
        if (previous?.blobPath && previous.blobPath !== blobPath) {
          await deleteBlob(previous.blobPath);
        }
        return { ok: true, generation: nextGeneration };
      } catch (error) {
        await deleteBlob(blobPath);
        throw error;
      }
    },
  };
};
