import { randomUUID } from "node:crypto";
import {
  WORKSPACE_ROOM_ROOT_ID,
  WORKSPACE_ROOM_SCHEMA_VERSION,
  createRoomActor,
  type EncryptedEnvelope,
  type RoomActor,
  type RoomCapability,
  type WorkspaceRoomComment,
  type WorkspaceRoomCommentReply,
  type WorkspaceRoomCheckpointStore,
  type WorkspaceRoomNode,
  type WorkspaceRoomSnapshot,
} from "@tabula-md/tabula/collaboration";
import {
  createHeadlessRoomClient,
  createHeadlessRoomSyncAdapters,
  type HeadlessRoomChange,
  type HeadlessRoomClientState,
  type WorkspaceRoomSyncAdapters,
  type WorkspaceRoomTransportHandlers,
} from "@tabula-md/tabula/room-client";
import { io } from "socket.io-client";
import { sha256Text } from "./crypto.js";
import {
  type ParsedRoomShareUrl,
  TabulaMcpError,
  WorkspaceConflictError,
} from "./protocol.js";
import { createFirebaseWorkspaceRoomCheckpointStore } from "./room-checkpoints.js";
import { markOperationCommitted } from "./server/operation-context.js";
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

type CoreRoomClient = Awaited<ReturnType<typeof createHeadlessRoomClient>>;

export type ConnectionStatus = "connecting" | "connected" | "offline" | "closed";
export type RoomRecoveryStatus =
  | "local-bootstrap"
  | "checkpoint-loaded"
  | "checkpoint-missing"
  | "checkpoint-disabled"
  | "checkpoint-failed";
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
  identityId?: string;
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

const createSocketTransport: WorkspaceRoomSyncAdapters["createRoomTransport"] = ({
  baseUrl,
  roomId,
  clientId,
  handlers,
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
    connect: () => socket.connect(),
    sendEnvelope: (envelope: EncryptedEnvelope) => socket.emit("room:message", envelope),
    sendVolatileEnvelope: (envelope: EncryptedEnvelope) => socket.volatile.emit("room:volatile-message", envelope),
    disconnect: () => socket.disconnect(),
  };
};

const toLegacyStatus = (status: HeadlessRoomClientState["status"]): ConnectionStatus => {
  if (status === "connected") return "connected";
  if (status === "closed") return "closed";
  if (status === "offline" || status === "failed") return "offline";
  return "connecting";
};

export class TabulaRoomClient {
  readonly sessionId = randomUUID();
  readonly roomId: string;
  readonly roomServerUrl: string;
  readonly shareUrl: string;
  readonly writeAccess: boolean;
  readonly actor: RoomActor;

  private readonly checkpointStore: WorkspaceRoomCheckpointStore;
  private readonly adapters: WorkspaceRoomSyncAdapters;
  private clientPromise: Promise<CoreRoomClient> | null = null;
  private client: CoreRoomClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private activeDocumentId: string | undefined;
  private connected = false;
  private closed = false;
  private lastStateReceivedAtValue = "";
  private initialWorkspacePublished = false;
  private readonly waiters = new Set<Waiter>();
  private checkpointRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointRetryAttempt = 0;
  private checkpointPendingValue = false;

  constructor({
    parsedRoom,
    roomServerUrl,
    writeAccess,
    identityId,
    identityName,
    identityColor,
    actorCapabilities,
    roomCheckpointStore = createFirebaseWorkspaceRoomCheckpointStore(),
    createRoomTransport = createSocketTransport,
  }: RoomClientOptions) {
    this.roomId = parsedRoom.roomId;
    this.shareUrl = parsedRoom.shareUrl;
    this.roomServerUrl = roomServerUrl;
    this.checkpointStore = roomCheckpointStore;
    const capabilities = actorCapabilities?.filter((capability) =>
      capability === "presence" || capability === "read" || capability === "write"
    ) ?? (writeAccess ? ["presence", "read", "write"] : ["presence", "read"]);
    this.actor = createRoomActor({
      id: identityId?.trim() || `tabula-mcp-${randomUUID()}`,
      kind: "agent",
      client: "tabula-mcp",
      name: identityName,
      color: identityColor,
      capabilities,
      joinedAt: new Date().toISOString(),
    });
    this.writeAccess = this.actor.capabilities.includes("write");
    this.adapters = createHeadlessRoomSyncAdapters({ createRoomTransport });
  }

