import { timingSafeEqual } from "node:crypto";
import { TabulaMcpError } from "../protocol.js";
import { isTruthyEnvValue, positiveIntegerFromEnv, resolveProductionMode, type RuntimeEnvironment } from "../env.js";
import type { DeploymentMode } from "../deployment.js";
import { DEFAULT_SESSION_IDLE_TTL_MS } from "../session-timeouts.js";
import { operationCommitForSignal } from "./operation-context.js";

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
  publicUnauthenticated: boolean;
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
  readonly committed: boolean;
  readonly retryable: boolean;
  readonly operationKind?: string;

  constructor(commit: { committed: boolean; kind?: string } = { committed: false }) {
    super(commit.committed
      ? "Request timed out after the operation committed. Retry the same request to recover its result."
      : "Request timed out before the operation committed. It is safe to retry.");
    this.name = "RequestTimeoutError";
    this.committed = commit.committed;
    // A pre-commit retry starts cleanly. A post-commit retry must use the same
    // request so the operation ledger can return the original result.
    this.retryable = true;
    this.operationKind = commit.kind;
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
  deploymentMode: DeploymentMode;
  env: RuntimeEnvironment;
  options?: OperationalPolicyOptions;
}): OperationalPolicy => {
  const production = resolveProductionMode({ env, production: options.production });
  const publicUnauthenticated =
    deploymentMode === "remote" && production && isTruthyEnvValue(env.TABULA_MCP_PUBLIC_UNAUTHENTICATED);
  const authToken = publicUnauthenticated
    ? null
    : options.authToken === undefined
      ? secretFromEnv(env)
      : options.authToken?.trim() || null;
  const forceStatelessHttp = isTruthyEnvValue(env.TABULA_MCP_STATELESS_HTTP);
  const forceStatefulHttp = isTruthyEnvValue(env.TABULA_MCP_STATEFUL_HTTP);

  if (forceStatelessHttp && forceStatefulHttp) {
    throw new TabulaMcpError("Set only one of TABULA_MCP_STATELESS_HTTP or TABULA_MCP_STATEFUL_HTTP.");
  }

  const statelessHttp =
    options.statelessHttp ??
    (forceStatefulHttp
      ? false
      : forceStatelessHttp);

  if (statelessHttp && deploymentMode === "remote") {
    throw new TabulaMcpError("Remote room tools require stateful MCP HTTP sessions.");
  }

  if (production && !authToken && !publicUnauthenticated) {
    throw new TabulaMcpError("Production Tabula MCP HTTP requires TABULA_MCP_AUTH_TOKEN.");
  }

  return {
    allowRemoteRoomConnections: true,
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
      positiveIntegerFromEnv(env.TABULA_MCP_SESSION_IDLE_TTL_MS, DEFAULT_SESSION_IDLE_TTL_MS),
    statelessHttp,
    publicUnauthenticated,
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

export const withTimeout = async <T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const pending = typeof operation === "function" ? operation(controller.signal) : operation;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new RequestTimeoutError(operationCommitForSignal(controller.signal));
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
};

export const timeoutErrorData = (error: RequestTimeoutError) => ({
  code: "operation_timed_out",
  committed: error.committed,
  retryable: error.retryable,
  retrySameRequest: error.committed,
  ...(error.operationKind ? { operationKind: error.operationKind } : {}),
});

export const shouldCleanupTimedOutSession = (error: RequestTimeoutError) =>
  !error.committed && error.operationKind !== "export_copy";

export const errorMessageForClient = (error: unknown, production: boolean) => {
  if (error instanceof RequestTooLargeError || error instanceof RequestTimeoutError || error instanceof SyntaxError) {
    return error.message;
  }

  return production ? "Internal server error." : error instanceof Error ? error.message : "Internal server error.";
};

const sensitiveLogKeyPattern = /(authorization|bearer|token|secret|roomkey|snapshotkey|roomurl|shareurl)/i;

export const redactOperationalText = (value: string) => value
  .replace(/Bearer\s+[-._~+/=A-Za-z0-9]+/gi, "Bearer [redacted]")
  .replace(/#(room|json)=[^\s"'<>]+/gi, "#$1=[redacted]")
  .replace(/%23(room|json)%3D[^\s"'<>]+/gi, "%23$1%3D[redacted]");

export const sanitizeOperationalLogEntry = (entry: OperationalLogEntry): OperationalLogEntry =>
  Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      sensitiveLogKeyPattern.test(key)
        ? "[redacted]"
        : typeof value === "string"
          ? redactOperationalText(value).slice(0, 500)
          : value,
    ]),
  );

export const errorMessageForLog = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return redactOperationalText(message).slice(0, 500);
};

export const logOperationalError = (
  policy: OperationalPolicy,
  event: string,
  entry: OperationalLogEntry = {},
) => {
  if (allowedLevels[policy.logLevel] < allowedLevels.error) {
    return;
  }

  console.error(JSON.stringify({ event, ...sanitizeOperationalLogEntry(entry) }));
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
