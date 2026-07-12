import { describe, expect, it } from "vitest";
import {
  decodeRoomEvent,
  encodeRoomEvent,
  type RoomActor,
  type RoomEvent,
  type WorkspaceRoomState,
} from "../src/room-events.js";

const actor: RoomActor = {
  id: "agent_1",
  kind: "agent",
  name: "Tabula Agent",
  client: "tabula-mcp",
  capabilities: ["presence", "read", "comment", "write", "create", "delete", "move"],
  color: "#2563eb",
  joinedAt: "2026-07-09T00:00:00.000Z",
};

const workspace: WorkspaceRoomState = {
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
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    },
    {
      id: "doc_1",
      type: "document",
      parentId: "root",
      title: "Draft",
      sha256: "0".repeat(64),
      textLength: 0,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    },
  ],
};

describe("Tabula room event contract", () => {
  it("decodes canonical workspace.updated events with actor metadata", () => {
    const event: RoomEvent = {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: actor.id,
      actor,
      workspace,
      createdAt: "2026-07-09T00:00:01.000Z",
    };

    expect(decodeRoomEvent(encodeRoomEvent(event))).toEqual(event);
  });

  it("rejects workspace.updated and text.updated events without canonical actor metadata", () => {
    const workspaceEventWithoutActor = {
      id: "event_workspace",
      type: "workspace.updated",
      roomId: "room_123",
      actorId: actor.id,
      workspace,
      createdAt: "2026-07-09T00:00:01.000Z",
    };
    const textEventWithoutActor = {
      id: "event_text",
      type: "text.updated",
      roomId: "room_123",
      actorId: actor.id,
      documentId: "doc_1",
      update: "AAAA",
      createdAt: "2026-07-09T00:00:02.000Z",
    };

    expect(decodeRoomEvent(new TextEncoder().encode(JSON.stringify(workspaceEventWithoutActor)))).toBeNull();
    expect(decodeRoomEvent(new TextEncoder().encode(JSON.stringify(textEventWithoutActor)))).toBeNull();
  });
});
