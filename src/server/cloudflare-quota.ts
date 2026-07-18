import { isIP } from "node:net";
import { positiveIntegerFromEnv, type RuntimeEnvironment } from "../env.js";

type DurableObjectStorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
};

type DurableObjectStateLike = {
  storage: DurableObjectStorageLike;
};

type QuotaSession = { expiresAt: number; rooms: Record<string, { expiresAt: number }> };
type QuotaBucket = { count: number; resetAt: number };
type StoredQuotaState = {
  requestBucket?: QuotaBucket;
  mutationBucket?: QuotaBucket;
  exportBucket?: QuotaBucket;
  sessions: Record<string, QuotaSession>;
};

export type QuotaCheckInput = {
  sessionId: string;
  operation?: "request" | "mutation" | "export";
  units?: number;
};

export type QuotaDecision = {
  allowed: boolean;
  activeRooms: number;
  activeSessions: number;
  remaining: number;
  retryAfterSeconds?: number;
  reason?: "client_room_limit" | "client_session_limit" | "rate_limited" | "mutation_rate_limited" | "export_rate_limited";
};

const stateKey = "quota-v2";
const defaultMaxSessionsPerClient = 10;
const defaultMaxRoomsPerClient = 32;
const defaultRateLimitMax = 120;
const defaultMutationRateLimitMax = 60;
const defaultExportBytesLimit = 20 * 1024 * 1024;
const defaultRateLimitWindowMs = 60_000;
const defaultExportLimitWindowMs = 60 * 60_000;
const defaultSessionIdleTtlMs = 15 * 60_000;

const emptyState = (): StoredQuotaState => ({ sessions: {} });

const activeRoomCount = (state: StoredQuotaState) => Object.values(state.sessions)
  .reduce((total, session) => total + Object.keys(session.rooms ?? {}).length, 0);

const retryAfterSeconds = (resetAt: number, now: number) =>
  Math.max(1, Math.ceil((resetAt - now) / 1000));

const consumeBucket = ({
  bucket,
  limit,
  now,
  units,
  windowMs,
}: {
  bucket?: QuotaBucket;
  limit: number;
  now: number;
  units: number;
  windowMs: number;
}) => {
  const active = !bucket || bucket.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : bucket;
  if (active.count + units > limit) {
    return { allowed: false as const, bucket: active, remaining: Math.max(0, limit - active.count) };
  }
  active.count += units;
  return { allowed: true as const, bucket: active, remaining: Math.max(0, limit - active.count) };
};

