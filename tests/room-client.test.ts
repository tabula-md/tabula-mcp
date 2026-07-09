import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  decryptEnvelopeForRoom,
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "../src/crypto.js";
import { parseRoomShareUrl } from "../src/protocol.js";
import { TabulaRoomClient } from "../src/room-client.js";
import { encodeRoomEvent, type RoomEvent, type WorkspaceRoomState } from "../src/room-events.js";

const roomKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

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
    actorCapabilities: ["presence", "read", "propose", "comment", "write", "create", "delete", "move"],
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

  it("reports an agent actor with proposal capability", async () => {
    const client = createClient(false);
    try {
      await expect(client.getStatus()).resolves.toMatchObject({
        actor: {
          kind: "agent",
          client: "tabula-mcp",
          name: "Tabula Agent",
          capabilities: ["presence", "read", "propose"],
        },
        capabilities: ["presence", "read", "propose"],
        pendingProposalCount: 0,
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
      actorId: "human_1",
      workspace: await createWorkspaceState("# Draft\n"),
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const stateInit = await encryptBytesForRoom(key, "room_123", "state-init", 2, Y.encodeStateAsUpdate(sourceDoc));

    try {
      (client as unknown as { roomKey: CryptoKey }).roomKey = key;
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(workspaceUpdated);
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(stateInit);

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

  it("emits multi-document workspace proposals as encrypted room-event envelopes", async () => {
    const client = createClient(false);
    const key = await importRoomKey(roomKey);
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("markdown").insert(0, "# Draft\n");
    const workspaceUpdated = await encryptRoomEvent(key, 1, {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: "human_1",
      workspace: await createWorkspaceState("# Draft\n"),
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const stateInit = await encryptBytesForRoom(key, "room_123", "state-init", 2, Y.encodeStateAsUpdate(sourceDoc));
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
      await (client as unknown as { applyIncomingEnvelope(value: unknown): Promise<void> }).applyIncomingEnvelope(stateInit);
      (client as unknown as { socket: typeof socket }).socket = socket;

      const baseSha256 = await sha256Text("# Draft\n");
      const result = await client.proposeWorkspaceChanges({
        title: "Revise workspace",
        description: "Patch the draft and add a second document.",
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
        emitted: true,
        proposal: {
          roomId: "room_123",
          actorId: client.actor.id,
          title: "Revise workspace",
          description: "Patch the draft and add a second document.",
          status: "pending",
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
        },
      });

      const envelope = emitted.at(-1);
      expect(envelope).toMatchObject({
        kind: "room-event",
        roomId: "room_123",
      });
      expect(JSON.stringify(envelope)).not.toContain("Second draft");

      const decoded = JSON.parse(
        new TextDecoder().decode(await decryptEnvelopeForRoom(key, envelope as Parameters<typeof decryptEnvelopeForRoom>[1])),
      ) as { type: string; proposal: { changes: Array<{ type: string }> } };
      expect(decoded.type).toBe("workspace.proposal.created");
      expect(decoded.proposal.changes.map((change) => change.type)).toEqual(["document.patch", "document.create"]);
      await expect(client.getStatus()).resolves.toMatchObject({
        pendingProposalCount: 1,
        pendingWorkspaceProposalCount: 1,
      });
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

      expect(client.actor.capabilities).toEqual(["presence", "read", "propose", "comment", "write", "create", "delete", "move"]);
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
      });
      expect(emitted).toHaveLength(2);
      expect(emitted.every((envelope) => (envelope as { kind?: string }).kind === "room-event")).toBe(true);

      const decodedEvents = await Promise.all(
        emitted.map(async (envelope) =>
          JSON.parse(
            new TextDecoder().decode(await decryptEnvelopeForRoom(key, envelope as Parameters<typeof decryptEnvelopeForRoom>[1])),
          ) as { type: string; documentId?: string; update?: string },
        ),
      );
      expect(decodedEvents[0]).toMatchObject({
        type: "workspace.updated",
      });
      expect(decodedEvents[1]).toMatchObject({
        type: "text.updated",
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

});
