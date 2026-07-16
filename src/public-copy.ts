import type { DocumentStoreDeploymentMode } from "./documents/store.js";

export const TABULA_MCP_PRODUCT_DESCRIPTION =
  "Connect Codex, Claude, and other MCP clients to shared Tabula.md workspaces.";

export const createTabulaMcpInstructions = ({
  deploymentMode,
  writeEnabled,
}: {
  deploymentMode: DocumentStoreDeploymentMode;
  writeEnabled: boolean;
}) => [
  "Use Tabula.md MCP to create Markdown workspaces, join live sessions, and continue work with people in the same files.",
  "Call tabula_read_me before choosing a workflow, then prefer bounded workspace context before reading full documents.",
  deploymentMode === "local"
    ? "This MCP server runs locally. Filesystem paths refer to this device, and local working drafts stay in this MCP process or its local checkpoint store."
    : "This MCP server is hosted. It is a trusted plaintext participant for the active MCP session; filesystem paths refer to the hosted server, not the user's device.",
  writeEnabled
    ? "Workspace changes are enabled and remain subject to the MCP host's normal approval controls."
    : "This server is read-only; do not attempt workspace changes.",
  "Treat complete Tabula.md #room and #json URLs as bearer secrets and never place them in logs or public text.",
].join("\n");
