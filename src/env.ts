export type RuntimeEnvironment = Record<string, string | undefined>;

export const isTruthyEnvValue = (value: string | undefined) =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

export const positiveIntegerFromEnv = (value: string | undefined, fallback: number) => {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveProductionMode = ({
  env,
  production,
}: {
  env: RuntimeEnvironment;
  production?: boolean;
}) => {
  if (production !== undefined) {
    return production;
  }

  if (isTruthyEnvValue(env.TABULA_MCP_PRODUCTION) || isTruthyEnvValue(env.TABULA_MCP_PUBLIC_ENDPOINT)) {
    return true;
  }

  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
};
