import type { DocumentStoreDeploymentMode } from "../documents/store.js";

export const createCoreInstructions = ({
  deploymentMode,
}: {
  deploymentMode: DocumentStoreDeploymentMode;
}) => [
  "Tabula turns Markdown produced by the host or local filesystem into live shared sessions or encrypted copies.",
  "When given a #room URL, join it and keep the URL private.",
  "Keep the sessionId returned by Join Room or Start Session and pass it to every Room file tool; never guess or substitute another session.",
  "Use Leave Session when the user asks the agent to leave a live session; this disconnects the agent without deleting Room files.",
  "List files first when the target file is unknown.",
  "Use Read File for one file or a bounded line range, and Read Files for a small batch.",
  "Read existing files before changing them and pass their revisions to Write File, Write Files, Edit File, Move or Rename, or Delete Path.",
  "Use Search Files to find content with nearby line context across a session.",
  "Use Write File for one complete file and Write Files once for an atomic multi-file change or import.",
  "Use Edit File for small exact replacements; stale edits rebase only when their text anchors remain safe.",
  "Move or Rename accepts files and directories; create a missing destination directory first.",
  "Delete Path requires recursive true for a non-empty directory.",
  "When given a #json URL, use Import Copy, keep the URL private, and preserve the returned relative paths when the user asks to materialize the Markdown locally.",
  "Import Copy does not join a live session or write to the filesystem; use the host's file tools and do not overwrite existing files without the user's approval.",
  "When the user wants multiple new Markdown files without a live session, call Export Copy once with files so they open as one Tabula workspace.",
  "Use Export Copy for a fixed #json handoff. Keep every returned copy URL private unless the user explicitly asks to share it.",
  "Use Start Session with files when people or agents should continue editing together.",
  "Tool execution approval is controlled by the MCP host.",
  deploymentMode === "local"
    ? "This MCP server runs locally; Markdown remains in the host until a Copy or Session tool is called."
    : "This MCP server is hosted and becomes a trusted plaintext participant in joined sessions.",
].join("\n");