  get status(): ConnectionStatus {
    if (this.closed) return "closed";
    return this.client ? toLegacyStatus(this.client.getState().status) : "connecting";
  }

  get lastError() {
    return this.client?.getState().lastError ?? "";
  }

  get markdown() {
    const snapshot = this.safeSnapshot();
    const documentId = this.activeDocumentId ?? snapshot?.nodes.find((node) => node.type === "document")?.id;
    return documentId ? snapshot?.documents[documentId] ?? "" : "";
  }

  get collaboratorList(): Collaborator[] {
    return (this.client?.getState().collaborators ?? []).map((collaborator) => ({
      id: collaborator.actor.id,
      name: collaborator.actor.name,
      color: collaborator.actor.color ?? "#2563eb",
      lastSeen: collaborator.lastSeen,
      activeDocumentId: collaborator.activeDocumentId,
      fileTitle: collaborator.fileTitle,
      selection: collaborator.selection,
      actor: collaborator.actor,
    }));
  }

  get hydrationStatus(): RoomHydrationStatus {
    return this.client?.getState().hydrationStatus === "ready" ? "ready" : "waiting-for-peer-state";
  }

  get recoveryMode(): "durable" | "temporary" {
    return this.checkpointStore.enabled ? "durable" : "temporary";
  }

  async connect({
    waitForStateMs = 0,
    waitForPresenceMs = 0,
  }: {
    waitForStateMs?: number;
    waitForPresenceMs?: number;
  } = {}) {
    const client = await this.ensureClient();
    const localBootstrap = this.initialWorkspacePublished;
    await client.connect({ waitForStateMs, waitForPresenceMs });
    this.connected = true;
    if (client.getState().hydrationStatus === "ready") this.markReceivedState();
    return localBootstrap ? "local-bootstrap" : this.recoveryStatus();
  }

  async getStatus() {
    const client = await this.ensureClient();
    const state = client.getState();
    const workspace = state.hydrationStatus === "ready" ? await this.projectWorkspaceState() : null;
    const activeDocumentTitle = this.activeDocumentId
      ? workspace?.nodes.find((node) => node.id === this.activeDocumentId)?.title
      : undefined;
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      shareUrl: this.shareUrl,
      roomServerUrl: this.roomServerUrl,
      status: toLegacyStatus(state.status),
      writeAccess: this.writeAccess,
      actor: this.actor,
      capabilities: this.actor.capabilities,
      textLength: this.markdown.length,
      sha256: await sha256Text(this.markdown),
      socketConnected: state.status === "connected",
      ...this.roomStateReadiness(),
      presenceStatus: state.presenceStatus,
      connectedPeerCount: state.connectedPeerCount,
      peerCount: state.connectedPeerCount,
      collaborators: this.collaboratorList,
      workspaceMode: true,
      activeDocumentId: this.activeDocumentId,
      activeDocumentTitle,
      workspaceVersion: state.version,
      recoveryMode: this.recoveryMode,
      checkpointStatus: this.checkpointStatus(),
      metadata: null,
      lastError: state.lastError,
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
    const snapshot = this.requireClient().getWorkspaceSnapshot();
    return {
      sessionId: this.sessionId,
      workspace: await this.projectWorkspaceState(snapshot),
      documents: snapshot.documents,
      commentsByFileId: snapshot.commentsByFileId,
      activeDocumentId: this.activeDocumentId,
    };
  }

