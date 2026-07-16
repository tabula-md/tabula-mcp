import { randomUUID } from "node:crypto";
import {
  ROOM_CHECKPOINT_RETENTION_MS,
  WORKSPACE_ROOM_ROOT_ID,
  createRoomActor,
  createRoomEnvelope,
  createWorkspaceRoomCrdt,
  createWorkspaceRoomDocument,
  createWorkspaceRoomFolder,
  createWorkspaceRoomSyncController,
  decryptRoomEnvelope,
  decryptWorkspaceRoomCheckpoint,
  deleteWorkspaceRoomNode,
  getWorkspaceRoomSnapshot,
  getWorkspaceRoomStructureSnapshot,
  isRemoteSyncOrigin,
  moveWorkspaceRoomNode,
  parseRoomActor,
  renameWorkspaceRoomNode,
  validateWorkspaceRoomLimits,
  validateWorkspaceRoomStructure,
  encryptWorkspaceRoomCheckpoint,
  type EncryptedEnvelope,
  type EnvelopeKind,
  type RoomActor,
  type RoomCapability,
  type WorkspaceRoomCheckpointStore,
  type WorkspaceRoomCrdt,
  type WorkspaceRoomNode,
  type WorkspaceRoomSyncController,
  type WorkspaceRoomSyncAdapters,
  type WorkspaceRoomTransportHandlers,
} from "@tabula-md/tabula/collaboration";
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";
import {
  Awareness,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { importRoomKey, sha256Text } from "./crypto.js";
import {
  type ParsedRoomShareUrl,
  TabulaMcpError,
} from "./protocol.js";
import {
  createFirebaseWorkspaceRoomCheckpointStore,
} from "./room-checkpoints.js";
import type {
  WorkspaceChange,
  WorkspaceDocumentNode,
  WorkspaceRoomState,
} from "./workspace-contract.js";
import {
  applyTextPatchesToString,
  getMarkdownOutline,
  normalizeTextPatches,
} from "./text.js";

export type ConnectionStatus = "connecting" | "connected" | "offline" | "closed";
export type RoomRecoveryStatus = "local-bootstrap" | "checkpoint-loaded" | "checkpoint-missing" | "checkpoint-disabled" | "checkpoint-failed";
export type RoomHydrationStatus = "waiting-for-peer-state" | "ready";

export type LiveSelection = {
  documentId?: string;
  from: number;
  to: number;
};

export type Collaborator = {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  activeDocumentId?: string;
  fileTitle?: string;
  selection?: LiveSelection;
  actor?: RoomActor;
};

export type RoomCheckpointStoreStatus = {
  enabled: boolean;
  store: "firebase-storage" | "none";
  status: "disabled" | "missing" | "loaded" | "saved" | "failed";
  checkpointVersion?: number;
  updatedAt?: string;
  error?: string;
};

export type RoomClientOptions = {
  parsedRoom: ParsedRoomShareUrl;
  roomServerUrl: string;
  writeAccess: boolean;
  identityName?: string;
  identityColor?: string;
  actorCapabilities?: readonly RoomCapability[];
  roomCheckpointStore?: WorkspaceRoomCheckpointStore;
  createRoomTransport?: WorkspaceRoomSyncAdapters["createRoomTransport"];
};

export type WorkspaceSnapshotDocument = {
  documentId: string;
  title: string;
  markdown: string;
  parentId?: string | null;
  sha256?: string;
};

type WaitResult = {
  changed: boolean;
  markdown: string;
  sha256: string;
  activeDocumentId?: string;
  workspace?: WorkspaceRoomState | null;
  documents: Array<{
    documentId: string;
    title: string;
    sha256: string;
    textLength: number;
    cached: boolean;
  }>;
  changedDocumentIds: string[];
  checkpointStatus: RoomCheckpointStoreStatus;
  hydrationStatus: RoomHydrationStatus;
  stateReceived: boolean;
  lastStateReceivedAt?: string;
};

type Waiter = {
  sinceSha256?: string;
  resolve: (value: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HydrationWaiter = {
  resolve: (value: RoomHydrationStatus) => void;
  timer: ReturnType<typeof setTimeout>;
};

const LOCAL_DIRECT_ORIGIN = Symbol("tabula-mcp.direct-edit");
const CHECKPOINT_DELAY_MS = 5_000;

const createClock = () => ({
  setTimeout(callback: () => void, delayMs: number) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  createId: randomUUID,
});

const createSocketTransport = ({
  baseUrl,
  roomId,
  clientId,
  handlers,
}: {
  baseUrl: string;
  roomId: string;
  clientId: string;
  handlers: WorkspaceRoomTransportHandlers;
}) => {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ["websocket", "polling"],
  });
  socket.on("connect", () => {
    handlers.onConnect();
    socket.emit("room:join", { roomId, clientId });
  });
  socket.on("room:joined", handlers.onJoined);
  socket.on("room:peer-joined", handlers.onPeerJoined);
  socket.on("room:message", handlers.onMessage);
  socket.on("room:peers", handlers.onPeers);
  socket.on("room:error", handlers.onError);
  socket.on("disconnect", handlers.onDisconnect);
  socket.on("connect_error", handlers.onConnectError);
  return {
    get connected() {
      return socket.connected;
    },
    connect() {
      socket.connect();
    },
    sendEnvelope(envelope: EncryptedEnvelope) {
      socket.emit("room:message", envelope);
    },
    sendVolatileEnvelope(envelope: EncryptedEnvelope) {
      socket.volatile.emit("room:volatile-message", envelope);
    },
    disconnect() {
      socket.disconnect();
    },
  };
};

const getActorFromAwareness = (awareness: Awareness, actorId: string) => {
  for (const state of awareness.getStates().values()) {
    const actor = parseRoomActor(state?.actor);
    if (actor?.id === actorId) return actor;
  }
  return null;
};

const getDocumentIdForType = (room: WorkspaceRoomCrdt, type: unknown) => {
  let documentId: string | undefined;
  room.documents.forEach((text: Y.Text, id: string) => {
    if (text === type) documentId = id;
  });
  return documentId;
};

export class TabulaRoomClient {
  readonly sessionId = randomUUID();
  readonly roomId: string;
  readonly roomServerUrl: string;
  readonly shareUrl: string;
  readonly writeAccess: boolean;
  readonly actor: RoomActor;

  private readonly roomKeyValue: string;
  private readonly checkpointStore: WorkspaceRoomCheckpointStore;
  private readonly doc = new Y.Doc();
  private readonly room: WorkspaceRoomCrdt;
  private readonly awareness: Awareness;
  private readonly syncController: WorkspaceRoomSyncController;
  private readonly waiters = new Set<Waiter>();
  private readonly hydrationWaiters = new Set<HydrationWaiter>();
  private roomKey: CryptoKey | null = null;
  private statusValue: ConnectionStatus = "connecting";
  private lastErrorValue = "";
  private peerCount = 0;
  private activeDocumentId: string | undefined;
  private workspaceVersion = 1;
  private hasReceivedState = false;
  private lastStateReceivedAtValue = "";
  private checkpointGeneration = 0;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointInFlight: Promise<void> | null = null;
  private checkpointStatusValue: RoomCheckpointStoreStatus;

  constructor({
    parsedRoom,
    roomServerUrl,
    writeAccess,
    identityName,
    identityColor,
    actorCapabilities,
    roomCheckpointStore = createFirebaseWorkspaceRoomCheckpointStore(),
    createRoomTransport = createSocketTransport,
  }: RoomClientOptions) {
    this.roomId = parsedRoom.roomId;
    this.shareUrl = parsedRoom.shareUrl;
    this.roomKeyValue = parsedRoom.roomKey;
    this.roomServerUrl = roomServerUrl;
    this.checkpointStore = roomCheckpointStore;
    this.checkpointStatusValue = {
      enabled: roomCheckpointStore.enabled,
      store: roomCheckpointStore.enabled ? "firebase-storage" : "none",
      status: roomCheckpointStore.enabled ? "missing" : "disabled",
    };

    const actorId = `tabula-mcp-${randomUUID()}`;
    const capabilities = actorCapabilities?.filter((capability) =>
      capability === "presence" || capability === "read" || capability === "write"
    ) ?? (writeAccess ? ["presence", "read", "write"] : ["presence", "read"]);
    this.actor = createRoomActor({
      id: actorId,
      kind: "agent",
      client: "tabula-mcp",
      name: identityName,
      color: identityColor,
      capabilities,
      joinedAt: new Date().toISOString(),
    });
    this.writeAccess = this.actor.capabilities.includes("write");
    this.room = createWorkspaceRoomCrdt({ roomId: this.roomId, doc: this.doc });
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState({
      actor: this.actor,
      user: {
        name: this.actor.name,
        color: this.actor.color,
        colorLight: `${this.actor.color}33`,
      },
      lastSeen: Date.now(),
    });

    this.syncController = createWorkspaceRoomSyncController({
      roomId: this.roomId,
      doc: this.doc,
      awareness: this.awareness,
      adapters: {
        clock: createClock(),
        crypto: {
          encryptEnvelope: (
            key: CryptoKey,
            roomIdValue: string,
            kind: EnvelopeKind,
            version: number,
            plaintext: Uint8Array,
          ) =>
            createRoomEnvelope({ roomKey: key, roomId: roomIdValue, kind, version, plaintext }),
          decryptEnvelope: (key: CryptoKey, envelope: EncryptedEnvelope) =>
            decryptRoomEnvelope({ roomKey: key, envelope }),
        },
        createRoomTransport,
      },
      isClosed: () => this.statusValue === "closed",
      getIdentityId: () => this.actor.id,
      getSenderActor: (senderId: string) => getActorFromAwareness(this.awareness, senderId),
      onCapacityExceeded: () => {
        this.lastErrorValue = "The live workspace exceeds the supported collaboration size.";
      },
      onInvalidMessage: (message: string) => {
        this.lastErrorValue = message;
      },
      onUnsupportedMessage: () => {
        this.lastErrorValue = "This room uses an unsupported collaboration protocol.";
      },
    });

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (!isRemoteSyncOrigin(origin)) this.syncController.handleLocalUpdate(update);
      this.workspaceVersion += 1;
      this.markReceivedState();
      this.scheduleCheckpoint();
      this.notifyChange();
    });
    this.awareness.on("update", (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      this.syncController.handleAwarenessUpdate(changes, origin);
      this.notifyChange();
    });
  }

  get status() {
    return this.statusValue;
  }

  get lastError() {
    return this.lastErrorValue;
  }

  get markdown() {
    return this.getActiveText()?.toString() ?? "";
  }

  get collaboratorList(): Collaborator[] {
    const collaborators: Collaborator[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return;
      const actor = parseRoomActor(state?.actor);
      if (!actor || actor.id === this.actor.id || !actor.capabilities.includes("presence")) return;
      const selection = this.readSelection(state?.cursor);
      collaborators.push({
        id: actor.id,
        name: actor.name,
        color: actor.color ?? "#2563eb",
        lastSeen: typeof state?.lastSeen === "number" ? state.lastSeen : Date.now(),
        activeDocumentId: typeof state?.activeDocumentId === "string" ? state.activeDocumentId : undefined,
        fileTitle: typeof state?.fileTitle === "string" ? state.fileTitle : undefined,
        selection,
        actor,
      });
    });
    return collaborators.sort((first, second) =>
      first.name.localeCompare(second.name) || first.id.localeCompare(second.id)
    );
  }

  get hydrationStatus(): RoomHydrationStatus {
    return this.hasReceivedState ? "ready" : "waiting-for-peer-state";
  }

  get recoveryMode(): "durable" | "temporary" {
    return this.checkpointStore.enabled ? "durable" : "temporary";
  }

  async connect({ waitForStateMs = 0 }: { waitForStateMs?: number } = {}) {
    this.statusValue = "connecting";
    await this.ensureRoomKey();
    const recoveryStatus = this.hasReceivedState
      ? "local-bootstrap"
      : await this.loadCheckpoint();
    if (recoveryStatus === "checkpoint-failed") {
      throw new TabulaMcpError(
        this.checkpointStatusValue.error ?? "The encrypted live room could not be opened.",
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.syncController.connect(this.roomServerUrl, {
        onConnect: () => undefined,
        onJoined: (message: { roomId: string; clientId: string; peerCount: number }) => {
          this.peerCount = message.peerCount;
          this.statusValue = "connected";
          this.syncController.onJoined();
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        onPeerJoined: () => this.syncController.onPeerJoined(),
        onPeers: (message: { roomId: string; peers: string[] }) => {
          this.peerCount = message.peers.length;
          this.removeStaleAwareness(message.peers);
        },
        onError: (message: { error?: string }) => {
          this.lastErrorValue = message.error ?? "Room relay error.";
        },
        onDisconnect: () => {
          this.statusValue = this.statusValue === "closed" ? "closed" : "offline";
          this.syncController.onTransportDisconnected();
        },
        onConnectError: () => {
          this.lastErrorValue = "Live room connection failed.";
          if (!settled) {
            settled = true;
            reject(new TabulaMcpError(this.lastErrorValue));
          }
        },
      });
    });
    this.publishLocalPresence();
    await this.waitForInitialState(waitForStateMs);
    return recoveryStatus;
  }

  async getStatus() {
    const workspace = await this.projectWorkspaceState();
    const activeDocumentTitle = this.activeDocumentId
      ? this.getDocumentNode(this.activeDocumentId)?.title
      : undefined;
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      shareUrl: this.shareUrl,
      roomServerUrl: this.roomServerUrl,
      status: this.statusValue,
      writeAccess: this.writeAccess,
      actor: this.actor,
      capabilities: this.actor.capabilities,
      textLength: this.markdown.length,
      sha256: await sha256Text(this.markdown),
      socketConnected: this.syncController.isConnected(),
      ...this.roomStateReadiness(),
      peerCount: this.peerCount,
      collaborators: this.collaboratorList,
      workspaceMode: true,
      activeDocumentId: this.activeDocumentId,
      activeDocumentTitle,
      workspaceVersion: workspace.version,
      recoveryMode: this.recoveryMode,
      checkpointStatus: this.checkpointStatusValue,
      metadata: null,
      lastError: this.lastErrorValue || undefined,
    };
  }

  async readMarkdown() {
    this.assertHydrated("read Markdown");
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      markdown: this.markdown,
      textLength: this.markdown.length,
      sha256: await sha256Text(this.markdown),
      ...this.roomStateReadiness(),
    };
  }

  async getOutline() {
    this.assertHydrated("read the Markdown outline");
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      outline: getMarkdownOutline(this.markdown),
      sha256: await sha256Text(this.markdown),
      ...this.roomStateReadiness(),
    };
  }

  async readWorkspace() {
    this.assertHydrated("read the workspace");
    const workspace = await this.projectWorkspaceState();
    const documents = workspace.nodes.filter(
      (node): node is WorkspaceDocumentNode => node.type === "document",
    ).map((node) => ({ ...node, cached: true }));
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      workspace,
      activeDocumentId: this.activeDocumentId,
      documents,
      cachedDocumentCount: documents.length,
      ...this.roomStateReadiness(),
    };
  }

  async readWorkspaceSnapshot() {
    this.assertHydrated("read the workspace snapshot");
    const snapshot = getWorkspaceRoomSnapshot(this.room);
    return {
      sessionId: this.sessionId,
      workspace: await this.projectWorkspaceState(),
      documents: snapshot.documents,
      commentsByFileId: snapshot.commentsByFileId,
      activeDocumentId: this.activeDocumentId,
    };
  }

  async readWorkspaceDocument({ documentId }: { documentId: string }) {
    this.assertHydrated("read workspace documents");
    const node = this.getDocumentNode(documentId);
    const text = this.room.documents.get(documentId);
    if (!node || !text) throw new TabulaMcpError("Workspace document was not found.");
    const markdown = text.toString();
    this.activeDocumentId = documentId;
    this.publishLocalPresence();
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      documentId,
      title: node.title,
      markdown,
      textLength: markdown.length,
      sha256: await sha256Text(markdown),
      cachedAt: new Date().toISOString(),
      ...this.roomStateReadiness(),
    };
  }

  async publishWorkspaceSnapshot({
    workspace,
    documents,
  }: {
    workspace: WorkspaceRoomState;
    documents: readonly WorkspaceSnapshotDocument[];
  }) {
    this.assertWritable("publish workspace state");
    await this.ensureRoomKey();
    if (workspace.roomId !== this.roomId) {
      throw new TabulaMcpError("Workspace roomId must match the connected room.");
    }
    const documentsById = new Map(documents.map((document) => [document.documentId, document]));
    this.doc.transact(() => {
      for (const node of workspace.nodes.filter((candidate) => candidate.id !== workspace.rootId)) {
        if (node.type === "folder") {
          createWorkspaceRoomFolder(this.room, {
            id: node.id,
            parentId: !node.parentId || node.parentId === workspace.rootId
              ? WORKSPACE_ROOM_ROOT_ID
              : node.parentId,
            title: node.title,
            order: node.order ?? 0,
            createdAt: node.createdAt,
          });
        } else {
          const document = documentsById.get(node.id);
          if (!document) throw new TabulaMcpError(`Workspace checkpoint is missing document ${node.id}.`);
          createWorkspaceRoomDocument(this.room, {
            id: node.id,
            parentId: !node.parentId || node.parentId === workspace.rootId
              ? WORKSPACE_ROOM_ROOT_ID
              : node.parentId,
            title: node.title,
            order: node.order ?? 0,
            createdAt: node.createdAt,
            markdown: document.markdown,
          });
        }
      }
    }, LOCAL_DIRECT_ORIGIN);
    this.activeDocumentId = workspace.activeDocumentId ?? documents[0]?.documentId;
    this.publishLocalPresence();
    this.markReceivedState();
    if (this.checkpointStore.enabled) {
      await this.saveCheckpointNow();
      if (this.checkpointStatusValue.status !== "saved") {
        throw new TabulaMcpError(
          this.checkpointStatusValue.error ?? "The encrypted live room could not be saved.",
        );
      }
    }
    return {
      emittedWorkspace: true,
      emittedDocumentCount: documents.length,
      checkpointStatus: this.checkpointStatusValue,
    };
  }

  async applyWorkspaceChanges({ changes }: { changes: readonly WorkspaceChange[] }) {
    this.assertWritable("edit workspace documents");
    this.assertHydrated("edit workspace documents");
    if (changes.length === 0) throw new TabulaMcpError("At least one workspace change is required.");

    const draftDoc = new Y.Doc();
    Y.applyUpdate(draftDoc, Y.encodeStateAsUpdate(this.doc));
    const draftRoom = createWorkspaceRoomCrdt({ roomId: this.roomId, doc: draftDoc, initialize: false });
    const changedDocumentIds = new Set<string>();
    const appliedChanges: WorkspaceChange[] = [];
    try {
      for (const input of changes) {
        if (input.type === "document.patch") {
          const text = draftRoom.documents.get(input.documentId);
          if (!text) throw new TabulaMcpError(`Workspace document ${input.documentId} was not found.`);
          const markdown = text.toString();
          if (await sha256Text(markdown) !== input.baseSha256) {
            throw new TabulaMcpError(`Workspace document ${input.documentId} changed before the edit could be applied.`);
          }
          const patches = normalizeTextPatches(input.patches);
          const next = applyTextPatchesToString(markdown, patches);
          text.delete(0, text.length);
          if (next) text.insert(0, next);
          changedDocumentIds.add(input.documentId);
          appliedChanges.push({ ...input, patches });
          continue;
        }
        if (input.type === "document.create") {
          const documentId = randomUUID();
          if (!createWorkspaceRoomDocument(draftRoom, {
            id: documentId,
            parentId: input.parentId ?? WORKSPACE_ROOM_ROOT_ID,
            title: input.title,
            order: this.nextOrder(draftRoom),
            createdAt: new Date().toISOString(),
            markdown: input.markdown,
          })) throw new TabulaMcpError("Workspace document could not be created.");
          changedDocumentIds.add(documentId);
          appliedChanges.push(input);
          continue;
        }
        const node = draftRoom.nodes.get(input.documentId);
        if (!node) throw new TabulaMcpError(`Workspace node ${input.documentId} was not found.`);
        if (input.type === "document.rename") {
          if (!renameWorkspaceRoomNode(draftRoom, input.documentId, input.title)) {
            throw new TabulaMcpError("Workspace document could not be renamed.");
          }
        } else if (input.type === "document.move") {
          if (!moveWorkspaceRoomNode(draftRoom, input.documentId, input.parentId ?? WORKSPACE_ROOM_ROOT_ID)) {
            throw new TabulaMcpError("Workspace document could not be moved.");
          }
        } else {
          const text = draftRoom.documents.get(input.documentId)?.toString();
          if (input.baseSha256 && text !== undefined && await sha256Text(text) !== input.baseSha256) {
            throw new TabulaMcpError(`Workspace document ${input.documentId} changed before deletion.`);
          }
          deleteWorkspaceRoomNode(draftRoom, input.documentId);
        }
        changedDocumentIds.add(input.documentId);
        appliedChanges.push(input);
      }

      const structure = validateWorkspaceRoomStructure(draftRoom, this.roomId);
      if (!structure.ok) throw new TabulaMcpError(structure.message);
      const limits = validateWorkspaceRoomLimits(getWorkspaceRoomSnapshot(draftRoom));
      if (!limits.ok) throw new TabulaMcpError(limits.message);
      const update = Y.encodeStateAsUpdate(draftDoc, Y.encodeStateVector(this.doc));
      Y.applyUpdate(this.doc, update, LOCAL_DIRECT_ORIGIN);
    } finally {
      draftDoc.destroy();
    }

    if (this.activeDocumentId && !this.room.documents.has(this.activeDocumentId)) {
      this.activeDocumentId = this.firstDocumentId();
    }
    this.publishLocalPresence();
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      applied: true,
      changes: appliedChanges,
      changedDocumentIds: [...changedDocumentIds],
      workspace: await this.projectWorkspaceState(),
      documents: (await this.workspaceWaitSnapshot()).documents,
    };
  }

  async setPresence(selection?: LiveSelection, fileTitle?: string) {
    if (selection?.documentId) this.activeDocumentId = selection.documentId;
    this.publishLocalPresence(selection, fileTitle);
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      identity: {
        id: this.actor.id,
        name: this.actor.name,
        color: this.actor.color ?? "#2563eb",
        lastSeen: Date.now(),
        fileTitle,
        selection,
        actor: this.actor,
      },
    };
  }

  async waitForChange(sinceSha256?: string, timeoutMs = 15_000): Promise<WaitResult> {
    const currentSha256 = await sha256Text(this.markdown);
    if (sinceSha256 && sinceSha256 !== currentSha256) {
      return this.createWaitResult(true, currentSha256);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        this.waiters.delete(waiter);
        resolve(await this.createWaitResult(false, await sha256Text(this.markdown)));
      }, Math.max(0, Math.min(timeoutMs, 30_000)));
      const waiter = { sinceSha256, resolve, timer };
      this.waiters.add(waiter);
    });
  }

  disconnect() {
    if (this.statusValue === "closed") return;
    this.statusValue = "closed";
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    removeAwarenessStates(this.awareness, [this.awareness.clientID], "tabula.disconnect");
    this.syncController.dispose();
    this.awareness.destroy();
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    for (const waiter of this.hydrationWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("waiting-for-peer-state");
    }
    this.hydrationWaiters.clear();
    this.doc.destroy();
  }

  private getActiveText() {
    const documentId = this.activeDocumentId ?? this.firstDocumentId();
    if (documentId && !this.activeDocumentId) this.activeDocumentId = documentId;
    return documentId ? this.room.documents.get(documentId) ?? null : null;
  }

  private async ensureRoomKey() {
    if (this.roomKey) return this.roomKey;
    this.roomKey = await importRoomKey(this.roomKeyValue);
    this.syncController.setRoomKey(this.roomKey);
    return this.roomKey;
  }

  private firstDocumentId() {
    return getWorkspaceRoomStructureSnapshot(this.room).nodes.find(
      (node: WorkspaceRoomNode) => node.type === "document",
    )?.id;
  }

  private getDocumentNode(documentId: string) {
    return getWorkspaceRoomStructureSnapshot(this.room).nodes.find(
      (node: WorkspaceRoomNode) => node.id === documentId && node.type === "document",
    );
  }

  private async projectWorkspaceState(): Promise<WorkspaceRoomState> {
    const structure = getWorkspaceRoomStructureSnapshot(this.room);
    const nodes = await Promise.all(structure.nodes.map(async (node: WorkspaceRoomNode) => {
      if (node.type === "folder") return node;
      const markdown = this.room.documents.get(node.id)?.toString() ?? "";
      return {
        ...node,
        sha256: await sha256Text(markdown),
        textLength: markdown.length,
      };
    }));
    return {
      roomId: this.roomId,
      mode: "workspace",
      version: this.workspaceVersion,
      rootId: structure.rootId,
      nodes,
      activeDocumentId: this.activeDocumentId,
    };
  }

  private readSelection(cursor: unknown): LiveSelection | undefined {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    const value = cursor as { anchor?: Y.RelativePosition; head?: Y.RelativePosition };
    if (!value.anchor || !value.head) return undefined;
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(value.anchor, this.doc);
      const head = Y.createAbsolutePositionFromRelativePosition(value.head, this.doc);
      if (!anchor || !head || anchor.type !== head.type) return undefined;
      const documentId = getDocumentIdForType(this.room, anchor.type);
      return documentId
        ? { documentId, from: Math.min(anchor.index, head.index), to: Math.max(anchor.index, head.index) }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private publishLocalPresence(selection?: LiveSelection, fileTitle?: string) {
    const state = { ...this.awareness.getLocalState() } as Record<string, unknown>;
    state.actor = this.actor;
    state.user = {
      name: this.actor.name,
      color: this.actor.color,
      colorLight: `${this.actor.color}33`,
    };
    state.lastSeen = Date.now();
    if (this.activeDocumentId) state.activeDocumentId = this.activeDocumentId;
    else delete state.activeDocumentId;
    if (fileTitle) state.fileTitle = fileTitle;
    if (selection && this.activeDocumentId) {
      const text = this.room.documents.get(this.activeDocumentId);
      if (text) {
        const from = Math.max(0, Math.min(selection.from, text.length));
        const to = Math.max(0, Math.min(selection.to, text.length));
        state.cursor = {
          anchor: Y.createRelativePositionFromTypeIndex(text, from),
          head: Y.createRelativePositionFromTypeIndex(text, to),
        };
      }
    } else {
      state.cursor = null;
    }
    this.awareness.setLocalState(state);
  }

  private removeStaleAwareness(peerIds: readonly string[]) {
    const allowed = new Set(peerIds);
    const stale: number[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return;
      const actor = parseRoomActor(state?.actor);
      if (actor && !allowed.has(actor.id)) stale.push(clientId);
    });
    if (stale.length) removeAwarenessStates(this.awareness, stale, "transport.peers");
  }

  private assertWritable(action: string) {
    if (!this.writeAccess) throw new TabulaMcpError(`Write access is required to ${action}.`);
  }

  private assertHydrated(action: string) {
    if (!this.hasReceivedState) {
      throw new TabulaMcpError(
        `Room is connected but waiting for workspace state. Wait for a live peer or encrypted checkpoint before attempting to ${action}.`,
      );
    }
  }

  private nextOrder(room: WorkspaceRoomCrdt) {
    const nodes = getWorkspaceRoomStructureSnapshot(room).nodes;
    return Math.max(0, ...nodes.map((node: WorkspaceRoomNode) => node.order)) + 1;
  }

  private roomStateReadiness() {
    return {
      hydrationStatus: this.hydrationStatus,
      stateReceived: this.hasReceivedState,
      lastStateReceivedAt: this.lastStateReceivedAtValue || undefined,
    };
  }

  private markReceivedState() {
    const wasHydrated = this.hasReceivedState;
    this.hasReceivedState = true;
    this.lastStateReceivedAtValue = new Date().toISOString();
    if (wasHydrated) return;
    for (const waiter of this.hydrationWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("ready");
    }
    this.hydrationWaiters.clear();
  }

  private async waitForInitialState(timeoutMs: number): Promise<RoomHydrationStatus> {
    if (this.hasReceivedState || timeoutMs <= 0) return this.hydrationStatus;
    const boundedTimeout = Math.max(0, Math.min(timeoutMs, 30_000));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.hydrationWaiters.delete(waiter);
        resolve(this.hydrationStatus);
      }, boundedTimeout);
      const waiter = { resolve, timer };
      this.hydrationWaiters.add(waiter);
    });
  }

  private scheduleCheckpoint() {
    if (!this.checkpointStore.enabled || !this.roomKey || this.statusValue === "closed") return;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      void this.saveCheckpointNow();
    }, CHECKPOINT_DELAY_MS);
  }

  private async loadCheckpoint(): Promise<RoomRecoveryStatus> {
    if (!this.checkpointStore.enabled || !this.roomKey) return "checkpoint-disabled";
    try {
      const loaded = await this.checkpointStore.loadEncryptedCheckpoint(this.roomId);
      if (!loaded) {
        this.checkpointStatusValue = { enabled: true, store: "firebase-storage", status: "missing" };
        return "checkpoint-missing";
      }
      this.checkpointGeneration = loaded.generation;
      if (loaded.status === "expired") {
        this.checkpointStatusValue = {
          enabled: true,
          store: "firebase-storage",
          status: "failed",
          checkpointVersion: loaded.generation,
          error: "This live room has expired.",
        };
        return "checkpoint-failed";
      }
      const update = await decryptWorkspaceRoomCheckpoint({
        encryptedCheckpoint: loaded.encryptedCheckpoint,
        roomId: this.roomId,
        roomKey: this.roomKey,
      });
      Y.applyUpdate(this.doc, update, { type: Symbol("checkpoint") });
      this.activeDocumentId = this.firstDocumentId();
      this.markReceivedState();
      this.checkpointStatusValue = {
        enabled: true,
        store: "firebase-storage",
        status: "loaded",
        checkpointVersion: loaded.generation,
        updatedAt: new Date().toISOString(),
      };
      return "checkpoint-loaded";
    } catch (error) {
      this.checkpointStatusValue = {
        enabled: true,
        store: "firebase-storage",
        status: "failed",
        error: error instanceof Error ? error.message : "Room checkpoint could not be loaded.",
      };
      return "checkpoint-failed";
    }
  }

  private async saveCheckpointNow() {
    if (!this.checkpointStore.enabled || !this.roomKey || this.statusValue === "closed") return;
    if (this.checkpointInFlight) return this.checkpointInFlight;
    this.checkpointInFlight = this.performCheckpointSave().finally(() => {
      this.checkpointInFlight = null;
    });
    return this.checkpointInFlight;
  }

  private async performCheckpointSave() {
    if (!this.roomKey) return;
    const save = async (expectedGeneration: number) => {
      const encryptedCheckpoint = await encryptWorkspaceRoomCheckpoint({
        roomId: this.roomId,
        update: Y.encodeStateAsUpdate(this.doc),
        roomKey: this.roomKey!,
      });
      return this.checkpointStore.saveEncryptedCheckpoint(this.roomId, {
        expectedGeneration,
        encryptedCheckpoint,
        expiresAt: Date.now() + ROOM_CHECKPOINT_RETENTION_MS,
      });
    };
    try {
      let result = await save(this.checkpointGeneration);
      if (!result.ok) {
        const latest = await this.checkpointStore.loadEncryptedCheckpoint(this.roomId);
        if (latest?.status === "ready") {
          const update = await decryptWorkspaceRoomCheckpoint({
            encryptedCheckpoint: latest.encryptedCheckpoint,
            roomId: this.roomId,
            roomKey: this.roomKey,
          });
          Y.applyUpdate(this.doc, update, { type: Symbol("checkpoint-merge") });
          this.checkpointGeneration = latest.generation;
          result = await save(latest.generation);
        }
      }
      if (!result.ok) throw new Error("Room checkpoint changed during save.");
      this.checkpointGeneration = result.generation;
      this.checkpointStatusValue = {
        enabled: true,
        store: "firebase-storage",
        status: "saved",
        checkpointVersion: result.generation,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.checkpointStatusValue = {
        enabled: true,
        store: "firebase-storage",
        status: "failed",
        error: error instanceof Error ? error.message : "Room checkpoint could not be saved.",
      };
    }
  }

  private async workspaceWaitSnapshot() {
    const workspace = await this.projectWorkspaceState();
    const documents = workspace.nodes.filter(
      (node): node is WorkspaceDocumentNode => node.type === "document",
    ).map((node) => ({
      documentId: node.id,
      title: node.title,
      sha256: node.sha256,
      textLength: node.textLength,
      cached: true,
    }));
    return {
      activeDocumentId: this.activeDocumentId,
      workspace,
      documents,
      checkpointStatus: this.checkpointStatusValue,
    };
  }

  private async createWaitResult(changed: boolean, sha256: string): Promise<WaitResult> {
    return {
      changed,
      markdown: this.markdown,
      sha256,
      changedDocumentIds: changed && this.activeDocumentId ? [this.activeDocumentId] : [],
      ...(await this.workspaceWaitSnapshot()),
      ...this.roomStateReadiness(),
    };
  }

  private notifyChange() {
    void Promise.all([...this.waiters].map(async (waiter) => {
      const sha256 = await sha256Text(this.markdown);
      if (waiter.sinceSha256 && waiter.sinceSha256 === sha256) return;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(await this.createWaitResult(true, sha256));
    }));
  }
}
