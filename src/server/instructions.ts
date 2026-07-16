import type { DocumentStoreDeploymentMode } from "../documents/store.js";

export const createCoreInstructions = ({
  deploymentMode,
}: {
  deploymentMode: DocumentStoreDeploymentMode;
}) => [
  "Tabula provides private Markdown drafts, live shared sessions, and encrypted copies.",
  "When given a #room URL, join it and keep the URL private.",
  "List files first when the target file is unknown.",
  "Read an existing file before replacing it and pass its revision to Write File.",
  "Use Search Files to find content across a session.",
  "Use Export Copy for a fixed #json handoff.",
  "Use Start Session when people or agents should continue editing together.",
  "Tool execution approval is controlled by the MCP host.",
  deploymentMode === "local"
    ? "This MCP server runs locally; private drafts stay in its local document store."
    : "This MCP server is hosted and becomes a trusted plaintext participant in joined sessions.",
].join("\n");
