import { randomUUID } from "node:crypto";
import type { TextPatch } from "./text.js";

export const roomCapabilities = [
  "presence",
  "read",
  "comment",
  "write",
  "create",
  "delete",
  "move",
] as const;
export type RoomCapability = (typeof roomCapabilities)[number];

export type RoomActorKind = "human" | "agent";
export type RoomActorClient = "tabula-md" | "tabula-mcp" | "custom";

export type RoomActor = {
  id: string;
  kind: RoomActorKind;
  name: string;
  client: RoomActorClient;
  capabilities: RoomCapability[];
  color?: string;
  joinedAt: string;
};

export type RoomPresenceSelection = {
  documentId?: string;
  from: number;
  to: number;
};

export type RoomPresenceCursor = {
  documentId?: string;
  offset: number;
};

export type RoomPresence = {
  actorId: string;
  activeDocumentId?: string;
  selection?: RoomPresenceSelection;
  cursor?: RoomPresenceCursor;
  lastSeen: number;
};

export type WorkspaceFolderNode = {
  id: string;
  type: "folder";
  parentId: string | null;
  title: string;
  order?: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDocumentNode = {
  id: string;
  type: "document";
  parentId: string | null;
  title: string;
  sha256: string;
  textLength: number;
  order?: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceNode = WorkspaceFolderNode | WorkspaceDocumentNode;

export type WorkspaceRoomState = {
  roomId: string;
  mode: "workspace";
  version: number;
  rootId: string;
  nodes: WorkspaceNode[];
  activeDocumentId?: string;
};

export type WorkspaceChange =
  | {
      type: "document.patch";
      documentId: string;
      baseSha256: string;
      patches: TextPatch[];
    }
  | {
      type: "document.create";
      parentId: string | null;
      title: string;
      markdown: string;
    }
  | {
      type: "document.rename";
      documentId: string;
      title: string;
    }
  | {
      type: "document.move";
      documentId: string;
      parentId: string | null;
    }
  | {
      type: "document.delete";
      documentId: string;
      baseSha256?: string;
    };

export type RoomEventBase = {
  id: string;
  type: string;
  roomId: string;
  actorId: string;
  createdAt: string;
};

export type RoomEvent =
  | {
      id: string;
      type: "actor.joined";
      roomId: string;
      actorId: string;
      actor: RoomActor;
      createdAt: string;
    }
  | {
      id: string;
      type: "actor.left";
      roomId: string;
      actorId: string;
      createdAt: string;
    }
  | {
      id: string;
      type: "presence.updated";
      roomId: string;
      actorId: string;
      actor: RoomActor;
      presence: RoomPresence;
      fileTitle?: string;
      selection?: RoomPresenceSelection;
      createdAt: string;
    }
  | {
      id: string;
      type: "text.updated";
      roomId: string;
      actorId: string;
      actor: RoomActor;
      documentId: string;
      baseHash?: string;
      baseSha256?: string;
      sha256?: string;
      update: string;
      createdAt: string;
    }
  | {
      id: string;
      type: "workspace.updated";
      roomId: string;
      actorId: string;
      actor: RoomActor;
      workspace: WorkspaceRoomState;
      createdAt: string;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isRoomCapability = (value: unknown): value is RoomCapability =>
  typeof value === "string" && roomCapabilities.includes(value as RoomCapability);

export const createAgentActor = ({
  id,
  name,
  color,
  capabilities,
}: {
  id: string;
  name: string;
  color?: string;
  capabilities?: readonly RoomCapability[];
}): RoomActor => ({
  id,
  kind: "agent",
  name,
  client: "tabula-mcp",
  color,
  capabilities: capabilities
    ? [...capabilities]
    : ["presence", "read", "comment", "write", "create", "delete", "move"],
  joinedAt: new Date().toISOString(),
});

export const createRoomEventId = () => `event_${randomUUID()}`;

export const encodeRoomEvent = (event: RoomEvent) => textEncoder.encode(JSON.stringify(event));

export const decodeRoomEvent = (bytes: Uint8Array): RoomEvent | null => {
  try {
    const decoded = JSON.parse(textDecoder.decode(bytes)) as unknown;
    return isRoomEvent(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

export const isRoomActor = (value: unknown): value is RoomActor => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    (value.kind === "human" || value.kind === "agent") &&
    typeof value.name === "string" &&
    (value.client === "tabula-md" || value.client === "tabula-mcp" || value.client === "custom") &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isRoomCapability) &&
    (value.color === undefined || typeof value.color === "string") &&
    typeof value.joinedAt === "string"
  );
};

const isTextPatch = (value: unknown): value is TextPatch =>
  isRecord(value) &&
  typeof value.from === "number" &&
  typeof value.to === "number" &&
  Number.isInteger(value.from) &&
  Number.isInteger(value.to) &&
  value.from >= 0 &&
  value.to >= value.from &&
    typeof value.insert === "string";

const isWorkspaceNode = (value: unknown): value is WorkspaceNode => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !(value.parentId === null || typeof value.parentId === "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.order === undefined || typeof value.order === "number")
  ) {
    return false;
  }

  if (value.type === "folder") {
    return true;
  }

  return (
    value.type === "document" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.textLength === "number"
  );
};

export const isWorkspaceRoomState = (value: unknown): value is WorkspaceRoomState =>
  isRecord(value) &&
  typeof value.roomId === "string" &&
  value.mode === "workspace" &&
  typeof value.version === "number" &&
  typeof value.rootId === "string" &&
  Array.isArray(value.nodes) &&
  value.nodes.every(isWorkspaceNode) &&
  (value.activeDocumentId === undefined || typeof value.activeDocumentId === "string");

export const isWorkspaceChange = (value: unknown): value is WorkspaceChange => {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === "document.patch") {
    return (
      typeof value.documentId === "string" &&
      typeof value.baseSha256 === "string" &&
      Array.isArray(value.patches) &&
      value.patches.every(isTextPatch)
    );
  }
  if (value.type === "document.create") {
    return (
      (value.parentId === null || typeof value.parentId === "string") &&
      typeof value.title === "string" &&
      typeof value.markdown === "string"
    );
  }
  if (value.type === "document.rename") {
    return typeof value.documentId === "string" && typeof value.title === "string";
  }
  if (value.type === "document.move") {
    return typeof value.documentId === "string" && (value.parentId === null || typeof value.parentId === "string");
  }
  if (value.type === "document.delete") {
    return typeof value.documentId === "string" && (value.baseSha256 === undefined || typeof value.baseSha256 === "string");
  }

  return false;
};

export const isRoomEvent = (value: unknown): value is RoomEvent => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.roomId !== "string") {
    return false;
  }

  if (typeof value.actorId !== "string" || typeof value.createdAt !== "string") {
    return false;
  }

  switch (value.type) {
    case "actor.joined":
      return isRoomActor(value.actor) && value.actor.id === value.actorId;
    case "actor.left":
      return true;
    case "presence.updated":
      return (
        isRoomActor(value.actor) &&
        value.actor.id === value.actorId &&
        isRoomPresence(value.presence) &&
        value.presence.actorId === value.actorId &&
        (value.fileTitle === undefined || typeof value.fileTitle === "string") &&
        (value.selection === undefined || isTextSelection(value.selection))
      );
    case "text.updated":
      return (
        isRoomActor(value.actor) &&
        value.actor.id === value.actorId &&
        typeof value.update === "string" &&
        typeof value.documentId === "string" &&
        (value.baseHash === undefined || typeof value.baseHash === "string") &&
        (value.baseSha256 === undefined || typeof value.baseSha256 === "string") &&
        (value.sha256 === undefined || typeof value.sha256 === "string")
      );
    case "workspace.updated":
      return (
        isRoomActor(value.actor) &&
        value.actor.id === value.actorId &&
        isWorkspaceRoomState(value.workspace) &&
        value.workspace.roomId === value.roomId
      );
    default:
      return false;
  }
};

const isRoomPresence = (value: unknown): value is RoomPresence =>
  isRecord(value) &&
  typeof value.actorId === "string" &&
  (value.activeDocumentId === undefined || typeof value.activeDocumentId === "string") &&
  (value.selection === undefined || isTextSelection(value.selection)) &&
  (value.cursor === undefined || isRoomPresenceCursor(value.cursor)) &&
  typeof value.lastSeen === "number";

const isRoomPresenceCursor = (value: unknown): value is RoomPresenceCursor =>
  isRecord(value) &&
  (value.documentId === undefined || typeof value.documentId === "string") &&
  typeof value.offset === "number" &&
  Number.isInteger(value.offset) &&
  value.offset >= 0;

const isTextSelection = (value: unknown): value is RoomPresenceSelection =>
  isRecord(value) &&
  (value.documentId === undefined || typeof value.documentId === "string") &&
  typeof value.from === "number" &&
  typeof value.to === "number" &&
  Number.isInteger(value.from) &&
  Number.isInteger(value.to) &&
  value.from >= 0 &&
  value.to >= value.from;
