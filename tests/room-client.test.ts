import { Buffer } from "node:buffer";
import {
  ROOM_WIRE_PROTOCOL_VERSION,
  decodeRoomWirePacket,
  decryptRoomEnvelope,
  type EncryptedEnvelope,
  type WorkspaceRoomSyncAdapters,
  type WorkspaceRoomCheckpointStore,
  type WorkspaceRoomComment,
} from "@tabula-md/tabula/collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importRoomKey, sha256Text } from "../src/crypto.js";
import { parseRoomShareUrl, WorkspaceConflictError } from "../src/protocol.js";
import { TabulaRoomClient } from "../src/room-client.js";
import { createMemoryWorkspaceRoomCheckpointStore } from "../src/room-checkpoints.js";
import { abortableOperation, runWithOperationSignal } from "../src/server/operation-context.js";
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

  return { createRoomTransport, envelopes, peerCount: () => peers.size };
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
  identityId,
  identityName,
}: {
  relay: ReturnType<typeof createMemoryRelay>;
  writeAccess?: boolean;
  checkpointStore?: WorkspaceRoomCheckpointStore;
  identityId?: string;
  identityName?: string;
}) => new TabulaRoomClient({
  parsedRoom: parseRoomShareUrl(roomUrl),
  roomServerUrl: "https://rooms.tabula.md",
  writeAccess,
  identityId,
  identityName,
  roomCheckpointStore: checkpointStore,
  createRoomTransport: relay.createRoomTransport,
});

afterEach(() => vi.useRealTimers());

