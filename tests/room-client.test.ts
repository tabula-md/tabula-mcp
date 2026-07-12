import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  decryptEnvelopeForRoom,
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "../src/crypto.js";
import { parseRoomShareUrl } from "../src/protocol.js";
import {
  createWorkspaceRoomCheckpoint,
  decryptWorkspaceRoomCheckpoint,
  encryptWorkspaceRoomCheckpoint,
  type RoomCheckpointStore,
} from "../src/room-checkpoints.js";
import { TabulaRoomClient } from "../src/room-client.js";
import { encodeRoomEvent, type RoomActor, type RoomEvent, type WorkspaceRoomState } from "../src/room-events.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const humanActor: RoomActor = {
  id: "human_1",
  kind: "human",
  name: "Taeha",
  client: "tabula-md",
  capabilities: ["presence", "read", "comment", "write", "create", "delete", "move"],
  color: "#111827",
  joinedAt: "2026-07-09T00:00:00.000Z",
};

const createClient = (writeAccess = true) =>
  new TabulaRoomClient({
    parsedRoom: parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}`),
    roomServerUrl: "https://rooms.tabula.md",
    writeAccess,
  });

const createWorkspacePublisherClient = () =>
  new TabulaRoomClient({
    parsedRoom: parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}`),
    roomServerUrl: "https://rooms.tabula.md",
    writeAccess: false,
    actorCapabilities: ["presence", "read", "comment", "write", "create", "delete", "move"],
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
        title: "Draft",
        sha256: await sha256Text(markdown),
        textLength: markdown.length,
        order: 0,
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
};

const encryptRoomEvent = async (key: CryptoKey, version: number, event: RoomEvent) =>
  encryptBytesForRoom(key, "room_123", "room-event", version, encodeRoomEvent(event));

