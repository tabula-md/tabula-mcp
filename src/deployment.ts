import { isTruthyEnvValue, type RuntimeEnvironment } from "./env.js";

export type DeploymentMode = "local" | "remote";

export const resolveDeploymentMode = ({
  env = typeof process === "undefined" ? {} : process.env,
  deploymentMode,
  defaultDeploymentMode = "local",
}: {
  env?: RuntimeEnvironment;
  deploymentMode?: DeploymentMode;
  defaultDeploymentMode?: DeploymentMode;
} = {}): DeploymentMode => {
  if (deploymentMode) {
    return deploymentMode;
  }

  const configuredMode = env.TABULA_MCP_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (configuredMode === "local" || configuredMode === "remote") {
    return configuredMode;
  }

  return isTruthyEnvValue(env.TABULA_MCP_REMOTE) ? "remote" : defaultDeploymentMode;
};