  async readWorkspaceDocument({ documentId }: { documentId: string }) {
    this.assertHydrated("read workspace documents");
    const document = await this.requireClient().readDocument(documentId);
    this.activeDocumentId = documentId;
    this.requireClient().setPresence({ activeDocumentId: documentId, fileTitle: document.title });
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      documentId,
      title: document.title,
      markdown: document.markdown,
      textLength: document.markdown.length,
      sha256: document.revision,
      cachedAt: new Date().toISOString(),
      ...this.roomStateReadiness(),
    };
  }

  async publishWorkspaceSnapshot({
    workspace,
    documents,
    persistCheckpoint = true,
  }: {
    workspace: WorkspaceRoomState;
    documents: readonly WorkspaceSnapshotDocument[];
    persistCheckpoint?: boolean;
  }) {
    this.assertWritable("publish workspace state");
    if (workspace.roomId !== this.roomId) {
      throw new TabulaMcpError("Workspace roomId must match the connected room.");
    }
    if (this.clientPromise) {
      throw new TabulaMcpError("Workspace state must be published before the Room client is opened.");
    }
    const documentsById = new Map(documents.map((document) => [document.documentId, document]));
    const nodes: WorkspaceRoomNode[] = workspace.nodes
      .filter((node) => node.id !== workspace.rootId)
      .map((node) => ({
        ...node,
        parentId: !node.parentId || node.parentId === workspace.rootId
          ? WORKSPACE_ROOM_ROOT_ID
          : node.parentId,
      }));
    for (const node of nodes) {
      if (node.type === "document" && !documentsById.has(node.id)) {
        throw new TabulaMcpError(`Workspace checkpoint is missing document ${node.id}.`);
      }
    }
    const initialWorkspace: WorkspaceRoomSnapshot = {
      roomId: this.roomId,
      schemaVersion: WORKSPACE_ROOM_SCHEMA_VERSION,
      rootId: WORKSPACE_ROOM_ROOT_ID,
      nodes: [
        {
          id: WORKSPACE_ROOM_ROOT_ID,
          type: "folder",
          parentId: null,
          title: "Workspace",
          order: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        ...nodes,
      ],
      documents: Object.fromEntries(nodes.filter((node) => node.type === "document").map((node) => [
        node.id,
        documentsById.get(node.id)?.markdown ?? "",
      ])),
      commentsByFileId: {},
    };
    this.activeDocumentId = workspace.activeDocumentId ?? documents[0]?.documentId;
    this.initialWorkspacePublished = true;
    const client = await this.ensureClient(initialWorkspace);
    if (this.activeDocumentId) client.setPresence({ activeDocumentId: this.activeDocumentId });
    if (persistCheckpoint && this.checkpointStore.enabled) await client.flushCheckpoint();
    return {
      emittedWorkspace: true,
      emittedDocumentCount: documents.length,
      checkpointStatus: this.checkpointStatus(),
    };
  }

  async applyWorkspaceChanges({ changes }: { changes: readonly WorkspaceChange[] }) {
    this.assertWritable("edit workspace documents");
    this.assertHydrated("edit workspace documents");
    if (changes.length === 0) throw new TabulaMcpError("At least one workspace change is required.");
    const client = this.requireClient();
    const snapshot = client.getWorkspaceSnapshot();
    const documents = new Map(Object.entries(snapshot.documents));
    const coreChanges: HeadlessRoomChange[] = [];
    const appliedChanges: WorkspaceChange[] = [];
    const changedDocumentIds = new Set<string>();

    for (const input of changes) {
      if (input.type === "folder.create") {
        coreChanges.push({
          type: "folder.create",
          folderId: input.folderId,
          parentId: input.parentId,
          title: input.title,
        });
        appliedChanges.push(input);
        continue;
      }
      if (input.type === "document.patch") {
        const markdown = documents.get(input.documentId);
        if (markdown === undefined) throw new TabulaMcpError(`Workspace document ${input.documentId} was not found.`);
        if (await sha256Text(markdown) !== input.baseSha256) {
          throw new WorkspaceConflictError();
        }
        const patches = normalizeTextPatches(input.patches);
        const next = applyTextPatchesToString(markdown, patches);
        if (next === null) throw new TabulaMcpError("Workspace document patches are invalid or overlap.");
        documents.set(input.documentId, next);
        coreChanges.push({
          type: "document.write",
          documentId: input.documentId,
          markdown: next,
          expectedRevision: input.baseSha256,
          preferredPatches: patches,
        });
        changedDocumentIds.add(input.documentId);
        appliedChanges.push({ ...input, patches });
        continue;
      }
      if (input.type === "document.create") {
        const documentId = randomUUID();
        documents.set(documentId, input.markdown);
        coreChanges.push({
          type: "document.create",
          documentId,
          parentId: input.parentId,
          title: input.title,
          markdown: input.markdown,
        });
        changedDocumentIds.add(documentId);
        appliedChanges.push(input);
        continue;
      }
      if (input.type === "node.move") {
        coreChanges.push({
          type: "node.update",
          nodeId: input.nodeId,
          title: input.title,
          parentId: input.parentId,
          expected: {
            title: input.baseTitle,
            parentId: input.baseParentId,
            revision: input.baseSha256,
          },
        });
        if (documents.has(input.nodeId)) changedDocumentIds.add(input.nodeId);
        appliedChanges.push(input);
        continue;
      }
      coreChanges.push({
        type: "node.delete",
        nodeId: input.nodeId,
        expected: {
          title: input.baseTitle,
          parentId: input.baseParentId,
          revision: input.baseSha256,
        },
      });
      if (documents.has(input.nodeId)) changedDocumentIds.add(input.nodeId);
      appliedChanges.push(input);
    }

    try {
      await client.applyChanges(coreChanges);
    } catch (error) {
      const latest = client.getWorkspaceSnapshot();
      const nodes = new Map(latest.nodes.map((node) => [node.id, node]));
      let conflict = false;
      for (const input of changes) {
        if (input.type === "document.patch") {
          const markdown = latest.documents[input.documentId];
          if (markdown === undefined || await sha256Text(markdown) !== input.baseSha256) conflict = true;
          continue;
        }
        if (input.type !== "node.move" && input.type !== "node.delete") continue;
        const node = nodes.get(input.nodeId);
        if (!node || node.title !== input.baseTitle || node.parentId !== input.baseParentId) {
          conflict = true;
          continue;
        }
        if (input.baseSha256 !== undefined) {
          const markdown = latest.documents[input.nodeId];
          if (markdown === undefined || await sha256Text(markdown) !== input.baseSha256) conflict = true;
        }
      }
      if (conflict) throw new WorkspaceConflictError();
      throw error;
    }
    markOperationCommitted("workspace_change");
    try {
      if (this.activeDocumentId && !client.getWorkspaceSnapshot().documents[this.activeDocumentId]) {
        this.activeDocumentId = this.firstDocumentId();
      }
      client.setPresence({ activeDocumentId: this.activeDocumentId });
    } catch {
      // Presence and response projection are post-commit conveniences. Once
      // applyChanges succeeds, callers must never receive a mutation failure.
    }
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      applied: true,
      changes: appliedChanges,
      changedDocumentIds: [...changedDocumentIds],
    };
  }

  async upsertComment(comment: WorkspaceRoomComment) {
    this.assertWritable("write comments");
    this.assertHydrated("write comments");
    await this.requireClient().upsertComment(comment);
    markOperationCommitted("comment_upsert");
  }

  async addCommentReply(commentId: string, reply: WorkspaceRoomCommentReply) {
    this.assertWritable("reply to comments");
    this.assertHydrated("reply to comments");
    await this.requireClient().addCommentReply(commentId, reply);
    markOperationCommitted("comment_reply");
  }

  async setCommentResolved(commentId: string, resolved: boolean) {
    this.assertWritable("resolve comments");
    this.assertHydrated("resolve comments");
    await this.requireClient().setCommentResolved(commentId, resolved);
    markOperationCommitted("comment_resolve");
  }

  async deleteComment(commentId: string) {
    this.assertWritable("delete comments");
    this.assertHydrated("delete comments");
    await this.requireClient().deleteComment(commentId);
    markOperationCommitted("comment_delete");
  }

  async flushCheckpoint() {
    await this.requireClient().flushCheckpoint();
    if (this.checkpointStore.enabled && this.requireClient().getState().checkpointStatus !== "saved") {
      throw new TabulaMcpError(this.lastError || "The encrypted live room could not be saved.");
    }
  }

  async persistCheckpointAfterMutation(): Promise<"disabled" | "pending" | "saved"> {
    if (!this.checkpointStore.enabled) return "disabled";
    try {
      await this.flushCheckpoint();
      this.checkpointRetryAttempt = 0;
      this.checkpointPendingValue = false;
      return "saved";
    } catch {
      this.checkpointPendingValue = true;
      this.scheduleCheckpointRetry();
      return "pending";
    }
  }

  checkpointPersistenceStatus(): "disabled" | "pending" | "saved" {
    if (!this.checkpointStore.enabled) return "disabled";
    return this.checkpointPendingValue ? "pending" : "saved";
  }

  scheduleCheckpointRetry() {
    if (!this.checkpointStore.enabled || this.closed || this.checkpointRetryTimer) return;
    const delays = [1_000, 5_000, 15_000, 60_000] as const;
    const delay = delays[Math.min(this.checkpointRetryAttempt, delays.length - 1)] ?? 60_000;
    this.checkpointRetryTimer = setTimeout(() => {
      this.checkpointRetryTimer = null;
      void this.flushCheckpoint().then(() => {
        this.checkpointRetryAttempt = 0;
        this.checkpointPendingValue = false;
      }).catch(() => {
        this.checkpointPendingValue = true;
        this.checkpointRetryAttempt += 1;
        this.scheduleCheckpointRetry();
      });
    }, delay);
    this.checkpointRetryTimer.unref?.();
  }

  async setPresence(selection?: LiveSelection, fileTitle?: string) {
    if (selection?.documentId) this.activeDocumentId = selection.documentId;
    this.requireClient().setPresence({
      activeDocumentId: this.activeDocumentId,
      fileTitle,
      selection: selection?.documentId ? {
        documentId: selection.documentId,
        from: selection.from,
        to: selection.to,
      } : undefined,
    });
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
    if (sinceSha256 && sinceSha256 !== currentSha256) return this.createWaitResult(true, currentSha256);
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
    if (this.closed) return;
    this.closed = true;
    if (this.checkpointRetryTimer) clearTimeout(this.checkpointRetryTimer);
    this.checkpointRetryTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    if (this.client) void this.client.disconnect();
  }

  private async ensureClient(initialWorkspace?: WorkspaceRoomSnapshot) {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = createHeadlessRoomClient({
      roomUrl: this.shareUrl,
      roomServerUrl: this.roomServerUrl,
      actor: this.actor,
      adapters: this.adapters,
      checkpointStore: this.checkpointStore,
      initialWorkspace,
    }).then((client) => {
      this.client = client;
      this.unsubscribe = client.subscribe((state) => {
        if (state.hydrationStatus === "ready") this.markReceivedState();
        this.notifyChange();
      });
      return client;
    });
    return this.clientPromise;
  }

  private requireClient() {
    if (!this.client) throw new TabulaMcpError("The Tabula Room client is not open.");
    return this.client;
  }

  private safeSnapshot() {
    try {
      return this.client?.getWorkspaceSnapshot() ?? null;
    } catch {
      return null;
    }
  }

  private firstDocumentId() {
    return this.safeSnapshot()?.nodes.find((node) => node.type === "document")?.id;
  }

  private async projectWorkspaceState(snapshot = this.requireClient().getWorkspaceSnapshot()): Promise<WorkspaceRoomState> {
    const nodes = await Promise.all(snapshot.nodes.map(async (node) => {
      if (node.type === "folder") return { ...node, type: "folder" as const };
      const markdown = snapshot.documents[node.id] ?? "";
      return {
        ...node,
        type: "document" as const,
        sha256: await sha256Text(markdown),
        textLength: markdown.length,
      };
    }));
    return {
      roomId: this.roomId,
      mode: "workspace",
      version: this.requireClient().getState().version,
      rootId: snapshot.rootId,
      nodes,
      activeDocumentId: this.activeDocumentId,
    };
  }

  private assertWritable(action: string) {
    if (!this.writeAccess) throw new TabulaMcpError(`Write access is required to ${action}.`);
  }

  private assertHydrated(action: string) {
    if (this.hydrationStatus !== "ready") {
      throw new TabulaMcpError(
        `Room is connected but waiting for workspace state. Wait for a live peer or encrypted checkpoint before attempting to ${action}.`,
      );
    }
  }

  private roomStateReadiness() {
    const stateReceived = this.hydrationStatus === "ready";
    return {
      hydrationStatus: this.hydrationStatus,
      stateReceived,
      lastStateReceivedAt: stateReceived ? this.lastStateReceivedAtValue || undefined : undefined,
    };
  }

  private markReceivedState() {
    if (!this.lastStateReceivedAtValue) this.lastStateReceivedAtValue = new Date().toISOString();
  }

  private checkpointStatus(): RoomCheckpointStoreStatus {
    const status = this.client?.getState().checkpointStatus ?? (this.checkpointStore.enabled ? "missing" : "disabled");
    return {
      enabled: this.checkpointStore.enabled,
      store: this.checkpointStore.enabled ? "firebase-storage" : "none",
      status,
      ...(status === "saved" || status === "loaded" ? { updatedAt: new Date().toISOString() } : {}),
      ...(status === "failed" && this.lastError ? { error: this.lastError } : {}),
    };
  }

  private recoveryStatus(): RoomRecoveryStatus {
    const status = this.requireClient().getState().checkpointStatus;
    if (status === "loaded") return "checkpoint-loaded";
    if (status === "disabled") return "checkpoint-disabled";
    if (status === "failed") return "checkpoint-failed";
    return "checkpoint-missing";
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
      checkpointStatus: this.checkpointStatus(),
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
