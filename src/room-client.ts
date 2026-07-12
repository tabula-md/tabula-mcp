import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";
import {
  decryptEnvelopeForRoom,
  encryptBytesForRoom,
  importRoomKey,
  sha256Text,
} from "./crypto.js";
import {
  assertEncryptedEnvelope,
  decodeBase64Url,
  encodeBase64Url,
  type EnvelopeKind,
  type ParsedRoomShareUrl,
  TabulaMcpError,
} from "./protocol.js";
import {
  createFirebaseRoomCheckpointStore,
  createWorkspaceRoomCheckpoint,
  decryptWorkspaceRoomCheckpoint,
  encryptWorkspaceRoomCheckpoint,
  failedCheckpointStatus,
  type RoomCheckpointStore,
  type RoomCheckpointStoreStatus,
  type WorkspaceRoomCheckpoint,
  type WorkspaceRoomCheckpointDocument,
} from "./room-checkpoints.js";
import {
  createAgentActor,
  createRoomEventId,
  decodeRoomEvent,
  encodeRoomEvent,
  isRoomActor,
  isWorkspaceChange,
  type RoomPresenceSelection,
  type RoomActor,
  type RoomCapability,
  type RoomEvent,
  type WorkspaceChange,
  type WorkspaceDocumentNode,
  type WorkspaceFolderNode,
  type WorkspaceNode,
  type WorkspaceRoomState,
} from "./room-events.js";
import {
  applyTextPatchesToString,
  getMarkdownOutline,
  normalizeTextPatches,
  type TextPatch,
} from "./text.js";

export type ConnectionStatus = "connecting" | "connected" | "offline" | "closed";
export type RoomRecoveryStatus = "checkpoint-loaded" | "checkpoint-missing" | "checkpoint-disabled" | "checkpoint-failed";
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
  fileTitle?: string;
  selection?: LiveSelection;
  actor?: RoomActor;
};

export type RoomClientOptions = {
  parsedRoom: ParsedRoomShareUrl;
  roomServerUrl: string;
  writeAccess: boolean;
  identityName?: string;
  identityColor?: string;
  actorCapabilities?: readonly RoomCapability[];
  roomCheckpointStore?: RoomCheckpointStore;
};

