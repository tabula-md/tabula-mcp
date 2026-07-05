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
  type EnvelopeKind,
  type ParsedRoomShareUrl,
  TabulaMcpError,
} from "./protocol.js";
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
  readonly identity: Collaborator;

  private readonly roomKeyValue: string;
  private readonly doc = new Y.Doc();
  private readonly text: Y.Text;
  private readonly collaborators = new Map<string, Collaborator>();
  private readonly waiters = new Set<Waiter>();
  private socket: Socket | null = null;
  private roomKey: CryptoKey | null = null;
  private envelopeVersion = 0;
  private peerCount = 0;
  private statusValue: ConnectionStatus = "connecting";
  private lastErrorValue = "";
  private hasReceivedState = false;
  private lastStateReceivedAtValue = "";

  constructor({ parsedRoom, roomServerUrl, writeAccess, identityName, identityColor }: RoomClientOptions) {
    this.roomId = parsedRoom.roomId;
    this.shareUrl = parsedRoom.shareUrl;
    this.roomKeyValue = parsedRoom.roomKey;
    this.roomServerUrl = roomServerUrl;
    this.writeAccess = writeAccess;
    this.text = this.doc.getText("markdown");
    this.identity = {
      id: `tabula-mcp-${randomUUID()}`,
      name: identityName?.trim() || "Tabula MCP",
      color: identityColor?.trim() || "#2563eb",
      lastSeen: Date.now(),
      fileTitle: "Live Markdown",
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
      textLength: this.markdown.length,
      sha256: await sha256Text(this.markdown),
      socketConnected: Boolean(this.socket?.connected),
      ...this.roomStateReadiness(),
      peerCount: this.peerCount,
      collaborators: this.collaboratorList.map(({ id, name, color, fileTitle, selection, lastSeen }) => ({
        id,
        name,
        color,
        fileTitle,
        selection,
        lastSeen,
      })),
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

  async applyPatches({ patches, baseSha256 }: { patches: readonly TextPatch[]; baseSha256?: string }) {
    if (!this.writeAccess) {
      throw new TabulaMcpError("This session is read-only. Restart tabula-mcp with write mode enabled before editing.");
    }
    if (!this.hasReceivedState) {
      throw new TabulaMcpError("Room state has not been received yet. Wait for a live peer to send state-init/yjs-update before editing.");
    }

    const previousMarkdown = this.markdown;
    const previousSha256 = await sha256Text(previousMarkdown);
    if (baseSha256 && baseSha256 !== previousSha256) {
      throw new TabulaMcpError("Base hash does not match the current room text. Read again before applying patches.");
    }

    const normalizedPatches = normalizeTextPatches(patches);
    const nextMarkdown = applyTextPatchesToString(previousMarkdown, normalizedPatches);
    if (nextMarkdown === null) {
      throw new TabulaMcpError("Patches are overlapping or outside the current Markdown text.");
    }
    if (nextMarkdown === previousMarkdown) {
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        changed: false,
        textLength: previousMarkdown.length,
        previousSha256,
        sha256: previousSha256,
      };
    }

    const descendingPatches = [...normalizedPatches].sort((first, second) => second.from - first.from || second.to - first.to);
    this.doc.transact(() => {
      for (const patch of descendingPatches) {
        if (patch.to > patch.from) {
          this.text.delete(patch.from, patch.to - patch.from);
        }
        if (patch.insert) {
          this.text.insert(patch.from, patch.insert);
        }
      }
    }, "local");

    const sha256 = await sha256Text(this.markdown);
    return {
      sessionId: this.sessionId,
      roomId: this.roomId,
      changed: true,
      textLength: this.markdown.length,
      previousSha256,
      sha256,
    };
  }

  async setPresence(selection?: LiveSelection, fileTitle?: string) {
    if (selection) {
      this.identity.selection = {
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

  private async emitEnvelope(kind: EnvelopeKind, plaintext: Uint8Array, options: { volatile?: boolean } = {}) {
    if (!this.socket?.connected || this.statusValue === "closed") {
      return false;
    }

    const envelope = await this.encryptEnvelope(kind, plaintext);
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 3_000);
      this.socket?.emit(options.volatile ? "room:volatile-message" : "room:message", envelope, (ack: { ok?: boolean; error?: string }) => {
        clearTimeout(timeout);
        if (ack?.ok === false) {
          this.lastErrorValue = ack.error || "Room message was rejected.";
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  private async publishPresence() {
    this.identity.lastSeen = Date.now();
    const payload = textEncoder.encode(JSON.stringify({ ...this.identity, roomId: this.roomId }));
    await this.emitEnvelope("presence", payload, { volatile: true });
  }

  private async emitCurrentState() {
    await this.emitEnvelope("state-init", Y.encodeStateAsUpdate(this.doc));
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
}
