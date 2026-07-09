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
  type EnvelopeKind,
  type ParsedRoomShareUrl,
  TabulaMcpError,
} from "./protocol.js";
import {
  createAgentActor,
  createRoomEventId,
  createWorkspaceProposalId,
  decodeRoomEvent,
  encodeRoomEvent,
  isRoomActor,
  isWorkspaceChange,
  type RoomPresenceSelection,
  type RoomActor,
  type RoomEvent,
  type WorkspaceChange,
  type WorkspaceDocumentNode,
  type WorkspaceFolderNode,
  type WorkspaceNode,
  type WorkspaceProposal,
  type WorkspaceRoomState,
} from "./room-events.js";
import {
  applyTextPatchesToString,
  getMarkdownOutline,
  normalizeTextPatches,
  type TextPatch,
} from "./text.js";

export type ConnectionStatus = "connecting" | "connected" | "offline" | "closed";
export type RoomRecoveryStatus = "relay-only";
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
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

const decodePresence = (bytes: Uint8Array): Collaborator | null => {
  try {
    const decoded = JSON.parse(textDecoder.decode(bytes)) as Partial<Collaborator>;
    if (!decoded.id || !decoded.name || !decoded.color) {
      return null;
    }

    return {
      id: decoded.id,
      name: decoded.name,
      color: decoded.color,
      lastSeen: typeof decoded.lastSeen === "number" ? decoded.lastSeen : Date.now(),
      fileTitle: decoded.fileTitle,
      selection: decoded.selection,
      actor: isRoomActor(decoded.actor) ? decoded.actor : undefined,
    };
  } catch {
    return null;
  }
};

export class TabulaRoomClient {
  readonly sessionId = randomUUID();
  readonly roomId: string;
  readonly roomServerUrl: string;
  readonly shareUrl: string;
  readonly writeAccess: boolean;
  readonly actor: RoomActor;
  readonly identity: Collaborator;

  private readonly roomKeyValue: string;
  private readonly doc = new Y.Doc();
  private readonly text: Y.Text;
  private readonly collaborators = new Map<string, Collaborator>();
  private readonly pendingWorkspaceProposals = new Map<string, WorkspaceProposal>();
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
  private lastStateReceivedAtValue = "";