const createMemoryCheckpointStore = ({
  loaded,
}: {
  loaded?: Uint8Array;
} = {}) => {
  let saved: Uint8Array | null = null;
  const store: RoomCheckpointStore & { saved(): Uint8Array | null } = {
    enabled: true,
    async loadEncryptedCheckpoint() {
      return loaded
        ? {
            encryptedCheckpoint: loaded,
            status: {
              enabled: true,
              store: "firebase-firestore",
              status: "loaded",
              checkpointVersion: 1,
              updatedAt: "2026-07-09T00:00:00.000Z",
            },
          }
        : null;
    },
    async saveEncryptedCheckpoint(_roomId, encryptedCheckpoint) {
      saved = encryptedCheckpoint;
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
    saved() {
      return saved;
    },
  };
  return store;
};

describe("TabulaRoomClient room state hydration", () => {
  it("reports waiting-for-peer-state before receiving live room state", async () => {
    const client = createClient();
    try {
      await expect(client.readMarkdown()).resolves.toMatchObject({
        hydrationStatus: "waiting-for-peer-state",
        stateReceived: false,
        markdown: "",
      });
    } finally {
      client.disconnect();
    }
  });

  it("reports an agent actor with direct collaboration capabilities", async () => {
    const client = createClient(false);
    try {
      await expect(client.getStatus()).resolves.toMatchObject({
        actor: {
          kind: "agent",
          client: "tabula-mcp",
          name: "Tabula Agent",
          capabilities: ["presence", "read", "comment", "write", "create", "delete", "move"],
        },
        capabilities: ["presence", "read", "comment", "write", "create", "delete", "move"],
      });
    } finally {
      client.disconnect();
    }
  });

  it("reads workspace metadata and cached active workspace document text", async () => {
    const client = createClient(false);
    const key = await importRoomKey(roomKey);
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("markdown").insert(0, "# Draft\n");
    const workspaceUpdated = await encryptRoomEvent(key, 1, {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      workspace: await createWorkspaceState("# Draft\n"),
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const textUpdated = await encryptRoomEvent(key, 2, {
      id: "event_text",
      type: "text.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      documentId: "doc_1",
      sha256: await sha256Text("# Draft\n"),
      update: Buffer.from(Y.encodeStateAsUpdate(sourceDoc)).toString("base64url"),
      createdAt: "2026-07-09T00:00:02.000Z",
    });

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(workspaceUpdated);
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(textUpdated);

      await expect(client.readWorkspace()).resolves.toMatchObject({
        workspace: {
          mode: "workspace",
          activeDocumentId: "doc_1",
        },
        documents: [
          expect.objectContaining({
            id: "doc_1",
            type: "document",
            cached: true,
          }),
        ],
        cachedDocumentCount: 1,
      });
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        documentId: "doc_1",
        title: "Draft",
        markdown: "# Draft\n",
        sha256: await sha256Text("# Draft\n"),
      });
    } finally {
      client.disconnect();
    }
  });

  it("ignores empty generated browser placeholder workspace updates without dropping cached room documents", async () => {
    const client = createClient(false);
    const key = await importRoomKey(roomKey);
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("markdown").insert(0, "# Draft\n");
    const workspaceUpdated = await encryptRoomEvent(key, 1, {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      workspace: await createWorkspaceState("# Draft\n"),
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const textUpdated = await encryptRoomEvent(key, 2, {
      id: "event_text",
      type: "text.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      documentId: "doc_1",
      sha256: await sha256Text("# Draft\n"),
      update: Buffer.from(Y.encodeStateAsUpdate(sourceDoc)).toString("base64url"),
      createdAt: "2026-07-09T00:00:02.000Z",
    });
    const placeholderWorkspaceUpdated = await encryptRoomEvent(key, 3, {
      id: "event_placeholder_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      workspace: {
        roomId: "room_123",
        mode: "workspace",
        version: 1,
        rootId: "workspace-root",
        activeDocumentId: "live-room_123",
        nodes: [
          {
            id: "workspace-root",
            type: "folder",
            parentId: null,
            title: "Workspace",
            order: 0,
            createdAt: "2026-07-09T00:00:03.000Z",
            updatedAt: "2026-07-09T00:00:03.000Z",
          },
          {
            id: "live-room_123",
            type: "document",
            parentId: "workspace-root",
            title: "Shared room_123.md",
            sha256: await sha256Text(""),
            textLength: 0,
            order: 0,
            createdAt: "2026-07-09T00:00:03.000Z",
            updatedAt: "2026-07-09T00:00:03.000Z",
          },
        ],
      },
      createdAt: "2026-07-09T00:00:03.000Z",
    });

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(workspaceUpdated);
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(textUpdated);
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(placeholderWorkspaceUpdated);

      await expect(client.readWorkspace()).resolves.toMatchObject({
        activeDocumentId: "doc_1",
        cachedDocumentCount: 1,
        documents: [
          expect.objectContaining({
            id: "doc_1",
            cached: true,
          }),
        ],
      });
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Draft\n",
      });
    } finally {
      client.disconnect();
    }
  });

  it("applies multi-document workspace changes as direct encrypted room events", async () => {
    const client = createClient(false);
    const key = await importRoomKey(roomKey);
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("markdown").insert(0, "# Draft\n");
    const workspaceUpdated = await encryptRoomEvent(key, 1, {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      workspace: await createWorkspaceState("# Draft\n"),
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const textUpdated = await encryptRoomEvent(key, 2, {
      id: "event_text",
      type: "text.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      documentId: "doc_1",
      sha256: await sha256Text("# Draft\n"),
      update: Buffer.from(Y.encodeStateAsUpdate(sourceDoc)).toString("base64url"),
      createdAt: "2026-07-09T00:00:02.000Z",
    });
    const emitted: unknown[] = [];
    const socket = {
      connected: true,
      disconnect: vi.fn(),
      emit: vi.fn((_eventName: string, envelope: unknown, acknowledge?: (ack: { ok?: boolean }) => void) => {
        emitted.push(envelope);
        acknowledge?.({ ok: true });
      }),
    };

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(workspaceUpdated);
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(textUpdated);
      (client as unknown as { socket: typeof socket }).socket = socket;

      const baseSha256 = await sha256Text("# Draft\n");
      const result = await client.applyWorkspaceChanges({
        changes: [
          {
            type: "document.patch",
            documentId: "doc_1",
            baseSha256,
            patches: [{ from: 8, to: 8, insert: "\nHello from an agent.\n" }],
          },
          {
            type: "document.create",
            parentId: "root",
            title: "Second draft",
            markdown: "# Second draft\n",
          },
        ],
      });

      expect(result).toMatchObject({
        applied: true,
        emittedTextUpdateCount: 2,
        emittedWorkspaceUpdateCount: 1,
        changes: [
          expect.objectContaining({
            type: "document.patch",
            documentId: "doc_1",
            baseSha256,
          }),
          expect.objectContaining({
            type: "document.create",
            parentId: "root",
            title: "Second draft",
          }),
        ],
      });

      expect(emitted).toHaveLength(3);
      expect(emitted.every((envelope) => (envelope as { kind?: string }).kind === "room-event")).toBe(true);
      expect(JSON.stringify(emitted)).not.toContain("Second draft");

      const decodedEvents = await Promise.all(
        emitted.map(async (envelope) =>
          JSON.parse(
            new TextDecoder().decode(await decryptEnvelopeForRoom(key, envelope as Parameters<typeof decryptEnvelopeForRoom>[1])),
          ) as { type: string; documentId?: string; workspace?: WorkspaceRoomState },
        ),
      );
      expect(decodedEvents.map((event) => event.type)).toEqual(["text.updated", "workspace.updated", "text.updated"]);
      expect(decodedEvents[0]).toMatchObject({ type: "text.updated", documentId: "doc_1" });
      expect(decodedEvents[1]?.workspace?.nodes.some((node) => node.type === "document" && node.title === "Second draft")).toBe(true);
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Draft\n\nHello from an agent.\n",
      });
    } finally {
      client.disconnect();
    }
  });

  it("fails direct workspace changes when the room relay does not acknowledge room-event envelopes", async () => {
    const client = createClient(false);
    const key = await importRoomKey(roomKey);
    const workspaceUpdated = await encryptRoomEvent(key, 1, {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: humanActor.id,
      actor: humanActor,
      workspace: await createWorkspaceState("# Draft\n"),
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const socket = {
      connected: true,
      disconnect: vi.fn(),
      emit: vi.fn((_eventName: string, _envelope: unknown, acknowledge?: (ack: { ok?: boolean; error?: string }) => void) => {
        acknowledge?.({ ok: false, error: "Invalid envelope kind" });
      }),
    };

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(workspaceUpdated);
      (client as unknown as { socket: typeof socket }).socket = socket;

      await expect(
        client.applyWorkspaceChanges({
          changes: [
            {
              type: "document.create",
              parentId: "root",
              title: "Second draft",
              markdown: "# Second draft\n",
            },
          ],
        }),
      ).rejects.toThrow(/workspace.updated room-event envelopes: Invalid envelope kind/);
    } finally {
      client.disconnect();
    }
  });

  it("publishes initial workspace rooms as encrypted workspace and document room events", async () => {
    const client = createWorkspacePublisherClient();
    const key = await importRoomKey(roomKey);
    const workspace = await createWorkspaceState("# Draft\n");
    const emitted: unknown[] = [];
    const socket = {
      connected: true,
      disconnect: vi.fn(),
      emit: vi.fn((_eventName: string, envelope: unknown, acknowledge?: (ack: { ok?: boolean }) => void) => {
        emitted.push(envelope);
        acknowledge?.({ ok: true });
      }),
    };

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      (client as unknown as { socket: typeof socket }).socket = socket;

      expect(client.actor.capabilities).toEqual(["presence", "read", "comment", "write", "create", "delete", "move"]);
      const result = await client.publishWorkspaceSnapshot({
        workspace,
        documents: [
          {
            documentId: "doc_1",
            title: "Draft",
            markdown: "# Draft\n",
            sha256: await sha256Text("# Draft\n"),
          },
        ],
      });

      expect(result).toEqual({
        emittedWorkspace: true,
        emittedDocumentCount: 1,
        checkpointStatus: {
          enabled: false,
          store: "none",
          status: "disabled",
        },
      });
      expect(emitted).toHaveLength(2);
      expect(emitted.every((envelope) => (envelope as { kind?: string }).kind === "room-event")).toBe(true);

      const decodedEvents = await Promise.all(
        emitted.map(async (envelope) =>
          JSON.parse(
            new TextDecoder().decode(await decryptEnvelopeForRoom(key, envelope as Parameters<typeof decryptEnvelopeForRoom>[1])),
          ) as { type: string; actor?: RoomActor; actorId?: string; documentId?: string; update?: string },
        ),
      );
      expect(decodedEvents[0]).toMatchObject({
        type: "workspace.updated",
        actorId: client.actor.id,
        actor: {
          id: client.actor.id,
          kind: "agent",
          client: "tabula-mcp",
        },
      });
      expect(decodedEvents[1]).toMatchObject({
        type: "text.updated",
        actorId: client.actor.id,
        actor: {
          id: client.actor.id,
          kind: "agent",
          client: "tabula-mcp",
        },
        documentId: "doc_1",
      });
      expect(JSON.stringify(emitted)).not.toContain("# Draft");

      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Draft\n",
        sha256: await sha256Text("# Draft\n"),
      });
    } finally {
      client.disconnect();
    }
  });

  it("fails initial workspace room publishing when the room relay rejects room-event envelopes", async () => {
    const client = createWorkspacePublisherClient();
    const key = await importRoomKey(roomKey);
    const workspace = await createWorkspaceState("# Draft\n");
    const socket = {
      connected: true,
      disconnect: vi.fn(),
      emit: vi.fn((_eventName: string, _envelope: unknown, acknowledge?: (ack: { ok?: boolean; error?: string }) => void) => {
        acknowledge?.({ ok: false, error: "Invalid envelope kind" });
      }),
    };

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      (client as unknown as { socket: typeof socket }).socket = socket;

      await expect(
        client.publishWorkspaceSnapshot({
          workspace,
          documents: [
            {
              documentId: "doc_1",
              title: "Draft",
              markdown: "# Draft\n",
              sha256: await sha256Text("# Draft\n"),
            },
          ],
        }),
      ).rejects.toThrow(/workspace.updated room-event envelopes: Invalid envelope kind/);
    } finally {
      client.disconnect();
    }
  });

  it("saves initial workspace rooms as encrypted live room checkpoints", async () => {
    const checkpointStore = createMemoryCheckpointStore();
    const client = new TabulaRoomClient({
      parsedRoom: parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}`),
      roomServerUrl: "https://rooms.tabula.md",
      writeAccess: false,
      actorCapabilities: ["presence", "read", "comment", "write", "create", "delete", "move"],
      roomCheckpointStore: checkpointStore,
    });
    const key = await importRoomKey(roomKey);
    const workspace = await createWorkspaceState("# Draft\n");
    const socket = {
      connected: true,
      disconnect: vi.fn(),
      emit: vi.fn((_eventName: string, _envelope: unknown, acknowledge?: (ack: { ok?: boolean }) => void) => {
        acknowledge?.({ ok: true });
      }),
    };

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      (client as unknown as { socket: typeof socket }).socket = socket;

      const result = await client.publishWorkspaceSnapshot({
        workspace,
        documents: [
          {
            documentId: "doc_1",
            title: "Draft",
            markdown: "# Draft\n",
            sha256: await sha256Text("# Draft\n"),
          },
        ],
      });

      expect(result.checkpointStatus).toMatchObject({
        enabled: true,
        store: "firebase-firestore",
        status: "saved",
      });
      const saved = checkpointStore.saved();
      expect(saved).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(saved ?? new Uint8Array()).toString("utf8")).not.toContain("# Draft");

      const checkpoint = await decryptWorkspaceRoomCheckpoint({
        encryptedCheckpoint: saved ?? new Uint8Array(),
        roomId: "room_123",
        roomKey,
      });
      expect(checkpoint).toMatchObject({
        schema: "tabula.workspace-room-checkpoint",
        version: 1,
        roomId: "room_123",
        workspace: {
          roomId: "room_123",
          mode: "workspace",
        },
        documents: [
          {
            id: "doc_1",
            title: "Draft",
            markdown: "# Draft\n",
            parentId: "root",
          },
        ],
      });
    } finally {
      client.disconnect();
    }
  });

  it("loads encrypted live room checkpoints before joining the relay", async () => {
    const workspace = await createWorkspaceState("# Restored\n");
    const checkpoint = await createWorkspaceRoomCheckpoint({
      roomId: "room_123",
      workspace,
      documents: [
        {
          id: "doc_1",
          title: "Draft",
          markdown: "# Restored\n",
          parentId: "root",
        },
      ],
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const encryptedCheckpoint = await encryptWorkspaceRoomCheckpoint({ checkpoint, roomKey });
    const client = new TabulaRoomClient({
      parsedRoom: parseRoomShareUrl(`https://tabula.md/#room=room_123,${roomKey}`),
      roomServerUrl: "https://rooms.tabula.md",
      writeAccess: false,
      roomCheckpointStore: createMemoryCheckpointStore({ loaded: encryptedCheckpoint }),
    });
    const socket = {
      connected: true,
      disconnect: vi.fn(),
      emit: vi.fn((_eventName: string, _envelope: unknown, acknowledge?: (ack: { ok?: boolean }) => void) => {
        acknowledge?.({ ok: true });
      }),
    };

    try {
      (client as unknown as { connectSocket(): Promise<void>; socket: typeof socket }).connectSocket = async () => {
        (client as unknown as { socket: typeof socket; peerCount: number }).socket = socket;
        (client as unknown as { socket: typeof socket; peerCount: number }).peerCount = 1;
      };

      await expect(client.connect()).resolves.toBe("checkpoint-loaded");
      await expect(client.getStatus()).resolves.toMatchObject({
        hydrationStatus: "ready",
        stateReceived: true,
        checkpointStatus: {
          enabled: true,
          store: "firebase-firestore",
          status: "loaded",
          checkpointVersion: 1,
        },
      });
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Restored\n",
        sha256: await sha256Text("# Restored\n"),
      });
      await expect(client.readMarkdown()).resolves.toMatchObject({
        markdown: "# Restored\n",
      });
    } finally {
      client.disconnect();
    }
  });

});
