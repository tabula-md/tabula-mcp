import {
  isTruthyEnvValue,
  resolveProductionMode,
  type RuntimeEnvironment,
} from "./env.js";

export type ProductionEgressPolicyOptions = {
  allowedUrlsEnvName: string;
  defaultAllowedUrls: readonly string[];
  env?: RuntimeEnvironment;
  serviceName: string;
  trustedUrlEnvNames?: readonly string[];
  url: string;
};

const splitUrls = (value: string | undefined) =>
  value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

export const normalizeServiceUrl = (value: string, serviceName: string) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${serviceName} URL must be an absolute URL.`);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${serviceName} URL must not include credentials, query strings, or fragments.`);
  }

  return parsed.href.replace(/\/+$/, "");
};

export const assertProductionEgressAllowed = ({
  allowedUrlsEnvName,
  defaultAllowedUrls,
  env = {},
  serviceName,
  trustedUrlEnvNames = [],
  url,
}: ProductionEgressPolicyOptions) => {
  const normalizedUrl = normalizeServiceUrl(url, serviceName);
  if (!resolveProductionMode({ env }) || isTruthyEnvValue(env.TABULA_MCP_ALLOW_ANY_EGRESS)) {
    return normalizedUrl;
  }

  const configuredAllowedUrls = splitUrls(env[allowedUrlsEnvName]);
  const trustedEnvUrls = trustedUrlEnvNames.flatMap((envName) => splitUrls(env[envName]));
  const allowedUrls = new Set(
    [...defaultAllowedUrls, ...configuredAllowedUrls, ...trustedEnvUrls].map((allowedUrl) =>
      normalizeServiceUrl(allowedUrl, serviceName),
    ),
  );

  if (!allowedUrls.has(normalizedUrl)) {
    throw new Error(
      `Production Tabula MCP does not allow ${serviceName} egress to ${normalizedUrl}. Add it to ${allowedUrlsEnvName} or set TABULA_MCP_ALLOW_ANY_EGRESS=1 for a trusted self-hosted deployment.`,
    );
  }

  return normalizedUrl;
};
