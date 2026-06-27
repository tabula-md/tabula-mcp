const writeEnabledValues = new Set(["1", "true", "yes", "on"]);

export type WriteAccessConfig = {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

export const resolveWriteEnabled = ({ env = process.env, argv = process.argv.slice(2) }: WriteAccessConfig = {}) => {
  if (argv.includes("--read-only")) {
    return false;
  }
  if (argv.includes("--enable-write")) {
    return true;
  }

  return writeEnabledValues.has((env.TABULA_MCP_ENABLE_WRITE ?? "").trim().toLowerCase());
};
