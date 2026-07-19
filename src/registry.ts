import { createHash, randomBytes } from "node:crypto";
import { TabulaCoreError } from "./core-errors.js";
import { TabulaRoomClient } from "./room-client.js";
import { DEFAULT_SESSION_IDLE_TTL_MS } from "./session-timeouts.js";

type ConnectedSession = {
  client: TabulaRoomClient;
  lastUsedAt: number;
};

type SessionRegistryTimer = ReturnType<typeof setTimeout>;

const expiredHandleRetentionMs = 60 * 60 * 1000;

export type SessionRegistryLifecycle = {
  reserve?: (sessionId: string) => Promise<void>;
  release?: (sessionId: string) => Promise<void>;
};

export class SessionRegistry {
  private readonly sessions = new Map<string, ConnectedSession>();
  private readonly reservations = new Set<string>();
  private readonly roomJoins = new Map<string, Promise<{ client: TabulaRoomClient; created: boolean }>>();
  private readonly roomJoinNamespace = randomBytes(32).toString("hex");
  private readonly expiredSessions = new Map<string, number>();
  private idleTimer: SessionRegistryTimer | undefined;

  constructor({
    lifecycle = {},
    idleTtlMs = DEFAULT_SESSION_IDLE_TTL_MS,
    maxSessions = 8,
    now = Date.now,
  }: {
    lifecycle?: SessionRegistryLifecycle;
    idleTtlMs?: number;
    maxSessions?: number;
    now?: () => number;
  } = {}) {
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs <= 0) {
      throw new TypeError("SessionRegistry idleTtlMs must be a positive integer.");
    }
    this.lifecycle = lifecycle;
    this.idleTtlMs = idleTtlMs;
    this.maxSessions = maxSessions;
    this.now = now;
  }

  private readonly idleTtlMs: number;
  private readonly lifecycle: SessionRegistryLifecycle;
  private readonly maxSessions: number;
  private readonly now: () => number;

  async reserve(sessionId: string) {
    await this.pruneIdle();
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
    this.expiredSessions.delete(session.sessionId);
    this.sessions.set(session.sessionId, { client: session, lastUsedAt: this.now() });
    this.scheduleIdleSweep();
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
      if (this.isExpiredHandle(sessionId)) {
        throw new TabulaCoreError("session_expired", "The Tabula session expired after being idle.", {
          details: { sessionId, idleTimeoutSeconds: this.idleTimeoutSeconds },
          retry: "Join the room again using its private #room URL.",
        });
      }
      throw new TabulaCoreError("session_not_found", "The Tabula session is not connected.", {
        details: { sessionId },
        retry: "Join the room again and use the returned sessionId.",
      });
    }
    if (this.now() - session.lastUsedAt >= this.idleTtlMs) {
      void this.expire(sessionId, session);
      throw new TabulaCoreError("session_expired", "The Tabula session expired after being idle.", {
        details: { sessionId, idleTimeoutSeconds: this.idleTimeoutSeconds },
        retry: "Join the room again using its private #room URL.",
      });
    }
    session.lastUsedAt = this.now();
    this.scheduleIdleSweep();
    return session.client;
  }

  list() {
    return [...this.sessions.values()].map(({ client }) => client);
  }

  findByShareUrl(shareUrl: string) {
    const entry = [...this.sessions.values()].find(({ client }) => client.shareUrl === shareUrl);
    if (!entry) return undefined;
    if (this.now() - entry.lastUsedAt >= this.idleTtlMs) {
      void this.expire(entry.client.sessionId, entry);
      return undefined;
    }
    entry.lastUsedAt = this.now();
    this.scheduleIdleSweep();
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
    this.sessions.delete(sessionId);
    this.expiredSessions.delete(sessionId);
    this.scheduleIdleSweep();
    await Promise.allSettled([
      session.client.close(),
      this.lifecycle.release?.(sessionId),
    ]);
    return true;
  }

  async clear() {
    const sessionIds = [...this.sessions.keys(), ...this.reservations];
    const clients = [...this.sessions.values()].map(({ client }) => client);
    this.sessions.clear();
    this.reservations.clear();
    this.roomJoins.clear();
    this.expiredSessions.clear();
    this.clearIdleTimer();
    await Promise.allSettled([
      ...clients.map((client) => client.close()),
      ...sessionIds.map((sessionId) => this.lifecycle.release?.(sessionId)),
    ]);
  }

  async pruneIdle() {
    const now = this.now();
    this.pruneExpiredHandles(now);
    const expired = [...this.sessions.entries()].filter(([, session]) =>
      now - session.lastUsedAt >= this.idleTtlMs
    );
    await Promise.allSettled(expired.map(([sessionId, session]) => this.expire(sessionId, session, now)));
    this.scheduleIdleSweep();
  }

  get size() {
    return this.sessions.size;
  }

  get idleTimeoutSeconds() {
    return Math.ceil(this.idleTtlMs / 1000);
  }

  private async expire(sessionId: string, expected: ConnectedSession, now = this.now()) {
    if (this.sessions.get(sessionId) !== expected) return;
    this.sessions.delete(sessionId);
    this.expiredSessions.set(sessionId, now);
    this.scheduleIdleSweep();
    await Promise.allSettled([
      expected.client.close(),
      this.lifecycle.release?.(sessionId),
    ]);
  }

  private isExpiredHandle(sessionId: string) {
    this.pruneExpiredHandles(this.now());
    return this.expiredSessions.has(sessionId);
  }

  private pruneExpiredHandles(now: number) {
    for (const [sessionId, expiredAt] of this.expiredSessions) {
      if (now - expiredAt >= expiredHandleRetentionMs) this.expiredSessions.delete(sessionId);
    }
  }

  private clearIdleTimer() {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleSweep() {
    this.clearIdleTimer();
    if (this.sessions.size === 0) return;
    const now = this.now();
    const nextExpiry = Math.min(
      ...[...this.sessions.values()].map((session) => session.lastUsedAt + this.idleTtlMs),
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.pruneIdle();
    }, Math.max(0, nextExpiry - now));
    (this.idleTimer as SessionRegistryTimer & { unref?: () => void }).unref?.();
  }
}