export class TabulaMcpQuotaDurableObject {
  readonly #storage: DurableObjectStorageLike;
  readonly #env: RuntimeEnvironment;
  #queue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectStateLike, env: Record<string, unknown>) {
    this.#storage = state.storage;
    this.#env = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  fetch(request: Request): Promise<Response> {
    const task = this.#queue.then(() => this.#handle(request));
    this.#queue = task.then(() => undefined, () => undefined);
    return task;
  }

  alarm(): Promise<void> {
    const task = this.#queue.then(async () => {
      const state = await this.#loadAndPrune();
      await this.#storage.put(stateKey, state);
      await this.#scheduleAlarm(state);
    });
    this.#queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async #handle(request: Request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/rooms") return this.#handleRoomLease(request);
    if (request.method === "DELETE") {
      const { sessionId } = await request.json() as { sessionId?: string };
      const state = await this.#loadAndPrune();
      if (sessionId) delete state.sessions[sessionId];
      await this.#storage.put(stateKey, state);
      await this.#scheduleAlarm(state);
      return Response.json({ released: Boolean(sessionId) });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const input = await request.json() as Partial<QuotaCheckInput>;
    if (!input.sessionId) return new Response("Invalid quota request", { status: 400 });
    const now = Date.now();
    const state = await this.#loadAndPrune(now);
    const operation = input.operation ?? "request";
    const units = Number.isSafeInteger(input.units) && input.units! > 0 ? input.units! : 1;
    const rateLimitMax = positiveIntegerFromEnv(this.#env.TABULA_MCP_RATE_LIMIT_MAX, defaultRateLimitMax);
    const mutationRateLimitMax = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_MUTATION_RATE_LIMIT_MAX,
      defaultMutationRateLimitMax,
    );
    const exportBytesLimit = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_EXPORT_BYTES_LIMIT,
      defaultExportBytesLimit,
    );
    const rateLimitWindowMs = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_RATE_LIMIT_WINDOW_MS,
      defaultRateLimitWindowMs,
    );
    const exportLimitWindowMs = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_EXPORT_LIMIT_WINDOW_MS,
      defaultExportLimitWindowMs,
    );
    const sessionIdleTtlMs = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_SESSION_IDLE_TTL_MS,
      defaultSessionIdleTtlMs,
    );
    const maxSessionsPerClient = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_MAX_SESSIONS_PER_CLIENT,
      defaultMaxSessionsPerClient,
    );

    const requestResult = consumeBucket({
      bucket: state.requestBucket,
      limit: rateLimitMax,
      now,
      units: 1,
      windowMs: rateLimitWindowMs,
    });
    state.requestBucket = requestResult.bucket;
    if (!requestResult.allowed) {
      return this.#rejectAndPersist(state, {
        allowed: false,
        activeRooms: activeRoomCount(state),
        activeSessions: Object.keys(state.sessions).length,
        remaining: requestResult.remaining,
        reason: "rate_limited",
        retryAfterSeconds: retryAfterSeconds(requestResult.bucket.resetAt, now),
      });
    }

    if (operation === "mutation") {
      const result = consumeBucket({
        bucket: state.mutationBucket,
        limit: mutationRateLimitMax,
        now,
        units,
        windowMs: rateLimitWindowMs,
      });
      state.mutationBucket = result.bucket;
      if (!result.allowed) {
        return this.#rejectAndPersist(state, {
          allowed: false,
          activeRooms: activeRoomCount(state),
          activeSessions: Object.keys(state.sessions).length,
          remaining: result.remaining,
          reason: "mutation_rate_limited",
          retryAfterSeconds: retryAfterSeconds(result.bucket.resetAt, now),
        });
      }
    }

    if (operation === "export") {
      const result = consumeBucket({
        bucket: state.exportBucket,
        limit: exportBytesLimit,
        now,
        units,
        windowMs: exportLimitWindowMs,
      });
      state.exportBucket = result.bucket;
      if (!result.allowed) {
        return this.#rejectAndPersist(state, {
          allowed: false,
          activeRooms: activeRoomCount(state),
          activeSessions: Object.keys(state.sessions).length,
          remaining: result.remaining,
          reason: "export_rate_limited",
          retryAfterSeconds: retryAfterSeconds(result.bucket.resetAt, now),
        });
      }
    }

    const existing = state.sessions[input.sessionId];
    if (!existing && Object.keys(state.sessions).length >= maxSessionsPerClient) {
      return this.#rejectAndPersist(state, {
        allowed: false,
        activeRooms: activeRoomCount(state),
        activeSessions: Object.keys(state.sessions).length,
        remaining: requestResult.remaining,
        reason: "client_session_limit",
        retryAfterSeconds: Math.max(1, Math.ceil(sessionIdleTtlMs / 1000)),
      });
    }
    const rooms = state.sessions[input.sessionId]?.rooms ?? {};
    const expiresAt = now + sessionIdleTtlMs;
    for (const room of Object.values(rooms)) room.expiresAt = expiresAt;
    state.sessions[input.sessionId] = { expiresAt, rooms };
    await this.#storage.put(stateKey, state);
    await this.#scheduleAlarm(state);
    return Response.json({
      allowed: true,
      activeRooms: activeRoomCount(state),
      activeSessions: Object.keys(state.sessions).length,
      remaining: requestResult.remaining,
    } satisfies QuotaDecision);
  }

  async #handleRoomLease(request: Request) {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const input = await request.json() as { roomSessionId?: string; sessionId?: string };
    if (!input.sessionId || !input.roomSessionId) return new Response("Invalid Room lease request", { status: 400 });
    const now = Date.now();
    const state = await this.#loadAndPrune(now);
    const session = state.sessions[input.sessionId];
    if (!session) return new Response("MCP session lease not found", { status: 409 });

    if (request.method === "DELETE") {
      delete session.rooms[input.roomSessionId];
      await this.#storage.put(stateKey, state);
      await this.#scheduleAlarm(state);
      return Response.json({ released: true });
    }

    const maxRoomsPerClient = positiveIntegerFromEnv(
      this.#env.TABULA_MCP_MAX_ROOMS_PER_CLIENT,
      defaultMaxRoomsPerClient,
    );
    if (!session.rooms[input.roomSessionId] && activeRoomCount(state) >= maxRoomsPerClient) {
      return this.#rejectAndPersist(state, {
        allowed: false,
        activeRooms: activeRoomCount(state),
        activeSessions: Object.keys(state.sessions).length,
        remaining: 0,
        reason: "client_room_limit",
        retryAfterSeconds: Math.max(1, Math.ceil((session.expiresAt - now) / 1000)),
      });
    }
    session.rooms[input.roomSessionId] = { expiresAt: session.expiresAt };
    await this.#storage.put(stateKey, state);
    await this.#scheduleAlarm(state);
    return Response.json({
      allowed: true,
      activeRooms: activeRoomCount(state),
      activeSessions: Object.keys(state.sessions).length,
      remaining: Math.max(0, maxRoomsPerClient - activeRoomCount(state)),
    } satisfies QuotaDecision);
  }

  async #rejectAndPersist(state: StoredQuotaState, decision: QuotaDecision) {
    await this.#storage.put(stateKey, state);
    await this.#scheduleAlarm(state);
    return Response.json(decision);
  }

  async #loadAndPrune(now = Date.now()) {
    const state = await this.#storage.get<StoredQuotaState>(stateKey) ?? emptyState();
    if (state.requestBucket && state.requestBucket.resetAt <= now) delete state.requestBucket;
    if (state.mutationBucket && state.mutationBucket.resetAt <= now) delete state.mutationBucket;
    if (state.exportBucket && state.exportBucket.resetAt <= now) delete state.exportBucket;
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      session.rooms ??= {};
      if (session.expiresAt <= now) {
        delete state.sessions[sessionId];
        continue;
      }
      for (const [roomSessionId, room] of Object.entries(session.rooms)) {
        if (room.expiresAt <= now) delete session.rooms[roomSessionId];
      }
    }
    return state;
  }

  async #scheduleAlarm(state: StoredQuotaState) {
    const expiries = [
      state.requestBucket?.resetAt,
      state.mutationBucket?.resetAt,
      state.exportBucket?.resetAt,
      ...Object.values(state.sessions).map((session) => session.expiresAt),
      ...Object.values(state.sessions).flatMap((session) => Object.values(session.rooms ?? {}).map((room) => room.expiresAt)),
    ].filter((value): value is number => typeof value === "number");
    if (expiries.length === 0) {
      await this.#storage.deleteAlarm?.();
      return;
    }
    await this.#storage.setAlarm?.(Math.min(...expiries));
  }
}

const normalizedIpv4Prefix = (identity: string) => {
  const octets = identity.split(".");
  return `${octets.slice(0, 3).join(".")}.0/24`;
};

const normalizedIpv6Prefix = (identity: string) => {
  const [head, tail = ""] = identity.toLowerCase().split("::", 2);
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const omitted = Math.max(0, 8 - headParts.length - tailParts.length);
  const parts = [...headParts, ...Array.from({ length: omitted }, () => "0"), ...tailParts]
    .map((part) => (part || "0").padStart(4, "0"));
  return `${parts.slice(0, 4).join(":")}::/64`;
};

export const normalizeQuotaIdentity = (identity: string) => {
  const value = identity.trim();
  const version = isIP(value);
  if (version === 4) return normalizedIpv4Prefix(value);
  if (version === 6) return normalizedIpv6Prefix(value);
  return "unknown";
};

export const quotaClientKey = async (identity: string, secret: string) => {
  if (!secret.trim()) throw new Error("TABULA_MCP_QUOTA_HASH_SECRET is required.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizeQuotaIdentity(identity)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
