import type { DocumentStoreDeploymentMode } from "../documents/store.js";

export const createCoreInstructions = ({
  deploymentMode,
}: {
  deploymentMode: DocumentStoreDeploymentMode;
}) => [
  "Tabula turns Markdown produced by the host or local filesystem into live shared sessions or encrypted copies.",
  "When given a #room URL, join it and keep the URL private.",
  "List files first when the target file is unknown.",
  "Read existing files before replacing them and pass their revisions to Write File or Write Files.",
  "Use Search Files to find content across a session.",
  "Use Write Files once when several generated or local Markdown files should be added to an existing session.",
  "When the user wants multiple new Markdown files without a live session, call Export Copy once with files so they open as one Tabula workspace.",
  "Use Export Copy for a fixed #json handoff. Keep every returned copy URL private unless the user explicitly asks to share it.",
  "Use Start Session with files when people or agents should continue editing together.",
  "Tool execution approval is controlled by the MCP host.",
  deploymentMode === "local"
    ? "This MCP server runs locally; Markdown remains in the host until a Copy or Session tool is called."
    : "This MCP server is hosted and becomes a trusted plaintext participant in joined sessions.",
].join("\n");