  constructor({ parsedRoom, roomServerUrl, writeAccess, identityName, identityColor }: RoomClientOptions) {
    const actorId = `tabula-mcp-${randomUUID()}`;
    const actorColor = identityColor?.trim() || "#2563eb";
    const actorName = identityName?.trim() || "Tabula Agent";

    this.roomId = parsedRoom.roomId;
    this.shareUrl = parsedRoom.shareUrl;
    this.roomKeyValue = parsedRoom.roomKey;
    this.roomServerUrl = roomServerUrl;
    this.writeAccess = writeAccess;
    this.text = this.doc.getText("markdown");
    this.actor = createAgentActor({
      id: actorId,
      name: actorName,
      color: actorColor,
      writeAccess,
    });
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
      if (!this.writeAccess) {
        return;
      }

      void this.emitEnvelope("yjs-update", update);
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
    await this.connectSocket();
    this.statusValue = "connected";
    await this.publishActorJoined();
    await this.publishPresence();

    if (this.writeAccess) {
      await this.emitEnvelope("yjs-update", Y.encodeStateAsUpdate(this.doc));
    }

    return "relay-only" satisfies RoomRecoveryStatus;
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
      pendingProposalCount: this.pendingWorkspaceProposals.size,
      pendingWorkspaceProposalCount: this.pendingWorkspaceProposals.size,
      workspaceMode: Boolean(this.workspaceStateValue),
      activeDocumentId: this.workspaceStateValue?.activeDocumentId,
      workspaceVersion: this.workspaceStateValue?.version,
      lastRoomEventAt: this.recentRoomEvents.at(-1)?.createdAt,
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
      pendingWorkspaceProposalCount: this.pendingWorkspaceProposals.size,
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

  async proposeWorkspaceChanges({
    title,
    description,
    changes,
  }: {
    title?: string;
    description?: string;
    changes: readonly WorkspaceChange[];
  }) {
    if (!this.workspaceStateValue) {
      throw new TabulaMcpError(
        "Workspace state has not been received yet. Wait for a Tabula.md workspace peer to publish workspace.updated before proposing workspace changes.",
      );
    }
    if (!changes.length) {
      throw new TabulaMcpError("At least one workspace change is required.");
    }

    const normalizedChanges = await Promise.all(changes.map((change) => this.normalizeWorkspaceChange(change)));
    const createdAt = new Date().toISOString();
    const proposal: WorkspaceProposal = {
      id: createWorkspaceProposalId(),
      roomId: this.roomId,
      actorId: this.actor.id,
      actor: this.actor,
      title: title?.trim() || undefined,
      description: description?.trim() || undefined,
      createdAt,
      status: "pending",
      changes: normalizedChanges,
    };
    const event: RoomEvent = {
      id: createRoomEventId(),
      type: "workspace.proposal.created",
      roomId: this.roomId,
      actorId: this.actor.id,
      proposal,
      createdAt,
    };
    const emitted = await this.publishRoomEvent(event);
    if (emitted) {
      this.recordRoomEvent(event);
    }

    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      emitted,
      proposal,
      note: emitted
        ? undefined
        : "The workspace proposal was prepared locally but was not acknowledged by the room relay. Check the room connection and server support for room-event envelopes.",
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

  private async applyIncomingEnvelope(value: unknown) {
    if (!this.roomKey) {
      return;
    }

    try {
      const envelope = assertEncryptedEnvelope(value, this.roomId);
      const plaintext = await decryptEnvelopeForRoom(this.roomKey, envelope);
      if (envelope.kind === "yjs-update" || envelope.kind === "state-init") {
        const previousMarkdown = this.markdown;
        Y.applyUpdate(this.doc, plaintext, REMOTE_ORIGIN);
        this.markReceivedState();
        await this.syncActiveWorkspaceDocument();
        if (this.markdown !== previousMarkdown) {
          this.notifyChange();
        }
        return;
      }

      if (envelope.kind === "presence") {
        const collaborator = decodePresence(plaintext);
        if (collaborator && collaborator.id !== this.identity.id) {
          this.collaborators.set(collaborator.id, collaborator);
        }
        return;
      }

      if (envelope.kind === "room-event") {
        const event = decodeRoomEvent(plaintext);
        if (event) {
          this.recordRoomEvent(event);
        }
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
    const payload = textEncoder.encode(JSON.stringify({ ...this.identity, roomId: this.roomId }));
    await this.emitEnvelope("presence", payload, { volatile: true });
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
    await this.emitEnvelope("state-init", Y.encodeStateAsUpdate(this.doc));
  }

  private async publishRoomEvent(event: RoomEvent, options: { volatile?: boolean } = {}) {
    return this.emitEnvelope("room-event", encodeRoomEvent(event), {
      volatile: options.volatile,
      suppressErrors: true,
    });
  }

  private recordRoomEvent(event: RoomEvent) {
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
      void this.applyTextUpdatedEvent(event);
    }
    if (event.type === "workspace.updated") {
      this.workspaceStateValue = event.workspace;
      this.pruneWorkspaceDocumentCaches();
      void this.syncActiveWorkspaceDocument();
    }
    if (
      event.type === "document.created" ||
      event.type === "document.deleted" ||
      event.type === "document.renamed" ||
      event.type === "document.moved" ||
      event.type === "document.updated"
    ) {
      this.applyWorkspaceMetadataEvent(event);
    }
    if (event.type === "workspace.proposal.created") {
      this.pendingWorkspaceProposals.set(event.proposal.id, event.proposal);
    }
    if (event.type === "workspace.proposal.accepted" || event.type === "workspace.proposal.rejected") {
      this.pendingWorkspaceProposals.delete(event.proposalId);
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
      this.markReceivedState();
      await this.syncActiveWorkspaceDocument();
      if (this.markdown !== previousMarkdown) {
        this.notifyChange();
      }
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : "Room text update could not be applied.";
    }
  }

  private applyWorkspaceMetadataEvent(
    event: Extract<
      RoomEvent,
      { type: "document.created" | "document.deleted" | "document.renamed" | "document.moved" | "document.updated" }
    >,
  ) {
    if (!this.workspaceStateValue) {
      return;
    }

    const nodes = [...this.workspaceStateValue.nodes];
    if (event.type === "document.created") {
      const index = nodes.findIndex((node) => node.id === event.document.id);
      if (index >= 0) {
        nodes[index] = event.document;
      } else {
        nodes.push(event.document);
      }
      this.workspaceStateValue = {
        ...this.workspaceStateValue,
        nodes,
      };
      return;
    }
    if (event.type === "document.deleted") {
      this.workspaceDocuments.delete(event.documentId);
      this.workspaceYDocs.get(event.documentId)?.doc.destroy();
      this.workspaceYDocs.delete(event.documentId);
      this.workspaceStateValue = {
        ...this.workspaceStateValue,
        nodes: nodes.filter((node) => node.id !== event.documentId && node.parentId !== event.documentId),
      };
      return;
    }
    if (event.type === "document.renamed") {
      this.workspaceStateValue = {
        ...this.workspaceStateValue,
        nodes: nodes.map((node) =>
          node.id === event.documentId ? { ...node, title: event.title, updatedAt: event.createdAt } : node,
        ),
      };
      return;
    }
    if (event.type === "document.moved") {
      this.workspaceStateValue = {
        ...this.workspaceStateValue,
        nodes: nodes.map((node) =>
          node.id === event.documentId ? { ...node, parentId: event.parentId, updatedAt: event.createdAt } : node,
        ),
      };
      return;
    }
    if (event.type === "document.updated") {
      this.workspaceStateValue = {
        ...this.workspaceStateValue,
        nodes: nodes.map((node) =>
          node.id === event.documentId && node.type === "document"
            ? {
                ...node,
                sha256: event.sha256,
                textLength: this.workspaceDocuments.get(event.documentId)?.textLength ?? node.textLength,
                updatedAt: event.createdAt,
              }
            : node,
        ),
      };
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
    if (!activeDocumentId || !this.hasReceivedState) {
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

  private markReceivedState() {
    this.hasReceivedState = true;
    this.lastStateReceivedAtValue = new Date().toISOString();
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
          roomEvents: [event],
          ...this.roomStateReadiness(),
        });
      }
    });
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
