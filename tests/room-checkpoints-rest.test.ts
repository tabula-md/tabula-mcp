import { describe, expect, it, vi } from "vitest";
import { createFirebaseRestWorkspaceRoomCheckpointStore } from "../src/room-checkpoints-rest.js";

const config = {
  apiKey: "public-api-key",
  projectId: "tabula-test",
  storageBucket: "tabula-test.firebasestorage.app",
};

const pointerDocument = ({
  blobPath = "roomCheckpoints/room-1/0123456789abcdef0123456789abcdef.bin",
  byteLength = 4,
  generation = 1,
}: {
  blobPath?: string;
  byteLength?: number;
  generation?: number;
} = {}) => ({
  fields: {
    formatVersion: { integerValue: "2" },
    generation: { integerValue: String(generation) },
    blobPath: { stringValue: blobPath },
    byteLength: { integerValue: String(byteLength) },
    expiresAt: { timestampValue: new Date(Date.now() + 60_000).toISOString() },
  },
  updateTime: new Date().toISOString(),
});

const queuedFetch = (responses: Response[]) => vi.fn(async () => {
  const response = responses.shift();
  if (!response) throw new Error("Unexpected fetch call.");
  return response;
}) as unknown as typeof fetch;

describe("Firebase REST room checkpoints", () => {
  it("creates a pointer with a server timestamp and loads its encrypted blob", async () => {
    const saveFetch = queuedFetch([
      Response.json({ name: "uploaded" }),
      new Response(null, { status: 404 }),
      Response.json({ writeResults: [{}] }),
    ]);
    const store = createFirebaseRestWorkspaceRoomCheckpointStore(config, saveFetch);
    const saved = await store.saveEncryptedCheckpoint("room-1", {
      expectedGeneration: 0,
      encryptedCheckpoint: new Uint8Array([1, 2, 3, 4]),
      expiresAt: Date.now() + 60_000,
    });

    expect(saved).toEqual({ ok: true, generation: 1 });
    const saveCalls = vi.mocked(saveFetch).mock.calls;
    expect(saveCalls).toHaveLength(3);
    const commit = JSON.parse(String(saveCalls[2]?.[1]?.body));
    expect(commit.writes[0].currentDocument).toEqual({ exists: false });
    expect(commit.writes[0].updateTransforms).toEqual([
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
    ]);

    const loadFetch = queuedFetch([
      Response.json(pointerDocument()),
      new Response(new Uint8Array([1, 2, 3, 4])),
    ]);
    const loaded = await createFirebaseRestWorkspaceRoomCheckpointStore(config, loadFetch)
      .loadEncryptedCheckpoint("room-1");

    expect(loaded).toMatchObject({
      status: "ready",
      generation: 1,
      encryptedCheckpoint: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("removes an uploaded blob when the expected generation is stale", async () => {
    const fetchImpl = queuedFetch([
      Response.json({ name: "uploaded" }),
      Response.json(pointerDocument({ generation: 2 })),
      new Response(null, { status: 204 }),
    ]);
    const result = await createFirebaseRestWorkspaceRoomCheckpointStore(config, fetchImpl)
      .saveEncryptedCheckpoint("room-1", {
        expectedGeneration: 0,
        encryptedCheckpoint: new Uint8Array([1, 2, 3, 4]),
        expiresAt: Date.now() + 60_000,
      });

    expect(result).toEqual({ ok: false, reason: "conflict", generation: 2 });
    expect(vi.mocked(fetchImpl).mock.calls[2]?.[1]?.method).toBe("DELETE");
  });

  it("turns a failed compare-and-set into a recoverable generation conflict", async () => {
    const fetchImpl = queuedFetch([
      Response.json({ name: "uploaded" }),
      Response.json(pointerDocument({ generation: 1 })),
      new Response(null, { status: 409 }),
      Response.json(pointerDocument({ generation: 2 })),
      new Response(null, { status: 204 }),
    ]);
    const result = await createFirebaseRestWorkspaceRoomCheckpointStore(config, fetchImpl)
      .saveEncryptedCheckpoint("room-1", {
        expectedGeneration: 1,
        encryptedCheckpoint: new Uint8Array([1, 2, 3, 4]),
        expiresAt: Date.now() + 60_000,
      });

    expect(result).toEqual({ ok: false, reason: "conflict", generation: 2 });
  });

  it("does not expose the Firebase API key in request failures", async () => {
    const fetchImpl = queuedFetch([new Response(null, { status: 403 })]);
    await expect(createFirebaseRestWorkspaceRoomCheckpointStore(config, fetchImpl)
      .loadEncryptedCheckpoint("room-1"))
      .rejects.toThrow("Firebase checkpoint pointer read failed (403).");
    await expect(createFirebaseRestWorkspaceRoomCheckpointStore(config, queuedFetch([
      new Response(null, { status: 403 }),
    ])).loadEncryptedCheckpoint("room-1"))
      .rejects.not.toThrow(config.apiKey);
  });
});
