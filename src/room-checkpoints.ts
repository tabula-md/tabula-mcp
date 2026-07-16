import { randomBytes } from "node:crypto";
import {
  initializeApp,
  getApps,
  type FirebaseOptions,
} from "@firebase/app";
import {
  Timestamp,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  serverTimestamp,
} from "@firebase/firestore";
import {
  connectStorageEmulator,
  deleteObject,
  getBytes,
  getStorage,
  ref,
  uploadBytes,
} from "@firebase/storage";
import type {
  LoadedWorkspaceRoomCheckpoint,
  SaveWorkspaceRoomCheckpointRequest,
  SaveWorkspaceRoomCheckpointResult,
  WorkspaceRoomCheckpointStore,
} from "@tabula-md/tabula/collaboration";
import {
  createFirebaseRestWorkspaceRoomCheckpointStore,
  type FirebaseRestConfig,
} from "./room-checkpoints-rest.js";

type FirebaseRoomCheckpointPointer = {
  formatVersion: 2;
  generation: number;
  blobPath: string;
  byteLength: number;
  updatedAt?: unknown;
  expiresAt: Timestamp;
};

const firebaseAppName = "tabula-mcp-room-checkpoint-v2";
const roomCheckpointFormatVersion = 2;
const roomCheckpointCollection = "roomCheckpointPointers";
const connectedEmulators = new Set<string>();

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
};

const createDisabledStore = (): WorkspaceRoomCheckpointStore => ({
  enabled: false,
  async loadEncryptedCheckpoint() {
    return null;
  },
  async saveEncryptedCheckpoint() {
    throw new Error("Live room persistence is unavailable.");
  },
});

const parseFirebaseConfig = (env: NodeJS.ProcessEnv): FirebaseOptions | null => {
  const raw = env.TABULA_MCP_FIREBASE_CONFIG ?? env.TABULA_FIREBASE_CONFIG ?? env.VITE_TABULA_FIREBASE_CONFIG;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as FirebaseOptions
      : null;
  } catch {
    return null;
  }
};

const readPointer = (value: unknown): FirebaseRoomCheckpointPointer => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Firebase room checkpoint pointer.");
  }
  const pointer = value as Partial<FirebaseRoomCheckpointPointer>;
  if (
    pointer.formatVersion !== roomCheckpointFormatVersion ||
    !Number.isSafeInteger(pointer.generation) ||
    pointer.generation === undefined ||
    pointer.generation < 1 ||
    typeof pointer.blobPath !== "string" ||
    !pointer.blobPath.startsWith("roomCheckpoints/") ||
    !Number.isSafeInteger(pointer.byteLength) ||
    pointer.byteLength === undefined ||
    pointer.byteLength < 1 ||
    !(pointer.expiresAt instanceof Timestamp)
  ) {
    throw new Error("Invalid Firebase room checkpoint pointer.");
  }
  return pointer as FirebaseRoomCheckpointPointer;
};

const parseFirebaseRestConfig = (config: FirebaseOptions): FirebaseRestConfig | null => {
  const { apiKey, projectId, storageBucket } = config;
  return typeof apiKey === "string" && apiKey.length > 0 &&
    typeof projectId === "string" && projectId.length > 0 &&
    typeof storageBucket === "string" && storageBucket.length > 0
    ? { apiKey, projectId, storageBucket }
    : null;
};

