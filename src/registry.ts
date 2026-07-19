import { createHash, randomBytes } from "node:crypto";
import { TabulaCoreError } from "./core-errors.js";
import { TabulaRoomClient } from "./room-client.js";

type ConnectedSession = {
  client: TabulaRoomClient;
  lastUsedAt: number;
};

export type SessionRegistryLifecycle = {
  reserve?: (sessionId: string) => Promise<void>;
  release?: (sessionId: string) => Promise<void>;
};

export class SessionRegistry {
  private readonly sessions = new Map<string, ConnectedSession>();
  private readonly reservations = new Set<string>();
  private readonly roomJoins = new Map<string, Promise<{ client: TabulaRoomClient; created: boolean }>>();
  private readonly roomJoinNamespace = randomBytes(32).toString("hex");

  constructor({
    lifecycle = {},
    maxSessions = 8,
    now = Date.now,
  }: {
    lifecycle?: SessionRegistryLifecycle;
    maxSessions?: number;
    now?: () => number;
  } = {}) {
    this.lifecycle = lifecycle;
    this.maxSessions = maxSessions;
    this.now = now;
  }

  private readonly lifecycle: SessionRegistryLifecycle;
  private readonly maxSessions: number;
  private readonly now: () => number;

  async reserve(sessionId: string) {
    this.assertCanAdd(sessionId);
    if (this.sessions.has(sessionId) || this.reservations.has(sessionId)) return;
    this.reservations.add(sessionId);
    try {
      await this.lifecycle.reserve?.(sessionId);
    } catch (error) {
      this.reservations.delete(sessionId);
      throw error;
    }
  }

  async cancelReservation(sessionId: string) {
    if (!this.reservations.delete(sessionId)) return;
    await this.lifecycle.release?.(sessionId);
  }

  add(session: TabulaRoomClient) {
    this.assertCanAdd(session.sessionId);
    this.reservations.delete(session.sessionId);
    this.sessions.set(session.sessionId, { client: session, lastUsedAt: this.now() });
  }

  assertCanAdd(sessionId: string) {
    const activeCount = this.sessions.size + this.reservations.size;
    if (!this.sessions.has(sessionId) && !this.reservations.has(sessionId) && activeCount >= this.maxSessions) {
      throw new TabulaCoreError("session_limit", "This Tabula MCP connection already has the maximum number of live sessions.", {
        details: { limit: this.maxSessions },
        retry: "Leave an inactive Tabula session before joining another room.",
      });
    }
  }

  get(sessionId: string): TabulaRoomClient {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new TabulaCoreError("session_not_found", "The Tabula session is not connected.", {
        details: { sessionId },
        retry: "Join the room again and use the returned sessionId.",
      });
    }
    session.lastUsedAt = this.now();
    return session.client;
  }

  list() {
    return [...this.sessions.values()].map(({ client }) => client);
  }

  findByShareUrl(shareUrl: string) {
    const entry = [...this.sessions.values()].find(({ client }) => client.shareUrl === shareUrl);
    if (!entry) return undefined;
    entry.lastUsedAt = this.now();
    return entry.client;
  }

  /**
   * Returns the existing client for a Room or lets exactly one caller create
   * it. The private Room URL is salted and hashed before it becomes a map key.
   */
  async ensureRoom(
    shareUrl: string,
    connect: () => Promise<TabulaRoomClient>,
  ): Promise<{ client: TabulaRoomClient; reused: boolean }> {
    const existing = this.findByShareUrl(shareUrl);
    if (existing) return { client: existing, reused: true };

    const key = createHash("sha256")
      .update(this.roomJoinNamespace)
      .update("\0")
      .update(shareUrl)
      .digest("hex");
    const pending = this.roomJoins.get(key);
    if (pending) {
      const result = await pending;
      return { client: result.client, reused: true };
    }

    const operation = (async () => {
      const racedExisting = this.findByShareUrl(shareUrl);
      if (racedExisting) return { client: racedExisting, created: false };
      return { client: await connect(), created: true };
    })();
    this.roomJoins.set(key, operation);
    try {
      const result = await operation;
      return { client: result.client, reused: !result.created };
    } finally {
      if (this.roomJoins.get(key) === operation) this.roomJoins.delete(key);
    }
  }

  has() {
    return this.sessions.size > 0;
  }

  async leave(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.client.disconnect();
    this.sessions.delete(sessionId);
    await this.lifecycle.release?.(sessionId);
    return true;
  }

  async clear() {
    const sessionIds = [...this.sessions.keys(), ...this.reservations];
    for (const { client } of this.sessions.values()) {
      client.disconnect();
    }
    this.sessions.clear();
    this.reservations.clear();
    this.roomJoins.clear();
    await Promise.allSettled(sessionIds.map((sessionId) => this.lifecycle.release?.(sessionId)));
  }

  get size() {
    return this.sessions.size;
  }
}
