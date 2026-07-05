import { timingSafeEqual } from "node:crypto";
import { TabulaMcpError } from "../protocol.js";
import { isTruthyEnvValue, positiveIntegerFromEnv, resolveProductionMode, type RuntimeEnvironment } from "../env.js";
import type { DocumentStoreDeploymentMode } from "../documents/store.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

export type OperationalPolicyOptions = {
  authToken?: string | null;
  maxActiveSessions?: number;
  maxRequestBytes?: number;
  production?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  requestTimeoutMs?: number;
  sessionIdleTtlMs?: number;
  statelessHttp?: boolean;
};

export type OperationalPolicy = {
  allowRemoteRoomConnections: boolean;
  authToken: string | null;
  logLevel: LogLevel;
  maxActiveSessions: number;
  maxRequestBytes: number;
  production: boolean;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  requestTimeoutMs: number;
  sessionIdleTtlMs: number;
  statelessHttp: boolean;
};

export type RequestLogEntry = {
  durationMs: number;
  method: string;
  path: string;
  sessionPresent?: boolean;
  status: number;
};

export type OperationalLogEntry = Record<string, boolean | number | string | null | undefined>;

const defaultMaxRequestBytes = 6 * 1024 * 1024;
const defaultMaxActiveSessions = 100;
const defaultSessionIdleTtlMs = 15 * 60 * 1000;
const defaultRequestTimeoutMs = 55 * 1000;
const defaultRateLimitMax = 120;
const defaultRateLimitWindowMs = 60 * 1000;
const logLevels: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];
const allowedLevels: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export class RequestTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super("Request timed out.");
  }
}

export class FixedWindowRateLimiter {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor({ maxRequests, windowMs }: { maxRequests: number; windowMs: number }) {
    this.#maxRequests = maxRequests;
    this.#windowMs = windowMs;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    this.#prune(now);
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + this.#windowMs;
      this.#buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.#maxRequests - 1, resetAt };
    }

    if (bucket.count >= this.#maxRequests) {
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.#maxRequests - bucket.count, resetAt: bucket.resetAt };
  }

  #prune(now: number) {
    for (const [key, bucket] of this.#buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.#buckets.delete(key);
      }
    }
  }
}

const parseLogLevel = (value: string | undefined, fallback: LogLevel): LogLevel => {
  const normalized = value?.trim().toLowerCase();
  return logLevels.includes(normalized as LogLevel) ? (normalized as LogLevel) : fallback;
};

const secretFromEnv = (env: RuntimeEnvironment) => env.TABULA_MCP_AUTH_TOKEN?.trim() || null;

export const resolveOperationalPolicy = ({
  deploymentMode,
  env,
  options = {},
}: {
  deploymentMode: DocumentStoreDeploymentMode;
  env: RuntimeEnvironment;
  options?: OperationalPolicyOptions;
}): OperationalPolicy => {
  const production = resolveProductionMode({ env, production: options.production });
  const authToken = options.authToken === undefined ? secretFromEnv(env) : options.authToken?.trim() || null;
  const allowRemoteRoomConnections =
    deploymentMode === "local" || !production || isTruthyEnvValue(env.TABULA_MCP_ALLOW_REMOTE_ROOM);
  const forceStatelessHttp = isTruthyEnvValue(env.TABULA_MCP_STATELESS_HTTP);
  const forceStatefulHttp = isTruthyEnvValue(env.TABULA_MCP_STATEFUL_HTTP);

  if (forceStatelessHttp && forceStatefulHttp) {
    throw new TabulaMcpError("Set only one of TABULA_MCP_STATELESS_HTTP or TABULA_MCP_STATEFUL_HTTP.");
  }

  const statelessHttp =
    options.statelessHttp ??
    (forceStatefulHttp
      ? false
      : forceStatelessHttp || (deploymentMode === "remote" && production && !allowRemoteRoomConnections));

  if (statelessHttp && allowRemoteRoomConnections && deploymentMode === "remote") {
    throw new TabulaMcpError("Remote room tools require stateful MCP HTTP sessions.");
  }

  if (production && !authToken) {
    throw new TabulaMcpError("Production Tabula MCP HTTP requires TABULA_MCP_AUTH_TOKEN.");
  }

  return {
    allowRemoteRoomConnections,
    authToken,
    logLevel: parseLogLevel(env.TABULA_MCP_LOG_LEVEL, production ? "info" : "silent"),
    maxActiveSessions:
      options.maxActiveSessions ??
      positiveIntegerFromEnv(env.TABULA_MCP_MAX_ACTIVE_SESSIONS, defaultMaxActiveSessions),
    maxRequestBytes:
      options.maxRequestBytes ??
      positiveIntegerFromEnv(env.TABULA_MCP_HTTP_MAX_REQUEST_BYTES, defaultMaxRequestBytes),
    production,
    rateLimitMax:
      options.rateLimitMax ?? positiveIntegerFromEnv(env.TABULA_MCP_RATE_LIMIT_MAX, defaultRateLimitMax),
    rateLimitWindowMs:
      options.rateLimitWindowMs ??
      positiveIntegerFromEnv(env.TABULA_MCP_RATE_LIMIT_WINDOW_MS, defaultRateLimitWindowMs),
    requestTimeoutMs:
      options.requestTimeoutMs ??
      positiveIntegerFromEnv(env.TABULA_MCP_REQUEST_TIMEOUT_MS, defaultRequestTimeoutMs),
    sessionIdleTtlMs:
      options.sessionIdleTtlMs ??
      positiveIntegerFromEnv(env.TABULA_MCP_SESSION_IDLE_TTL_MS, defaultSessionIdleTtlMs),
    statelessHttp,
  };
};

export const authorizeBearerToken = (authorizationHeader: string | null | undefined, expectedToken: string | null) => {
  if (!expectedToken) {
    return true;
  }

  const [scheme, token] = authorizationHeader?.split(/\s+/, 2) ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return false;
  }

  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(token);
  if (expected.byteLength !== actual.byteLength) {
    return false;
  }

  return timingSafeEqual(actual, expected);
};

export const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const errorMessageForClient = (error: unknown, production: boolean) => {
  if (error instanceof RequestTooLargeError || error instanceof RequestTimeoutError || error instanceof SyntaxError) {
    return error.message;
  }

  return production ? "Internal server error." : error instanceof Error ? error.message : "Internal server error.";
};

export const errorMessageForLog = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[-._~+/=A-Za-z0-9]+/gi, "Bearer [redacted]").slice(0, 500);
};

export const logOperationalError = (
  policy: OperationalPolicy,
  event: string,
  entry: OperationalLogEntry = {},
) => {
  if (allowedLevels[policy.logLevel] < allowedLevels.error) {
    return;
  }

  console.error(JSON.stringify({ event, ...entry }));
};

export const logRequest = (policy: OperationalPolicy, entry: RequestLogEntry) => {
  if (policy.logLevel === "silent") {
    return;
  }

  const level = entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info";
  if (allowedLevels[policy.logLevel] < allowedLevels[level]) {
    return;
  }

  const payload = {
    event: "tabula_mcp_request",
    ...entry,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
};
