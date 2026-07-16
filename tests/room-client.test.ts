import { Buffer } from "node:buffer";
import {
  ROOM_WIRE_PROTOCOL_VERSION,
  decodeRoomWirePacket,
  decryptRoomEnvelope,
  type EncryptedEnvelope,
  type WorkspaceRoomSyncAdapters,
  type WorkspaceRoomCheckpointStore,
} from "@tabula-md/tabula/collaboration";
import { describe, expect, it } from "vitest";
import { importRoomKey, sha256Text } from "../src/crypto.js";
import { parseRoomShareUrl } from "../src/protocol.js";
import { TabulaRoomClient } from "../src/room-client.js";
import { createMemoryWorkspaceRoomCheckpointStore } from "../src/room-checkpoints.js";
import type { WorkspaceRoomState } from "../src/workspace-contract.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const roomUrl = `https://tabula.md/#room=room_123,${roomKey}`;

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 2_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await condition()) return;
    } catch {
      // The remote projection may not exist until the sync packet arrives.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for room convergence.");
};

const createMemoryRelay = () => {
  const peers = new Map<string, {
    handlers: Parameters<WorkspaceRoomSyncAdapters["createRoomTransport"]>[0]["handlers"];
    connected: boolean;
  }>();
  const envelopes: EncryptedEnvelope[] = [];

  const createRoomTransport: WorkspaceRoomSyncAdapters["createRoomTransport"] = ({
    roomId,
    clientId,
    handlers,
  }) => {
    const peer = { handlers, connected: false };
    return {
      get connected() {
        return peer.connected;
      },
      connect() {
        peer.connected = true;
        peers.set(clientId, peer);
        handlers.onConnect();
        handlers.onJoined({ roomId, clientId, peerCount: peers.size });
        for (const [otherId, other] of peers) {
          if (otherId !== clientId) other.handlers.onPeerJoined({ roomId, clientId });
        }
        const peerIds = [...peers.keys()];
        for (const current of peers.values()) current.handlers.onPeers({ roomId, peers: peerIds });
      },
      sendEnvelope(envelope) {
        envelopes.push(envelope);
        for (const [otherId, other] of peers) {
          if (otherId !== clientId) queueMicrotask(() => other.handlers.onMessage(envelope));
        }
      },
      sendVolatileEnvelope(envelope) {
        this.sendEnvelope(envelope);
      },
      disconnect() {
        peer.connected = false;
        peers.delete(clientId);
        const peerIds = [...peers.keys()];
        for (const current of peers.values()) current.handlers.onPeers({ roomId, peers: peerIds });
        handlers.onDisconnect();
      },
    };
  };

  return { createRoomTransport, envelopes };
};

const createWorkspaceState = async (markdown = "# Draft\n"): Promise<WorkspaceRoomState> => {
  const createdAt = "2026-07-13T00:00:00.000Z";
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
        order: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
};

const createDisabledCheckpointStore = (): WorkspaceRoomCheckpointStore => ({
  enabled: false,
  async loadEncryptedCheckpoint() {
    return null;
  },
  async saveEncryptedCheckpoint() {
    throw new Error("Live room persistence is unavailable.");
  },
});

const createClient = ({
  relay,
  writeAccess = true,
  checkpointStore = createMemoryWorkspaceRoomCheckpointStore(),
  identityName,
}: {
  relay: ReturnType<typeof createMemoryRelay>;
  writeAccess?: boolean;
  checkpointStore?: WorkspaceRoomCheckpointStore;
  identityName?: string;
}) => new TabulaRoomClient({
  parsedRoom: parseRoomShareUrl(roomUrl),
  roomServerUrl: "https://rooms.tabula.md",
  writeAccess,
  identityName,
  roomCheckpointStore: checkpointStore,
  createRoomTransport: relay.createRoomTransport,
});

