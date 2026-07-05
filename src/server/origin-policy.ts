import { isTruthyEnvValue, type RuntimeEnvironment } from "../env.js";
import { TabulaMcpError } from "../protocol.js";

export type OriginPolicy = {
  allowAnyBrowserOrigin: boolean;
  allowedOrigins: readonly string[];
};

export type OriginPolicyOptions = {
  allowedOrigins?: string[] | null;
  env?: RuntimeEnvironment;
  production: boolean;
};

const splitOrigins = (value: string | undefined) =>
  value
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

const normalizeConfiguredOrigin = (origin: string) => {
  if (origin === "*") {
    return origin;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.origin === "null") {
      throw new Error("opaque origins are not allowed");
    }
    return parsed.origin;
  } catch {
    throw new TabulaMcpError(`Invalid TABULA_MCP_ALLOWED_ORIGINS entry: ${origin}`);
  }
};

const normalizeOrigins = (origins: readonly string[]) => [...new Set(origins.map(normalizeConfiguredOrigin))];

export const resolveOriginPolicy = ({
  allowedOrigins,
  env = {},
  production,
}: OriginPolicyOptions): OriginPolicy => {
  const allowAnyOrigin = isTruthyEnvValue(env.TABULA_MCP_ALLOW_ANY_ORIGIN);

  if (allowedOrigins !== undefined) {
    if (allowedOrigins === null) {
      if (production && !allowAnyOrigin) {
        throw new TabulaMcpError(
          "Production Tabula MCP does not allow wildcard browser origins unless TABULA_MCP_ALLOW_ANY_ORIGIN=1.",
        );
      }
      return { allowAnyBrowserOrigin: true, allowedOrigins: [] };
    }

    const normalized = normalizeOrigins(allowedOrigins);
    if (normalized.includes("*")) {
      if (production && !allowAnyOrigin) {
        throw new TabulaMcpError(
          "Production Tabula MCP does not allow TABULA_MCP_ALLOWED_ORIGINS=* unless TABULA_MCP_ALLOW_ANY_ORIGIN=1.",
        );
      }
      return { allowAnyBrowserOrigin: true, allowedOrigins: [] };
    }
    return { allowAnyBrowserOrigin: false, allowedOrigins: normalized };
  }

  const configuredOrigins = normalizeOrigins(splitOrigins(env.TABULA_MCP_ALLOWED_ORIGINS));
  if (configuredOrigins.includes("*")) {
    if (production && !allowAnyOrigin) {
      throw new TabulaMcpError(
        "Production Tabula MCP does not allow TABULA_MCP_ALLOWED_ORIGINS=* unless TABULA_MCP_ALLOW_ANY_ORIGIN=1.",
      );
    }
    return { allowAnyBrowserOrigin: true, allowedOrigins: [] };
  }

  if (configuredOrigins.length > 0) {
    return { allowAnyBrowserOrigin: false, allowedOrigins: configuredOrigins };
  }

  return {
    allowAnyBrowserOrigin: !production,
    allowedOrigins: [],
  };
};

export const isAllowedOrigin = (origin: string | null | undefined, policy: OriginPolicy) =>
  !origin || policy.allowAnyBrowserOrigin || policy.allowedOrigins.includes(origin);

export const corsHeadersForOrigin = (
  origin: string | null | undefined,
  policy: OriginPolicy,
  extraHeaders: HeadersInit = {},
) => {
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,last-event-id,mcp-protocol-version,mcp-session-id",
    "access-control-expose-headers": "mcp-protocol-version,mcp-session-id",
    ...extraHeaders,
  });

  if (origin && isAllowedOrigin(origin, policy)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
    return headers;
  }

  if (!origin && policy.allowAnyBrowserOrigin) {
    headers.set("access-control-allow-origin", "*");
    headers.set("vary", "origin");
  }

  return headers;
};
