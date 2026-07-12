import { describe, expect, it, vi } from "vitest";
import { sha256Text } from "../src/crypto.js";
import {
  createFirebaseRoomCheckpointStore,
  createWorkspaceRoomCheckpoint,
  decryptWorkspaceRoomCheckpoint,
  encryptWorkspaceRoomCheckpoint,
} from "../src/room-checkpoints.js";
import type { WorkspaceRoomState } from "../src/room-events.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const firebaseConfig = JSON.stringify({
  apiKey: "firebase-api-key",
  projectId: "tabula-test",
});

const createWorkspaceState = async (markdown = "# Draft\n"): Promise<WorkspaceRoomState> => {
  const createdAt = "2026-07-09T00:00:00.000Z";
  return {
    roomId: "room_123",
    mode: "workspace",
    version: 1,
    rootId: "root",
    activeDocumentId: "doc_1",
    nodes: [
      {
        id: "root",
        type: "folder",
        parentId: null,
        title: "Workspace",
        order: 0,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "doc_1",
        type: "document",
        parentId: "root",
        title: "Draft.md",
        sha256: await sha256Text(markdown),
        textLength: markdown.length,
        order: 0,
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
};

describe("workspace room checkpoints", () => {
  it("encrypts and decrypts canonical Tabula workspace room checkpoints", async () => {
    const checkpoint = await createWorkspaceRoomCheckpoint({
      roomId: "room_123",
      workspace: await createWorkspaceState("# Draft\n"),
      documents: [
        {
          id: "doc_1",
          title: "Draft.md",
          markdown: "# Draft\n",
          parentId: "root",
        },
      ],
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const encrypted = await encryptWorkspaceRoomCheckpoint({ checkpoint, roomKey });
    const encryptedText = Buffer.from(encrypted).toString("utf8");
    expect(encrypted.slice(0, 4)).toEqual(new Uint8Array([0x54, 0x42, 0x45, 0x31]));
    expect(encryptedText).not.toContain("# Draft");
    expect(encryptedText).not.toContain(roomKey);

    await expect(
      decryptWorkspaceRoomCheckpoint({
        encryptedCheckpoint: encrypted,
        roomId: "room_123",
        roomKey,
      }),
    ).resolves.toEqual(checkpoint);
    await expect(
      decryptWorkspaceRoomCheckpoint({
        encryptedCheckpoint: encrypted,
        roomId: "different-room",
        roomKey,
      }),
    ).rejects.toThrow();
  });

  it("stores encrypted checkpoints through Firestore REST without plaintext or room keys", async () => {
    const checkpoint = await createWorkspaceRoomCheckpoint({
      roomId: "room_123",
      workspace: await createWorkspaceState("# Draft\n"),
      documents: [
        {
          id: "doc_1",
          title: "Draft.md",
          markdown: "# Draft\n",
          parentId: "root",
        },
      ],
    });
    const encrypted = await encryptWorkspaceRoomCheckpoint({ checkpoint, roomKey });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ writeResults: [{}] }), { status: 200 }));
    const store = createFirebaseRoomCheckpointStore({
      env: {},
      fetchImpl: fetchMock as typeof fetch,
      firebaseConfig,
    });

    await expect(store.saveEncryptedCheckpoint("room_123", encrypted)).resolves.toMatchObject({
      enabled: true,
      store: "firebase-firestore",
      status: "saved",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://firestore.googleapis.com/v1/projects/tabula-test/databases/(default)/documents:commit?key=firebase-api-key",
    );
    const body = JSON.stringify(JSON.parse(String((init as RequestInit).body)));
    expect(body).toContain("roomCheckpoints/room_123");
    expect(body).toContain("bytesValue");
    expect(body).toContain("REQUEST_TIME");
    expect(body).not.toContain("# Draft");
    expect(body).not.toContain(roomKey);
  });

  it("loads encrypted checkpoints from Firestore REST by public room id", async () => {
    const checkpoint = await createWorkspaceRoomCheckpoint({
      roomId: "room_123",
      workspace: await createWorkspaceState("# Draft\n"),
      documents: [
        {
          id: "doc_1",
          title: "Draft.md",
          markdown: "# Draft\n",
          parentId: "root",
        },
      ],
    });
    const encrypted = await encryptWorkspaceRoomCheckpoint({ checkpoint, roomKey });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          fields: {
            formatVersion: { integerValue: "1" },
            checkpointVersion: { integerValue: "3" },
            checkpoint: { bytesValue: Buffer.from(encrypted).toString("base64") },
            updatedAt: { timestampValue: "2026-07-09T00:00:00.000Z" },
          },
        }),
        { status: 200 },
      ),
    );
    const store = createFirebaseRoomCheckpointStore({
      env: {},
      fetchImpl: fetchMock as typeof fetch,
      firebaseConfig,
    });

    const loaded = await store.loadEncryptedCheckpoint("room_123");
    expect(loaded?.status).toMatchObject({
      enabled: true,
      store: "firebase-firestore",
      status: "loaded",
      checkpointVersion: 3,
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    expect(loaded?.encryptedCheckpoint).toEqual(encrypted);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://firestore.googleapis.com/v1/projects/tabula-test/databases/(default)/documents/roomCheckpoints/room_123?key=firebase-api-key",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });
});