const createFirebaseSdkWorkspaceRoomCheckpointStore = (
  config: FirebaseOptions,
  env: NodeJS.ProcessEnv,
  emulatorHost: string,
): WorkspaceRoomCheckpointStore => {
  const app = getApps().find((candidate) => candidate.name === firebaseAppName) ??
    initializeApp(config, firebaseAppName);
  const firestore = getFirestore(app);
  const storage = getStorage(app);
  if (!connectedEmulators.has(app.name)) {
    connectFirestoreEmulator(
      firestore,
      emulatorHost,
      Number(env.TABULA_MCP_FIRESTORE_EMULATOR_PORT ?? env.VITE_TABULA_FIRESTORE_EMULATOR_PORT ?? 8080),
    );
    connectStorageEmulator(
      storage,
      emulatorHost,
      Number(env.TABULA_MCP_FIREBASE_STORAGE_EMULATOR_PORT ?? env.VITE_TABULA_FIREBASE_STORAGE_EMULATOR_PORT ?? 9199),
    );
    connectedEmulators.add(app.name);
  }

  return {
    enabled: true,
    async loadEncryptedCheckpoint(roomId: string, signal?: AbortSignal) {
      let failedPointer: FirebaseRoomCheckpointPointer | null = null;
      let failedRead: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(signal);
        const snapshot = await getDoc(doc(firestore, roomCheckpointCollection, roomId));
        throwIfAborted(signal);
        if (!snapshot.exists()) return null;
        const pointer = readPointer(snapshot.data());
        if (
          failedPointer &&
          failedPointer.generation === pointer.generation &&
          failedPointer.blobPath === pointer.blobPath
        ) {
          throw failedRead;
        }
        const expiresAt = pointer.expiresAt.toMillis();
        if (expiresAt <= Date.now()) {
          return { status: "expired", generation: pointer.generation, expiresAt };
        }
        try {
          const bytes = await getBytes(ref(storage, pointer.blobPath));
          throwIfAborted(signal);
          if (bytes.byteLength !== pointer.byteLength) {
            throw new Error("Room checkpoint blob length does not match its pointer.");
          }
          return {
            status: "ready",
            generation: pointer.generation,
            encryptedCheckpoint: new Uint8Array(bytes),
            expiresAt,
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
      const blobRef = ref(storage, blobPath);
      await uploadBytes(blobRef, request.encryptedCheckpoint, {
        contentType: "application/octet-stream",
      });
      throwIfAborted(signal);
      let previousBlobPath: string | null = null;
      try {
        const result = await runTransaction(firestore, async (transaction) => {
          const pointerRef = doc(firestore, roomCheckpointCollection, roomId);
          const snapshot = await transaction.get(pointerRef);
          const previous = snapshot.exists() ? readPointer(snapshot.data()) : null;
          const generation = previous?.generation ?? 0;
          if (generation !== request.expectedGeneration) {
            return { ok: false as const, reason: "conflict" as const, generation };
          }
          previousBlobPath = previous?.blobPath ?? null;
          const nextGeneration = generation + 1;
          transaction.set(pointerRef, {
            formatVersion: roomCheckpointFormatVersion,
            generation: nextGeneration,
            blobPath,
            byteLength: request.encryptedCheckpoint.byteLength,
            updatedAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(request.expiresAt),
          } satisfies FirebaseRoomCheckpointPointer);
          return { ok: true as const, generation: nextGeneration };
        });
        if (!result.ok) {
          await deleteObject(blobRef).catch(() => undefined);
          return result;
        }
        if (previousBlobPath && previousBlobPath !== blobPath) {
          await deleteObject(ref(storage, previousBlobPath)).catch(() => undefined);
        }
        return result;
      } catch (error) {
        await deleteObject(blobRef).catch(() => undefined);
        throw error;
      }
    },
  };
};

export const createFirebaseWorkspaceRoomCheckpointStore = (
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRoomCheckpointStore => {
  const config = parseFirebaseConfig(env);
  if (!config) return createDisabledStore();
  const emulatorHost = env.TABULA_MCP_FIREBASE_EMULATOR_HOST ?? env.VITE_TABULA_FIREBASE_EMULATOR_HOST;
  if (emulatorHost) {
    return createFirebaseSdkWorkspaceRoomCheckpointStore(config, env, emulatorHost);
  }
  const restConfig = parseFirebaseRestConfig(config);
  return restConfig ? createFirebaseRestWorkspaceRoomCheckpointStore(restConfig) : createDisabledStore();
};

export const createMemoryWorkspaceRoomCheckpointStore = (): WorkspaceRoomCheckpointStore & {
  read(roomId: string): LoadedWorkspaceRoomCheckpoint | null;
} => {
  const values = new Map<string, LoadedWorkspaceRoomCheckpoint>();
  return {
    enabled: true,
    read(roomId: string) {
      return values.get(roomId) ?? null;
    },
    async loadEncryptedCheckpoint(roomId: string) {
      return values.get(roomId) ?? null;
    },
    async saveEncryptedCheckpoint(roomId: string, request: SaveWorkspaceRoomCheckpointRequest) {
      const current = values.get(roomId);
      const generation = current?.generation ?? 0;
      if (generation !== request.expectedGeneration) {
        return { ok: false, reason: "conflict", generation };
      }
      const nextGeneration = generation + 1;
      values.set(roomId, {
        status: "ready",
        generation: nextGeneration,
        encryptedCheckpoint: request.encryptedCheckpoint.slice(),
        expiresAt: request.expiresAt,
      });
      return { ok: true, generation: nextGeneration };
    },
  };
};

export type {
  LoadedWorkspaceRoomCheckpoint,
  SaveWorkspaceRoomCheckpointRequest,
  SaveWorkspaceRoomCheckpointResult,
  WorkspaceRoomCheckpointStore,
};