type Waiter = {
  sinceSha256?: string;
  resolve: (value: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
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
  roomEvents?: RoomEvent[];
};

type WorkspaceDocumentCache = {
  documentId: string;
  title?: string;
  markdown: string;
  textLength: number;
  sha256: string;
  updatedAt: string;
};

export type WorkspaceSnapshotDocument = {
  documentId: string;
  title: string;
  markdown: string;
  parentId?: string | null;
  sha256?: string;
};

type WorkspaceYDocState = {
  doc: Y.Doc;
  text: Y.Text;
};

type JoinedPayload = {
  roomId: string;
  clientId: string;
  peerCount: number;
};

type PeersPayload = {
  roomId: string;
  peers: string[];
};

const REMOTE_ORIGIN = "tabula-room-remote";
const LOCAL_DIRECT_ORIGIN = "tabula-mcp-direct-edit";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isJoinedPayload = (value: unknown, roomId: string, clientId: string): value is JoinedPayload =>
  isRecord(value) &&
  value.roomId === roomId &&
  value.clientId === clientId &&
  typeof value.peerCount === "number";

const isPeersPayload = (value: unknown, roomId: string): value is PeersPayload =>
  isRecord(value) &&
  value.roomId === roomId &&
  Array.isArray(value.peers) &&
  value.peers.every((peer) => typeof peer === "string");

const isPeerJoinedPayload = (value: unknown, roomId: string): value is { roomId: string; clientId: string } =>
  isRecord(value) && value.roomId === roomId && typeof value.clientId === "string";

export class TabulaRoomClient {
  readonly sessionId = randomUUID();
  readonly roomId: string;
  readonly roomServerUrl: string;
  readonly shareUrl: string;
  readonly writeAccess: boolean;
  readonly actor: RoomActor;
  readonly identity: Collaborator;

  private readonly roomKeyValue: string;
  private readonly roomCheckpointStore: RoomCheckpointStore;
  private readonly doc = new Y.Doc();
  private readonly text: Y.Text;
  private readonly collaborators = new Map<string, Collaborator>();
  private readonly workspaceDocuments = new Map<string, WorkspaceDocumentCache>();
  private readonly workspaceYDocs = new Map<string, WorkspaceYDocState>();
  private readonly recentRoomEvents: RoomEvent[] = [];
  private readonly waiters = new Set<Waiter>();
  private socket: Socket | null = null;
  private roomKey: CryptoKey | null = null;
  private workspaceStateValue: WorkspaceRoomState | null = null;
  private envelopeVersion = 0;
  private peerCount = 0;
  private statusValue: ConnectionStatus = "connecting";
  private lastErrorValue = "";
  private hasReceivedState = false;
  private hasReceivedLegacyTextState = false;
  private lastStateReceivedAtValue = "";
  private roomCheckpointStatusValue: RoomCheckpointStoreStatus;

  constructor({
    parsedRoom,
    roomServerUrl,
    writeAccess,
    identityName,
    identityColor,
    actorCapabilities,
    roomCheckpointStore = createFirebaseRoomCheckpointStore(),
  }: RoomClientOptions) {
    const actorId = `tabula-mcp-${randomUUID()}`;
    const actorColor = identityColor?.trim() || "#2563eb";
    const actorName = identityName?.trim() || "Tabula Agent";

    this.roomId = parsedRoom.roomId;
    this.shareUrl = parsedRoom.shareUrl;
    this.roomKeyValue = parsedRoom.roomKey;
    this.roomServerUrl = roomServerUrl;
    this.roomCheckpointStore = roomCheckpointStore;
    this.roomCheckpointStatusValue = roomCheckpointStore.initialStatus();
    this.text = this.doc.getText("markdown");
    this.actor = createAgentActor({
      id: actorId,
      name: actorName,
      color: actorColor,
      capabilities: actorCapabilities,
    });
    this.writeAccess = this.actor.capabilities.includes("write");
    this.identity = {
      id: actorId,
      name: actorName,
      color: actorColor,
      lastSeen: Date.now(),
      fileTitle: "Live Markdown",
      actor: this.actor,
    };

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN || this.statusValue === "closed") {
        return;
      }

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
    return this.text.toString();
  }

  get collaboratorList() {
    return [...this.collaborators.values()].sort((first, second) => first.name.localeCompare(second.name));
  }

  get hydrationStatus(): RoomHydrationStatus {
    return this.hasReceivedState ? "ready" : "waiting-for-peer-state";
  }

  async connect() {
    this.statusValue = "connecting";
    this.roomKey = await importRoomKey(this.roomKeyValue);
    const recoveryStatus = await this.loadWorkspaceRoomCheckpoint();
    await this.connectSocket();
    this.statusValue = "connected";
    await this.publishActorJoined();
    await this.publishPresence();

    return recoveryStatus;
  }

  async getStatus() {
    const metadata = await this.fetchRoomMetadata().catch(() => null);
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
      socketConnected: Boolean(this.socket?.connected),
      ...this.roomStateReadiness(),
      peerCount: this.peerCount,
      collaborators: this.collaboratorList.map(({ id, name, color, fileTitle, selection, lastSeen, actor }) => ({
        id,
        name,
        color,
        fileTitle,
        selection,
        lastSeen,
        actor,
      })),
      workspaceMode: Boolean(this.workspaceStateValue),
      activeDocumentId: this.workspaceStateValue?.activeDocumentId,
      workspaceVersion: this.workspaceStateValue?.version,
      lastRoomEventAt: this.recentRoomEvents.at(-1)?.createdAt,
      checkpointStatus: this.roomCheckpointStatusValue,
      metadata,
      lastError: this.lastErrorValue || undefined,
    };
  }

  async readMarkdown() {
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
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      outline: getMarkdownOutline(this.markdown),
      sha256: await sha256Text(this.markdown),
      ...this.roomStateReadiness(),
    };
  }

  async readWorkspace() {
    await this.syncActiveWorkspaceDocument();

    const documents = this.workspaceStateValue?.nodes
      .filter((node): node is WorkspaceDocumentNode => node.type === "document")
      .map((node) => ({
        ...node,
        cached: this.workspaceDocuments.has(node.id),
      })) ?? [];

    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      workspace: this.workspaceStateValue,
      activeDocumentId: this.workspaceStateValue?.activeDocumentId,
      documents,
      cachedDocumentCount: this.workspaceDocuments.size,
      ...this.roomStateReadiness(),
      note: this.workspaceStateValue
        ? undefined
        : "Workspace metadata has not been received yet. Wait for a Tabula.md workspace peer to publish workspace.updated.",
    };
  }

  async readWorkspaceDocument({ documentId }: { documentId: string }) {
    await this.syncActiveWorkspaceDocument();

    const document = this.getWorkspaceDocumentNode(documentId);
    if (!document) {
      throw new TabulaMcpError("Workspace document was not found in the latest workspace state.");
    }

    const cached = this.workspaceDocuments.get(documentId);
    if (!cached) {
      throw new TabulaMcpError(
        "Workspace document text has not been received by this MCP session yet. Ask a live Tabula.md peer to publish document state, then wait for changes and read again.",
      );
    }

    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      documentId,
      title: document.title,
      markdown: cached.markdown,
      textLength: cached.textLength,
      sha256: cached.sha256,
      cachedAt: cached.updatedAt,
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
    if (!this.socket?.connected || this.statusValue === "closed") {
      throw new TabulaMcpError("A connected room session is required before publishing a workspace snapshot.");
    }
    if (workspace.roomId !== this.roomId) {
      throw new TabulaMcpError("Workspace roomId must match the connected room.");
    }

    this.workspaceStateValue = workspace;
    this.pruneWorkspaceDocumentCaches();

    await this.publishWorkspaceUpdatedEvent(workspace);

    let emittedDocumentCount = 0;
    for (const document of documents) {
      const documentNode = this.getWorkspaceDocumentNode(document.documentId);
      if (!documentNode) {
        throw new TabulaMcpError(`Workspace document ${document.documentId} is not present in the workspace state.`);
      }

      const documentSha256 = document.sha256 ?? (await sha256Text(document.markdown));
      await this.cacheWorkspaceDocumentMarkdown(document.documentId, document.markdown, documentSha256);
      const workspaceDoc = this.getWorkspaceYDoc(document.documentId);
      this.replaceYTextSilently(workspaceDoc, document.markdown);
      await this.publishTextUpdatedEvent({
        documentId: document.documentId,
        sha256: documentSha256,
        update: Y.encodeStateAsUpdate(workspaceDoc.doc),
      });
      emittedDocumentCount += 1;
    }

    this.markReceivedState();
    const checkpointStatus = await this.saveWorkspaceRoomCheckpoint({ workspace, documents });
    return {
      emittedWorkspace: true,
      emittedDocumentCount,
      checkpointStatus,
    };
  }

  async applyWorkspaceChanges({ changes }: { changes: readonly WorkspaceChange[] }) {
    if (!this.workspaceStateValue) {
      throw new TabulaMcpError(
        "Workspace state has not been received yet. Wait for a Tabula.md workspace peer to publish workspace.updated before applying workspace changes.",
      );
    }
    if (!changes.length) {
      throw new TabulaMcpError("At least one workspace change is required.");
    }

    const appliedChanges: WorkspaceChange[] = [];
    const changedDocumentIds = new Set<string>();
    let emittedWorkspaceUpdateCount = 0;
    let emittedTextUpdateCount = 0;

    for (const inputChange of changes) {
      const change = await this.normalizeWorkspaceChange(inputChange);
      appliedChanges.push(change);

      if (change.type === "document.patch") {
        this.assertCapability("write", "patch workspace documents");
        const emitted = await this.applyDocumentPatchChange(change);
        if (emitted) {
          emittedTextUpdateCount += 1;
          changedDocumentIds.add(change.documentId);
        }
        continue;
      }

      if (change.type === "document.create") {
        this.assertCapability("create", "create workspace documents");
        const documentId = await this.applyDocumentCreateChange(change);
        emittedWorkspaceUpdateCount += 1;
        emittedTextUpdateCount += 1;
        changedDocumentIds.add(documentId);
        continue;
      }

      if (change.type === "document.rename") {
        this.assertCapability("write", "rename workspace documents");
        await this.applyWorkspaceMetadataChange((workspace, now) => ({
          ...workspace,
          nodes: workspace.nodes.map((node) =>
            node.id === change.documentId ? { ...node, title: change.title, updatedAt: now } : node,
          ),
        }));
        emittedWorkspaceUpdateCount += 1;
        changedDocumentIds.add(change.documentId);
        continue;
      }

      if (change.type === "document.move") {
        this.assertCapability("move", "move workspace documents");
        await this.applyWorkspaceMetadataChange((workspace, now) => ({
          ...workspace,
          nodes: workspace.nodes.map((node) =>
            node.id === change.documentId ? { ...node, parentId: change.parentId, updatedAt: now } : node,
          ),
        }));
        emittedWorkspaceUpdateCount += 1;
        changedDocumentIds.add(change.documentId);
        continue;
      }

      this.assertCapability("delete", "delete workspace documents");
      await this.applyDocumentDeleteChange(change);
      emittedWorkspaceUpdateCount += 1;
      changedDocumentIds.add(change.documentId);
    }

    this.notifyChange();
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      applied: true,
      changes: appliedChanges,
      changedDocumentIds: [...changedDocumentIds],
      emittedWorkspaceUpdateCount,
      emittedTextUpdateCount,
      workspace: this.workspaceStateValue,
      documents: this.workspaceWaitSnapshot().documents,
    };
  }

  async setPresence(selection?: LiveSelection, fileTitle?: string) {
    if (selection) {
      this.identity.selection = {
        documentId: selection.documentId,
        from: Math.max(0, Math.min(selection.from, this.markdown.length)),
        to: Math.max(0, Math.min(selection.to, this.markdown.length)),
      };
    }
    if (fileTitle?.trim()) {
      this.identity.fileTitle = fileTitle.trim();
    }
    await this.publishPresence();

    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      identity: this.identity,
    };
  }

  async waitForChange(sinceSha256?: string, timeoutMs = 15_000): Promise<WaitResult> {
    const currentMarkdown = this.markdown;
    const currentSha256 = await sha256Text(currentMarkdown);
    if (sinceSha256 && sinceSha256 !== currentSha256) {
      return {
        changed: true,
        markdown: currentMarkdown,
        sha256: currentSha256,
        changedDocumentIds: this.activeChangedDocumentIds(),
        ...this.workspaceWaitSnapshot(),
        ...this.roomStateReadiness(),
      };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve({
          changed: false,
          markdown: this.markdown,
          sha256: currentSha256,
          changedDocumentIds: [],
          ...this.workspaceWaitSnapshot(),
          ...this.roomStateReadiness(),
        });
      }, Math.max(0, Math.min(timeoutMs, 30_000)));

      const waiter: Waiter = {
        sinceSha256,
        resolve,
        timer,
      };
      this.waiters.add(waiter);
    });
  }

  disconnect() {
    if (this.statusValue !== "closed") {
      void this.publishRoomEvent(
        {
          id: createRoomEventId(),
          type: "actor.left",
          roomId: this.roomId,
          actorId: this.actor.id,
          createdAt: new Date().toISOString(),
        },
        { volatile: true },
      );
    }
    this.statusValue = "closed";
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
        waiter.resolve({
          changed: false,
          markdown: this.markdown,
          sha256: "",
          changedDocumentIds: [],
          ...this.workspaceWaitSnapshot(),
          ...this.roomStateReadiness(),
        });
    }
    this.waiters.clear();
    this.socket?.disconnect();
    this.socket = null;
    this.doc.destroy();
    for (const workspaceDoc of this.workspaceYDocs.values()) {
      workspaceDoc.doc.destroy();
    }
    this.workspaceYDocs.clear();
  }

  private async connectSocket() {
    this.socket?.disconnect();
    const socket = io(this.roomServerUrl, {
      autoConnect: false,
      transports: ["websocket", "polling"],
    });
    this.socket = socket;

    socket.on("room:message", (envelope) => {
      void this.applyIncomingEnvelope(envelope);
    });
    socket.on("room:peer-joined", (message) => {
      if (!isPeerJoinedPayload(message, this.roomId) || message.clientId === this.identity.id) {
        return;
      }
      void this.emitCurrentState();
      void this.publishPresence();
    });
    socket.on("room:peers", (message) => {
      if (!isPeersPayload(message, this.roomId)) {
        return;
      }
      this.peerCount = message.peers.length;
      const peers = new Set(message.peers);
      for (const collaboratorId of this.collaborators.keys()) {
        if (!peers.has(collaboratorId)) {
          this.collaborators.delete(collaboratorId);
        }
      }
      if (message.peers.length > 1) {
        void this.emitCurrentState();
        void this.publishPresence();
      }
    });
    socket.on("room:error", (message: { error?: string }) => {
      this.lastErrorValue = message.error || "Room server returned an error.";
    });
    socket.on("disconnect", () => {
      if (this.statusValue !== "closed") {
        this.statusValue = "offline";
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new TabulaMcpError("Timed out connecting to the Tabula Room server."));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("connect_error", onConnectError);
        socket.off("room:joined", onJoined);
      };
      const onConnect = () => {
        socket.emit("room:join", { roomId: this.roomId, clientId: this.identity.id }, (ack: { ok?: boolean; error?: string }) => {
          if (ack && ack.ok === false) {
            cleanup();
            reject(new TabulaMcpError(ack.error || "Room join was rejected."));
          }
        });
      };
      const onConnectError = (error: Error) => {
        cleanup();
        reject(new TabulaMcpError(`Could not reach Tabula Room: ${error.message}`));
      };
      const onJoined = (message: unknown) => {
        if (!isJoinedPayload(message, this.roomId, this.identity.id)) {
          return;
        }
        cleanup();
        this.peerCount = message.peerCount;
        resolve();
      };

      socket.on("connect", onConnect);
      socket.on("connect_error", onConnectError);
      socket.on("room:joined", onJoined);
      socket.connect();
    });
  }

  private async fetchRoomMetadata() {
    const response = await fetch(`${this.roomServerUrl}/v1/rooms/${encodeURIComponent(this.roomId)}`);
    if (!response.ok) {
      throw new TabulaMcpError(`Room metadata request failed with HTTP ${response.status}.`);
    }
    return response.json() as Promise<unknown>;
  }

  private async loadWorkspaceRoomCheckpoint(): Promise<RoomRecoveryStatus> {
    if (!this.roomCheckpointStore.enabled) {
      this.roomCheckpointStatusValue = this.roomCheckpointStore.initialStatus();
      return "checkpoint-disabled";
    }

    try {
      const loaded = await this.roomCheckpointStore.loadEncryptedCheckpoint(this.roomId);
      if (!loaded) {
        this.roomCheckpointStatusValue = this.roomCheckpointStore.initialStatus();
        return "checkpoint-missing";
      }

      const checkpoint = await decryptWorkspaceRoomCheckpoint({
        encryptedCheckpoint: loaded.encryptedCheckpoint,
        roomId: this.roomId,
        roomKey: this.roomKeyValue,
      });
      await this.applyWorkspaceRoomCheckpoint(checkpoint);
      this.roomCheckpointStatusValue = loaded.status;
      return "checkpoint-loaded";
    } catch (error) {
      const initialStatus = this.roomCheckpointStore.initialStatus();
      this.roomCheckpointStatusValue = failedCheckpointStatus(initialStatus.store, error);
      this.lastErrorValue = this.roomCheckpointStatusValue.error ?? "Room checkpoint could not be loaded.";
      return "checkpoint-failed";
    }
  }

  private async saveWorkspaceRoomCheckpoint({
    workspace,
    documents,
  }: {
    workspace: WorkspaceRoomState;
    documents: readonly WorkspaceSnapshotDocument[];
  }) {
    if (!this.roomCheckpointStore.enabled) {
      this.roomCheckpointStatusValue = this.roomCheckpointStore.initialStatus();
      return this.roomCheckpointStatusValue;
    }

    try {
      const checkpoint = await createWorkspaceRoomCheckpoint({
        roomId: this.roomId,
        workspace,
        documents: this.createCheckpointDocuments(workspace, documents),
      });
      const encryptedCheckpoint = await encryptWorkspaceRoomCheckpoint({
        checkpoint,
        roomKey: this.roomKeyValue,
      });
      this.roomCheckpointStatusValue = await this.roomCheckpointStore.saveEncryptedCheckpoint(this.roomId, encryptedCheckpoint);
      return this.roomCheckpointStatusValue;
    } catch (error) {
      const initialStatus = this.roomCheckpointStore.initialStatus();
      this.roomCheckpointStatusValue = failedCheckpointStatus(initialStatus.store, error);
      this.lastErrorValue = this.roomCheckpointStatusValue.error ?? "Room checkpoint could not be saved.";
      return this.roomCheckpointStatusValue;
    }
  }

  private createCheckpointDocuments(
    workspace: WorkspaceRoomState,
    documents: readonly WorkspaceSnapshotDocument[],
  ): WorkspaceRoomCheckpointDocument[] {
    const documentsById = new Map(documents.map((document) => [document.documentId, document]));
    return workspace.nodes
      .filter((node): node is WorkspaceDocumentNode => node.type === "document")
      .map((node) => {
        const document = documentsById.get(node.id);
        if (!document) {
          throw new TabulaMcpError(`Workspace checkpoint is missing document ${node.id}.`);
        }

        return {
          id: node.id,
          title: document.title || node.title,
          markdown: document.markdown,
          parentId: document.parentId ?? node.parentId ?? null,
        };
      });
  }

  private async applyWorkspaceRoomCheckpoint(checkpoint: WorkspaceRoomCheckpoint) {
    this.workspaceStateValue = checkpoint.workspace;
    this.workspaceDocuments.clear();
    for (const workspaceDoc of this.workspaceYDocs.values()) {
      workspaceDoc.doc.destroy();
    }
    this.workspaceYDocs.clear();

    for (const document of checkpoint.documents) {
      const workspaceDoc = this.getWorkspaceYDoc(document.id);
      workspaceDoc.doc.transact(() => {
        workspaceDoc.text.delete(0, workspaceDoc.text.length);
        workspaceDoc.text.insert(0, document.markdown);
      }, REMOTE_ORIGIN);
      await this.cacheWorkspaceDocumentMarkdown(document.id, document.markdown);
    }

    const activeDocument = checkpoint.documents.find((document) => document.id === checkpoint.workspace.activeDocumentId);
    if (activeDocument) {
      this.doc.transact(() => {
        this.text.delete(0, this.text.length);
        this.text.insert(0, activeDocument.markdown);
      }, REMOTE_ORIGIN);
      this.hasReceivedLegacyTextState = true;
    }

    this.markReceivedState(checkpoint.updatedAt);
  }

  private async applyIncomingEnvelope(value: unknown) {
    if (!this.roomKey) {
      return;
    }

    try {
      const envelope = assertEncryptedEnvelope(value, this.roomId, "room-event");
      const plaintext = await decryptEnvelopeForRoom(this.roomKey, envelope);
      const event = decodeRoomEvent(plaintext);
      if (event) {
        await this.recordRoomEvent(event);
      }
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : "Incoming room message could not be processed.";
    }
  }

  private async encryptEnvelope(kind: EnvelopeKind, plaintext: Uint8Array) {
    if (!this.roomKey) {
      throw new TabulaMcpError("Room key is not available.");
    }

    this.envelopeVersion += 1;
    return encryptBytesForRoom(this.roomKey, this.roomId, kind, this.envelopeVersion, plaintext);
  }

  private async emitEnvelope(kind: EnvelopeKind, plaintext: Uint8Array, options: { suppressErrors?: boolean; volatile?: boolean } = {}) {
    if (!this.socket?.connected || this.statusValue === "closed") {
      return false;
    }

    const envelope = await this.encryptEnvelope(kind, plaintext);
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 3_000);
      this.socket?.emit(options.volatile ? "room:volatile-message" : "room:message", envelope, (ack: { ok?: boolean; error?: string }) => {
        clearTimeout(timeout);
        if (ack?.ok === false) {
          if (!options.suppressErrors) {
            this.lastErrorValue = ack.error || "Room message was rejected.";
          }
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  private async publishActorJoined() {
    await this.publishRoomEvent({
      id: createRoomEventId(),
      type: "actor.joined",
      roomId: this.roomId,
      actorId: this.actor.id,
      actor: this.actor,
      createdAt: new Date().toISOString(),
    });
  }

  private async publishPresence() {
    this.identity.lastSeen = Date.now();
    await this.publishRoomEvent(
      {
        id: createRoomEventId(),
        type: "presence.updated",
        roomId: this.roomId,
        actorId: this.actor.id,
        actor: this.actor,
        presence: {
          actorId: this.actor.id,
          activeDocumentId: this.workspaceStateValue?.activeDocumentId,
          selection: this.identity.selection,
          lastSeen: this.identity.lastSeen,
        },
        fileTitle: this.identity.fileTitle,
        selection: this.identity.selection,
        createdAt: new Date().toISOString(),
      },
      { volatile: true },
    );
  }

  private async emitCurrentState() {
    if (!this.workspaceStateValue) {
      return;
    }

    const documents = this.workspaceStateValue.nodes
      .filter((node): node is WorkspaceDocumentNode => node.type === "document")
      .flatMap((node) => {
        const cached = this.workspaceDocuments.get(node.id);
        return cached
          ? [
              {
                documentId: node.id,
                title: node.title,
                markdown: cached.markdown,
                parentId: node.parentId,
                sha256: cached.sha256,
              },
            ]
          : [];
      });
    await this.publishWorkspaceSnapshot({
      workspace: this.workspaceStateValue,
      documents,
    });
  }

  private async publishRoomEvent(event: RoomEvent, options: { suppressErrors?: boolean; volatile?: boolean } = {}) {
    return this.emitEnvelope("room-event", encodeRoomEvent(event), {
      volatile: options.volatile,
      suppressErrors: options.suppressErrors ?? true,
    });
  }

  private async recordRoomEvent(event: RoomEvent) {
    this.recentRoomEvents.push(event);
    if (this.recentRoomEvents.length > 50) {
      this.recentRoomEvents.splice(0, this.recentRoomEvents.length - 50);
    }

    if (event.type === "actor.joined" && event.actor.id !== this.actor.id) {
      const existing = this.collaborators.get(event.actor.id);
      this.collaborators.set(event.actor.id, {
        id: event.actor.id,
        name: event.actor.name,
        color: event.actor.color || existing?.color || "#64748b",
        lastSeen: Date.parse(event.createdAt) || Date.now(),
        fileTitle: existing?.fileTitle,
        selection: existing?.selection,
        actor: event.actor,
      });
    }
    if (event.type === "actor.left") {
      this.collaborators.delete(event.actorId);
    }
    if (event.type === "presence.updated" && event.actor?.id !== this.actor.id) {
      const actorId = event.actor?.id ?? event.presence?.actorId ?? event.actorId;
      const existing = this.collaborators.get(actorId);
      this.collaborators.set(actorId, {
        id: actorId,
        name: event.actor?.name || existing?.name || actorId,
        color: event.actor?.color || existing?.color || "#64748b",
        lastSeen: Date.parse(event.createdAt) || Date.now(),
        fileTitle: event.fileTitle ?? existing?.fileTitle,
        selection: isLiveSelection(event.selection ?? event.presence?.selection) ? event.selection ?? event.presence?.selection : existing?.selection,
        actor: event.actor ?? existing?.actor,
      });
    }
    if (event.type === "text.updated") {
      await this.applyTextUpdatedEvent(event);
    }
    if (event.type === "workspace.updated") {
      if (!hasRoomDocumentNodes(event.workspace)) {
        return;
      }
      this.workspaceStateValue = event.workspace;
      this.pruneWorkspaceDocumentCaches();
      await this.syncActiveWorkspaceDocument();
    }

    this.notifyRoomEvent(event);
  }

  private async normalizeWorkspaceChange(change: WorkspaceChange): Promise<WorkspaceChange> {
    if (!isWorkspaceChange(change)) {
      throw new TabulaMcpError("Workspace change does not match the Tabula.md workspace contract.");
    }

    if (change.type === "document.patch") {
      const document = this.requireWorkspaceDocumentNode(change.documentId);
      const cached = this.workspaceDocuments.get(document.id);
      if (!cached) {
        throw new TabulaMcpError(
          `Workspace document ${document.id} has not been read by this MCP session yet. Call tabula_read_workspace_document before proposing patches for it.`,
        );
      }

      const currentSha256 = await sha256Text(cached.markdown);
      if (change.baseSha256 !== currentSha256) {
        throw new TabulaMcpError(`Base hash for workspace document ${document.id} does not match the current cached text.`);
      }

      const patches = normalizeTextPatches(change.patches);
      const nextMarkdown = applyTextPatchesToString(cached.markdown, patches);
      if (nextMarkdown === null) {
        throw new TabulaMcpError(`Patches for workspace document ${document.id} are overlapping or outside the current Markdown text.`);
      }

      return {
        type: "document.patch",
        documentId: document.id,
        baseSha256: currentSha256,
        patches,
      };
    }

    if (change.type === "document.create") {
      this.assertWorkspaceParent(change.parentId);
      const title = change.title.trim();
      if (!title) {
        throw new TabulaMcpError("Workspace document.create requires a non-empty title.");
      }
      return {
        type: "document.create",
        parentId: change.parentId,
        title,
        markdown: change.markdown,
      };
    }

    if (change.type === "document.rename") {
      this.requireWorkspaceDocumentNode(change.documentId);
      const title = change.title.trim();
      if (!title) {
        throw new TabulaMcpError("Workspace document.rename requires a non-empty title.");
      }
      return {
        type: "document.rename",
        documentId: change.documentId,
        title,
      };
    }

    if (change.type === "document.move") {
      this.requireWorkspaceDocumentNode(change.documentId);
      this.assertWorkspaceParent(change.parentId);
      return {
        type: "document.move",
        documentId: change.documentId,
        parentId: change.parentId,
      };
    }

    this.requireWorkspaceDocumentNode(change.documentId);
    const cached = this.workspaceDocuments.get(change.documentId);
    if (change.baseSha256 && cached) {
      const currentSha256 = await sha256Text(cached.markdown);
      if (change.baseSha256 !== currentSha256) {
        throw new TabulaMcpError(`Base hash for workspace document ${change.documentId} does not match the current cached text.`);
      }
    }
    return {
      type: "document.delete",
      documentId: change.documentId,
      baseSha256: change.baseSha256,
    };
  }

  private assertCapability(capability: RoomCapability, action: string) {
    if (!this.actor.capabilities.includes(capability)) {
      throw new TabulaMcpError(`This Tabula MCP actor cannot ${action}; missing ${capability} capability.`);
    }
  }

  private async applyDocumentPatchChange(change: Extract<WorkspaceChange, { type: "document.patch" }>) {
    const document = this.requireWorkspaceDocumentNode(change.documentId);
    const cached = this.workspaceDocuments.get(document.id);
    if (!cached) {
      throw new TabulaMcpError(
        `Workspace document ${document.id} has not been read by this MCP session yet. Call tabula_read_workspace_document before applying patches for it.`,
      );
    }

    const currentSha256 = await sha256Text(cached.markdown);
    if (change.baseSha256 !== currentSha256) {
      throw new TabulaMcpError(`Base hash for workspace document ${document.id} does not match the current cached text.`);
    }

    const patches = normalizeTextPatches(change.patches);
    const nextMarkdown = applyTextPatchesToString(cached.markdown, patches);
    if (nextMarkdown === null) {
      throw new TabulaMcpError(`Patches for workspace document ${document.id} are overlapping or outside the current Markdown text.`);
    }
    if (nextMarkdown === cached.markdown) {
      return false;
    }

    const workspaceDoc = this.getWorkspaceYDoc(document.id);
    this.replaceYTextSilently(workspaceDoc, cached.markdown);
    const update = this.applyTextPatchesToWorkspaceYDoc(workspaceDoc, patches);
    const nextSha256 = await sha256Text(nextMarkdown);
    await this.cacheWorkspaceDocumentMarkdown(document.id, nextMarkdown, nextSha256);
    this.updateWorkspaceDocumentCacheMetadata(document.id, nextSha256, nextMarkdown.length);
    await this.publishTextUpdatedEvent({
      baseSha256: currentSha256,
      documentId: document.id,
      sha256: nextSha256,
      update,
    });
    return true;
  }

  private async applyDocumentCreateChange(change: Extract<WorkspaceChange, { type: "document.create" }>) {
    const now = new Date().toISOString();
    const documentId = `doc_${randomUUID()}`;
    const sha256 = await sha256Text(change.markdown);
    const documentNode: WorkspaceDocumentNode = {
      id: documentId,
      type: "document",
      parentId: change.parentId,
      title: change.title,
      sha256,
      textLength: change.markdown.length,
      order: this.nextWorkspaceNodeOrder(),
      createdAt: now,
      updatedAt: now,
    };

    await this.applyWorkspaceMetadataChange((workspace) => ({
      ...workspace,
      activeDocumentId: workspace.activeDocumentId ?? documentId,
      nodes: [...workspace.nodes, documentNode],
    }));
    await this.cacheWorkspaceDocumentMarkdown(documentId, change.markdown, sha256);
    const workspaceDoc = this.getWorkspaceYDoc(documentId);
    this.replaceYTextSilently(workspaceDoc, change.markdown);
    await this.publishTextUpdatedEvent({
      documentId,
      sha256,
      update: Y.encodeStateAsUpdate(workspaceDoc.doc),
    });
    return documentId;
  }

  private async applyDocumentDeleteChange(change: Extract<WorkspaceChange, { type: "document.delete" }>) {
    const cached = this.workspaceDocuments.get(change.documentId);
    if (change.baseSha256 && cached) {
      const currentSha256 = await sha256Text(cached.markdown);
      if (change.baseSha256 !== currentSha256) {
        throw new TabulaMcpError(`Base hash for workspace document ${change.documentId} does not match the current cached text.`);
      }
    }

    this.workspaceDocuments.delete(change.documentId);
    this.workspaceYDocs.get(change.documentId)?.doc.destroy();
    this.workspaceYDocs.delete(change.documentId);
    await this.applyWorkspaceMetadataChange((workspace) => {
      const nodes = workspace.nodes.filter((node) => node.id !== change.documentId && node.parentId !== change.documentId);
      const activeDocumentId =
        workspace.activeDocumentId === change.documentId
          ? nodes.find((node): node is WorkspaceDocumentNode => node.type === "document")?.id
          : workspace.activeDocumentId;
      return {
        ...workspace,
        activeDocumentId,
        nodes,
      };
    });
  }

  private async applyWorkspaceMetadataChange(
    updateWorkspace: (workspace: WorkspaceRoomState, now: string) => WorkspaceRoomState,
  ) {
    if (!this.workspaceStateValue) {
      throw new TabulaMcpError("Workspace state has not been received yet.");
    }

    const now = new Date().toISOString();
    this.workspaceStateValue = {
      ...updateWorkspace(this.workspaceStateValue, now),
      version: this.workspaceStateValue.version + 1,
    };
    await this.publishWorkspaceUpdatedEvent(this.workspaceStateValue);
  }

  private nextWorkspaceNodeOrder() {
    return Math.max(-1, ...(this.workspaceStateValue?.nodes.map((node) => node.order ?? 0) ?? [])) + 1;
  }

  private updateWorkspaceDocumentCacheMetadata(documentId: string, sha256: string, textLength: number) {
    if (!this.workspaceStateValue) {
      return;
    }
    const now = new Date().toISOString();
    this.workspaceStateValue = {
      ...this.workspaceStateValue,
      nodes: this.workspaceStateValue.nodes.map((node) =>
        node.id === documentId && node.type === "document"
          ? {
              ...node,
              sha256,
              textLength,
              updatedAt: now,
            }
          : node,
      ),
    };
  }

  private replaceYTextSilently(workspaceDoc: WorkspaceYDocState, markdown: string) {
    if (workspaceDoc.text.toString() === markdown) {
      return;
    }
    workspaceDoc.doc.transact(() => {
      workspaceDoc.text.delete(0, workspaceDoc.text.length);
      if (markdown) {
        workspaceDoc.text.insert(0, markdown);
      }
    }, REMOTE_ORIGIN);
  }

  private applyTextPatchesToWorkspaceYDoc(workspaceDoc: WorkspaceYDocState, patches: readonly TextPatch[]) {
    let update: Uint8Array | null = null;
    const onUpdate = (nextUpdate: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_DIRECT_ORIGIN) {
        update = nextUpdate;
      }
    };
    workspaceDoc.doc.on("update", onUpdate);
    try {
      workspaceDoc.doc.transact(() => {
        for (const patch of [...patches].sort((first, second) => second.from - first.from || second.to - first.to)) {
          if (patch.to > patch.from) {
            workspaceDoc.text.delete(patch.from, patch.to - patch.from);
          }
          if (patch.insert) {
            workspaceDoc.text.insert(patch.from, patch.insert);
          }
        }
      }, LOCAL_DIRECT_ORIGIN);
    } finally {
      workspaceDoc.doc.off("update", onUpdate);
    }

    if (!update) {
      throw new TabulaMcpError("Workspace text patch did not produce a Yjs update.");
    }
    return update;
  }

  private async publishWorkspaceUpdatedEvent(workspace: WorkspaceRoomState) {
    const event: RoomEvent = {
      id: createRoomEventId(),
      type: "workspace.updated",
      roomId: this.roomId,
      actorId: this.actor.id,
      actor: this.actor,
      workspace,
      createdAt: new Date().toISOString(),
    };
    const emitted = await this.publishRoomEvent(event, { suppressErrors: false });
    if (!emitted) {
      throw new TabulaMcpError(
        `Tabula room server did not acknowledge workspace.updated room-event envelopes${this.lastErrorValue ? `: ${this.lastErrorValue}` : "."} Deploy tabula-room with room-event support or pass a compatible roomServerUrl.`,
      );
    }
    await this.recordRoomEvent(event);
  }

  private async publishTextUpdatedEvent({
    baseSha256,
    documentId,
    sha256,
    update,
  }: {
    baseSha256?: string;
    documentId: string;
    sha256: string;
    update: Uint8Array;
  }) {
    const event: RoomEvent = {
      id: createRoomEventId(),
      type: "text.updated",
      roomId: this.roomId,
      actorId: this.actor.id,
      actor: this.actor,
      documentId,
      ...(baseSha256 ? { baseSha256 } : {}),
      sha256,
      update: encodeBase64Url(update),
      createdAt: new Date().toISOString(),
    };
    const emitted = await this.publishRoomEvent(event, { suppressErrors: false });
    if (!emitted) {
      throw new TabulaMcpError(
        `Tabula room server did not acknowledge text.updated room-event envelopes${this.lastErrorValue ? `: ${this.lastErrorValue}` : "."} Deploy tabula-room with room-event support or pass a compatible roomServerUrl.`,
      );
    }
    await this.recordRoomEvent(event);
  }

  private async applyTextUpdatedEvent(event: Extract<RoomEvent, { type: "text.updated" }>) {
    if (event.actorId === this.actor.id) {
      return;
    }

    try {
      const update = decodeBase64Url(event.update);
      if (event.documentId) {
        const workspaceDoc = this.getWorkspaceYDoc(event.documentId);
        Y.applyUpdate(workspaceDoc.doc, update, REMOTE_ORIGIN);
        this.markReceivedState();
        await this.cacheWorkspaceDocumentMarkdown(event.documentId, workspaceDoc.text.toString(), event.sha256);
        return;
      }

      const previousMarkdown = this.markdown;
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
      this.hasReceivedLegacyTextState = true;
      this.markReceivedState();
      await this.syncActiveWorkspaceDocument();
      if (this.markdown !== previousMarkdown) {
        this.notifyChange();
      }
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : "Room text update could not be applied.";
    }
  }

  private getWorkspaceYDoc(documentId: string) {
    const existing = this.workspaceYDocs.get(documentId);
    if (existing) {
      return existing;
    }

    const doc = new Y.Doc();
    const text = doc.getText("markdown");
    const state = { doc, text };
    this.workspaceYDocs.set(documentId, state);
    return state;
  }

  private async syncActiveWorkspaceDocument() {
    const activeDocumentId = this.workspaceStateValue?.activeDocumentId;
    if (!activeDocumentId || !this.hasReceivedLegacyTextState) {
      return;
    }
    await this.cacheWorkspaceDocumentMarkdown(activeDocumentId, this.markdown);
  }

  private async cacheWorkspaceDocumentMarkdown(documentId: string, markdown: string, sha256?: string) {
    const document = this.getWorkspaceDocumentNode(documentId);
    const computedSha256 = await sha256Text(markdown);
    if (sha256 && sha256 !== computedSha256) {
      this.lastErrorValue = `Workspace document ${documentId} text hash did not match the room event hash.`;
    }
    this.workspaceDocuments.set(documentId, {
      documentId,
      title: document?.title,
      markdown,
      textLength: markdown.length,
      sha256: computedSha256,
      updatedAt: new Date().toISOString(),
    });
  }

  private pruneWorkspaceDocumentCaches() {
    const documentIds = new Set(
      this.workspaceStateValue?.nodes
        .filter((node): node is WorkspaceDocumentNode => node.type === "document")
        .map((node) => node.id) ?? [],
    );
    for (const documentId of this.workspaceDocuments.keys()) {
      if (!documentIds.has(documentId)) {
        this.workspaceDocuments.delete(documentId);
      }
    }
    for (const [documentId, workspaceDoc] of this.workspaceYDocs) {
      if (!documentIds.has(documentId)) {
        workspaceDoc.doc.destroy();
        this.workspaceYDocs.delete(documentId);
      }
    }
  }

  private getWorkspaceDocumentNode(documentId: string): WorkspaceDocumentNode | null {
    const node = this.workspaceStateValue?.nodes.find((candidate) => candidate.id === documentId);
    return node?.type === "document" ? node : null;
  }

  private requireWorkspaceDocumentNode(documentId: string): WorkspaceDocumentNode {
    const document = this.getWorkspaceDocumentNode(documentId);
    if (!document) {
      throw new TabulaMcpError(`Workspace document ${documentId} was not found in the latest workspace state.`);
    }
    return document;
  }

  private getWorkspaceFolderNode(folderId: string): WorkspaceFolderNode | null {
    const node = this.workspaceStateValue?.nodes.find((candidate) => candidate.id === folderId);
    return node?.type === "folder" ? node : null;
  }

  private assertWorkspaceParent(parentId: string | null) {
    if (parentId === null) {
      return;
    }
    if (!this.getWorkspaceFolderNode(parentId)) {
      throw new TabulaMcpError(`Workspace parent folder ${parentId} was not found in the latest workspace state.`);
    }
  }

  private roomStateReadiness() {
    return {
      hydrationStatus: this.hydrationStatus,
      stateReceived: this.hasReceivedState,
      ...(this.lastStateReceivedAtValue ? { lastStateReceivedAt: this.lastStateReceivedAtValue } : {}),
    };
  }

  private markReceivedState(receivedAt = new Date().toISOString()) {
    this.hasReceivedState = true;
    this.lastStateReceivedAtValue = receivedAt;
  }

  private notifyChange() {
    if (this.waiters.size === 0) {
      return;
    }

    void sha256Text(this.markdown).then((sha256) => {
      for (const waiter of [...this.waiters]) {
        if (waiter.sinceSha256 && waiter.sinceSha256 === sha256) {
          continue;
        }
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve({
          changed: true,
          markdown: this.markdown,
          sha256,
          changedDocumentIds: this.activeChangedDocumentIds(),
          ...this.workspaceWaitSnapshot(),
          ...this.roomStateReadiness(),
        });
      }
    });
  }

  private notifyRoomEvent(event: RoomEvent) {
    if (this.waiters.size === 0) {
      return;
    }

    void sha256Text(this.markdown).then((sha256) => {
      for (const waiter of [...this.waiters]) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve({
          changed: Boolean(waiter.sinceSha256 && waiter.sinceSha256 !== sha256),
          markdown: this.markdown,
          sha256,
          changedDocumentIds: changedDocumentIdsFromRoomEvent(event),
          ...this.workspaceWaitSnapshot(),
          roomEvents: [event],
          ...this.roomStateReadiness(),
        });
      }
    });
  }

  private activeChangedDocumentIds() {
    return this.workspaceStateValue?.activeDocumentId ? [this.workspaceStateValue.activeDocumentId] : [];
  }

  private workspaceWaitSnapshot() {
    const workspace = this.workspaceStateValue;
    const documents =
      workspace?.nodes
        .filter((node): node is WorkspaceDocumentNode => node.type === "document")
        .map((node) => {
          const cached = this.workspaceDocuments.get(node.id);
          return {
            documentId: node.id,
            title: node.title,
            sha256: cached?.sha256 ?? node.sha256,
            textLength: cached?.textLength ?? node.textLength,
            cached: Boolean(cached),
          };
        }) ?? [];

    return {
      activeDocumentId: workspace?.activeDocumentId,
      workspace: workspace ?? null,
      documents,
      checkpointStatus: this.roomCheckpointStatusValue,
    };
  }
}

const isLiveSelection = (value: unknown): value is LiveSelection =>
  isRecord(value) &&
  (value.documentId === undefined || typeof value.documentId === "string") &&
  typeof value.from === "number" &&
  typeof value.to === "number" &&
  Number.isInteger(value.from) &&
  Number.isInteger(value.to) &&
  value.from >= 0 &&
  value.to >= value.from;

const changedDocumentIdsFromRoomEvent = (event: RoomEvent) => {
  if (event.type === "text.updated") {
    return [event.documentId];
  }
  if (event.type === "workspace.updated") {
    return event.workspace.nodes
      .filter((node): node is WorkspaceDocumentNode => node.type === "document")
      .map((node) => node.id);
  }
  return [];
};

const hasRoomDocumentNodes = (workspace: WorkspaceRoomState) =>
  workspace.nodes.some((node) => node.type === "document" && node.id !== `live-${workspace.roomId}`);