describe("TabulaRoomClient protocol v2", () => {
  it("waits for the final encrypted checkpoint before closing an idle Room", async () => {
    const relay = createMemoryRelay();
    let finishSave: ((value: { ok: true; generation: number }) => void) | undefined;
    const saved = new Promise<{ ok: true; generation: number }>((resolve) => { finishSave = resolve; });
    const checkpointStore: WorkspaceRoomCheckpointStore = {
      enabled: true,
      async loadEncryptedCheckpoint() { return null; },
      async saveEncryptedCheckpoint() { return saved; },
    };
    const client = createClient({ relay, checkpointStore });
    await client.publishWorkspaceSnapshot({
      workspace: await createWorkspaceState(),
      documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Draft\n" }],
      persistCheckpoint: false,
    });
    await client.connect();

    const closing = client.close();
    expect(relay.peerCount()).toBe(1);
    finishSave?.({ ok: true, generation: 1 });
    await closing;

    expect(relay.peerCount()).toBe(0);
    await expect(client.getStatus()).resolves.toMatchObject({ status: "closed", socketConnected: false });
  });

  it("disconnects a Room transport when readiness is aborted before commit", async () => {
    const relay = createMemoryRelay();
    const client = createClient({ relay, checkpointStore: createDisabledCheckpointStore() });
    const controller = new AbortController();
    const connected = runWithOperationSignal(controller.signal, () =>
      abortableOperation(client.connect({ waitForStateMs: 30_000 }), () => client.disconnect())
    );
    await waitFor(() => relay.peerCount() === 1);
    controller.abort();
    await expect(connected).rejects.toThrow("cancelled before it committed");
    expect(relay.peerCount()).toBe(0);
    await expect(client.getStatus()).resolves.toMatchObject({ status: "closed", socketConnected: false });
  });

  it("retries a failed recovery checkpoint and exposes the durable state transition", async () => {
    const relay = createMemoryRelay();
    let saves = 0;
    const checkpointStore: WorkspaceRoomCheckpointStore = {
      enabled: true,
      async loadEncryptedCheckpoint() { return null; },
      async saveEncryptedCheckpoint() {
        saves += 1;
        if (saves === 1) throw new Error("checkpoint unavailable");
        return { ok: true, generation: 1 };
      },
    };
    const client = createClient({ relay, checkpointStore });
    try {
      await client.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState(),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Draft\n" }],
        persistCheckpoint: false,
      });
      await client.connect();
      vi.useFakeTimers();
      await expect(client.persistCheckpointAfterMutation()).resolves.toBe("pending");
      expect(client.checkpointPersistenceStatus()).toBe("pending");

      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await waitFor(() => client.checkpointPersistenceStatus() === "saved");
      expect(saves).toBe(2);
      expect(client.checkpointPersistenceStatus()).toBe("saved");
    } finally {
      client.disconnect();
    }
  });

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

  it("uses an injected session-stable actor id across Room clients", () => {
    const first = createClient({ relay: createMemoryRelay(), identityId: "stable-agent", identityName: "Claude" });
    const second = createClient({ relay: createMemoryRelay(), identityId: "stable-agent", identityName: "Claude" });
    expect(first.actor).toMatchObject({ id: "stable-agent", name: "Claude", kind: "agent" });
    expect(second.actor.id).toBe(first.actor.id);
    first.disconnect();
    second.disconnect();
  });

  it("synchronizes agent-authored comment threads through the shared Room CRDT", async () => {
    const relay = createMemoryRelay();
    const first = createClient({ relay, identityId: "agent-1", identityName: "Claude" });
    const second = createClient({ relay, identityId: "agent-2", identityName: "Codex" });
    const comment: WorkspaceRoomComment = {
      id: "00000000-0000-4000-8000-000000000001",
      fileId: "doc_1",
      body: "Please verify this line.",
      authorId: first.actor.id,
      authorName: first.actor.name,
      resolved: false,
      createdAt: "2026-07-17T01:00:00.000Z",
      replies: [],
    };
    try {
      await first.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState(),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Draft\n" }],
        persistCheckpoint: false,
      });
      await first.connect();
      await second.connect({ waitForStateMs: 2_000 });
      await first.upsertComment(comment);
      await waitFor(async () => (await second.readWorkspaceSnapshot()).commentsByFileId.doc_1?.length === 1);
      await second.addCommentReply(comment.id, {
        id: "00000000-0000-4000-8000-000000000002",
        body: "Verified.",
        authorId: second.actor.id,
        authorName: second.actor.name,
        createdAt: "2026-07-17T01:01:00.000Z",
      });
      await second.setCommentResolved(comment.id, true);
      await waitFor(async () => {
        const synced = (await first.readWorkspaceSnapshot()).commentsByFileId.doc_1?.[0];
        return synced?.resolved === true && synced.replies[0]?.body === "Verified.";
      });
      await first.deleteComment(comment.id);
      await waitFor(async () => ((await second.readWorkspaceSnapshot()).commentsByFileId.doc_1?.length ?? 0) === 0);
    } finally {
      first.disconnect();
      second.disconnect();
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

  it("applies text patches incrementally so unaffected collaborative positions survive", async () => {
    const relay = createMemoryRelay();
    const client = createClient({ relay });
    const observer = createClient({ relay, identityName: "Observer" });
    const markdown = "prefix TARGET suffix";
    try {
      await client.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState(markdown),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown }],
      });
      await client.connect();
      await observer.connect({ waitForStateMs: 500 });
      const suffixOffset = markdown.indexOf("suffix");
      await observer.setPresence({ documentId: "doc_1", from: suffixOffset, to: suffixOffset });
      await waitFor(() => client.collaboratorList[0]?.selection?.from === suffixOffset);
      const before = await client.readWorkspaceDocument({ documentId: "doc_1" });

      await client.applyWorkspaceChanges({
        changes: [{
          type: "document.patch",
          documentId: "doc_1",
          baseSha256: before.sha256,
          patches: [{
            from: markdown.indexOf("TARGET"),
            to: markdown.indexOf("TARGET") + "TARGET".length,
            insert: "UPDATED CONTENT",
          }],
        }],
      });

      await waitFor(() =>
        client.collaboratorList[0]?.selection?.from === "prefix UPDATED CONTENT ".length
      );
      expect(client.collaboratorList[0]?.selection?.from).toBe("prefix UPDATED CONTENT ".length);
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" }))
        .resolves.toMatchObject({ markdown: "prefix UPDATED CONTENT suffix" });
    } finally {
      client.disconnect();
      observer.disconnect();
    }
  });

  it("reports revision races with a typed workspace conflict", async () => {
    const relay = createMemoryRelay();
    const client = createClient({ relay });
    try {
      await client.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState(),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Draft\n" }],
      });
      await client.connect();
      const stale = await client.readWorkspaceDocument({ documentId: "doc_1" });
      await client.applyWorkspaceChanges({
        changes: [{
          type: "document.patch",
          documentId: "doc_1",
          baseSha256: stale.sha256,
          patches: [{ from: stale.markdown.length, to: stale.markdown.length, insert: "updated\n" }],
        }],
      });

      await expect(client.applyWorkspaceChanges({
        changes: [{
          type: "document.patch",
          documentId: "doc_1",
          baseSha256: stale.sha256,
          patches: [{ from: 0, to: 0, insert: "stale\n" }],
        }],
      })).rejects.toBeInstanceOf(WorkspaceConflictError);
    } finally {
      client.disconnect();
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

      await expect(mcpClient.connect({ waitForStateMs: 500, waitForPresenceMs: 500 }))
        .resolves.toBe("checkpoint-disabled");
      await expect(mcpClient.getStatus()).resolves.toMatchObject({
        status: "connected",
        hydrationStatus: "ready",
        presenceStatus: "ready",
        connectedPeerCount: 1,
        collaborators: [expect.objectContaining({ name: "Browser Peer" })],
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
        activeDocumentTitle: "Draft.md",
        checkpointStatus: { enabled: false, status: "disabled" },
      });
      await expect(client.readWorkspaceDocument({ documentId: "doc_1" })).resolves.toMatchObject({
        markdown: "# Temporary room\n",
      });
    } finally {
      client.disconnect();
    }
  });

  it("moves, renames, and recursively deletes workspace nodes", async () => {
    const relay = createMemoryRelay();
    const client = createClient({ relay });
    try {
      await client.publishWorkspaceSnapshot({
        workspace: await createWorkspaceState(),
        documents: [{ documentId: "doc_1", title: "Draft.md", markdown: "# Draft\n" }],
      });
      await client.applyWorkspaceChanges({
        changes: [{ type: "folder.create", folderId: "archive", parentId: null, title: "archive" }],
      });
      const before = await client.readWorkspaceSnapshot();
      const document = before.workspace.nodes.find((node) => node.id === "doc_1")!;
      await client.applyWorkspaceChanges({
        changes: [{
          type: "node.move",
          nodeId: document.id,
          baseParentId: document.parentId,
          baseTitle: document.title,
          baseSha256: document.type === "document" ? document.sha256 : undefined,
          parentId: "archive",
          title: "Final.md",
        }],
      });
      await expect(client.readWorkspace()).resolves.toMatchObject({
        documents: [expect.objectContaining({ parentId: "archive", title: "Final.md" })],
      });

      const moved = await client.readWorkspaceSnapshot();
      const archive = moved.workspace.nodes.find((node) => node.id === "archive")!;
      await client.applyWorkspaceChanges({
        changes: [{
          type: "node.delete",
          nodeId: archive.id,
          baseParentId: archive.parentId,
          baseTitle: archive.title,
        }],
      });
      await expect(client.readWorkspace()).resolves.toMatchObject({ documents: [] });
    } finally {
      client.disconnect();
    }
  });
});