describe("TabulaRoomClient protocol v2", () => {
  it("uses the shared agent actor and stable capability contract", async () => {
    const relay = createMemoryRelay();
    const client = createClient({ relay, writeAccess: false });
    try {
      await expect(client.getStatus()).resolves.toMatchObject({
        actor: {
          kind: "agent",
          client: "tabula-mcp",
          capabilities: ["presence", "read"],
        },
        capabilities: ["presence", "read"],
      });
      expect(client.actor.name).toMatch(/ Agent$/);
    } finally {
      client.disconnect();
    }
  });

  it("synchronizes one workspace Y.Doc, awareness, and direct multi-document edits", async () => {
    const relay = createMemoryRelay();
    const checkpointStore = createMemoryWorkspaceRoomCheckpointStore();
    const first = createClient({ relay, checkpointStore, identityName: "First Agent" });
    const second = createClient({ relay, checkpointStore, identityName: "Second Agent" });
    try {
      await first.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState(),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Draft\n" }],
      });
      await first.connect();
      await second.connect();

      await waitFor(async () => (await second.readWorkspaceDocument({ documentId: "doc_1" })).markdown === "# Draft\n");
      await waitFor(() => first.collaboratorList.some((peer) => peer.actor?.name === "Second Agent"));

      const before = await second.readWorkspaceDocument({ documentId: "doc_1" });
      await second.applyWorkspaceChanges({
        changes: [
          {
            type: "document.patch",
            documentId: "doc_1",
            baseSha256: before.sha256,
            patches: [{ from: before.markdown.length, to: before.markdown.length, insert: "\nEdited by agent.\n" }],
          },
          {
            type: "document.create",
            parentId: null,
            title: "Notes.md",
            markdown: "# Notes\n",
          },
        ],
      });

      await waitFor(async () => (await first.readWorkspaceDocument({ documentId: "doc_1" })).markdown.includes("Edited by agent."));
      await waitFor(async () => (await first.readWorkspace()).documents.some((document) => document.title === "Notes.md"));

      const key = await importRoomKey(roomKey);
      const decryptedPackets = await Promise.all(relay.envelopes.map((envelope) =>
        decryptRoomEnvelope({ roomKey: key, envelope }).then(decodeRoomWirePacket)
      ));
      expect(relay.envelopes.every((envelope) => envelope.kind === "room-event")).toBe(true);
      expect(decryptedPackets.some((packet) => packet.ok && packet.packet.type === "sync.message")).toBe(true);
      expect(decryptedPackets.some((packet) => packet.ok && packet.packet.type === "awareness.updated")).toBe(true);
      expect(ROOM_WIRE_PROTOCOL_VERSION).toBe(2);
    } finally {
      first.disconnect();
      second.disconnect();
    }
  });

  it("restores an app-compatible encrypted Y.Doc checkpoint", async () => {
    const relay = createMemoryRelay();
    const checkpointStore = createMemoryWorkspaceRoomCheckpointStore();
    const writer = createClient({ relay, checkpointStore });
    await writer.publishWorkspaceSnapshot({
      workspace: await createWorkspaceState("# Durable\n"),
      documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Durable\n" }],
    });
    await writer.connect();
    writer.disconnect();

    const reader = createClient({ relay, checkpointStore, writeAccess: false });
    try {
      await expect(reader.connect()).resolves.toBe("checkpoint-loaded");
      await expect(reader.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Durable\n",
      });
    } finally {
      reader.disconnect();
    }
  });

  it("joins a live peer without checkpoint persistence and waits for its workspace state", async () => {
    const relay = createMemoryRelay();
    const checkpointStore = createMemoryWorkspaceRoomCheckpointStore();
    const browserPeer = createClient({ relay, checkpointStore, identityName: "Browser Peer" });
    const mcpClient = createClient({
      relay,
      checkpointStore: createDisabledCheckpointStore(),
      identityName: "Claude",
    });
    try {
      await browserPeer.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState("# Shared from browser\n"),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Shared from browser\n" }],
      });
      await browserPeer.connect();

      await expect(mcpClient.connect({ waitForStateMs: 500 })).resolves.toBe("checkpoint-disabled");
      await expect(mcpClient.getStatus()).resolves.toMatchObject({
        status: "connected",
        hydrationStatus: "ready",
        checkpointStatus: { enabled: false, status: "disabled" },
      });
      await expect(mcpClient.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Shared from browser\n",
      });
    } finally {
      browserPeer.disconnect();
      mcpClient.disconnect();
    }
  });

  it("keeps an unhydrated room connected but blocks reads and writes", async () => {
    const relay = createMemoryRelay();
    const client = createClient({
      relay,
      writeAccess: true,
      checkpointStore: createDisabledCheckpointStore(),
    });
    try {
      await expect(client.connect({ waitForStateMs: 10 })).resolves.toBe("checkpoint-disabled");
      await expect(client.getStatus()).resolves.toMatchObject({
        status: "connected",
        hydrationStatus: "waiting-for-peer-state",
        stateReceived: false,
      });
      await expect(client.readWorkspace()).rejects.toThrow("waiting for workspace state");
      await expect(client.applyWorkspaceChanges({
        changes: [{ type: "document.create", parentId: null, title: "Unsafe.md", markdown: "# Unsafe\n" }],
      })).rejects.toThrow("waiting for workspace state");
    } finally {
      client.disconnect();
    }
  });

  it("starts a temporary room without checkpoint persistence", async () => {
    const relay = createMemoryRelay();
    const client = createClient({
      relay,
      writeAccess: true,
      checkpointStore: createDisabledCheckpointStore(),
      identityName: "Claude",
    });
    try {
      await expect(client.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState("# Temporary room\n"),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Temporary room\n" }],
      })).resolves.toMatchObject({
        emittedWorkspace: true,
        checkpointStatus: { enabled: false, status: "disabled" },
      });

      await expect(client.connect()).resolves.toBe("local-bootstrap");
      await expect(client.getStatus()).resolves.toMatchObject({
        status: "connected",
        recoveryMode: "temporary",
        hydrationStatus: "ready",
        checkpointStatus: { enabled: false, status: "disabled" },
      });
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Temporary room\n",
      });
    } finally {
      client.disconnect();
    }
  });
});
