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

  // MCP hosts own the human approval step for a mutating tool invocation.
  // Tabula should therefore be a capable Room actor by default; `--read-only`
  // remains the explicit server-operator opt-out for inspection-only installs.
  void env;
  return true;
};
