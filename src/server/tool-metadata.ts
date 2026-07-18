export const CORE_TOOL_NAMES = [
  "start_session",
  "join_room",
  "leave_session",
  "list_files",
  "read_file",
  "read_multiple_files",
  "search_files",
  "list_comments",
  "add_comment",
  "reply_to_comment",
  "resolve_comment",
  "delete_comment",
  "write_file",
  "write_files",
  "edit_file",
  "create_directory",
  "move_file",
  "delete_path",
  "import_copy",
  "export_copy",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

export type CoreToolMetadata = {
  title: string;
  description: string;
};

export const CORE_TOOL_METADATA: Record<CoreToolName, CoreToolMetadata> = {
  start_session: {
    title: "Start Session",
    description: "Use this when the user explicitly wants Markdown opened as a new live Tabula.md collaboration session. Do not use it for a private host draft, a fixed Copy, or an existing #room URL.",
  },
  join_room: {
    title: "Join Room",
    description: "Use this when the user provides a private Tabula.md #room URL. Join that existing live session, keep the URL private, and do not start a replacement session.",
  },
  leave_session: {
    title: "Leave Session",
    description: "Use this when the user asks the agent to disconnect from one live Tabula.md session. It does not delete the Room or its files.",
  },
  list_files: {
    title: "List Files",
    description: "Use this when the target path is unknown or a directory view is needed inside a connected Tabula.md session. Do not use it for the host's local filesystem.",
  },
  read_file: {
    title: "Read File",
    description: "Use this when reading one Markdown file or bounded line range inside a connected Tabula.md session. Do not use it for local or host-native files.",
  },
  read_multiple_files: {
    title: "Read Multiple Files",
    description: "Use this when reading a known small batch of complete Markdown files with revisions inside a connected Tabula.md session. Do not use it for local files.",
  },
  search_files: {
    title: "Search Files",
    description: "Use this when searching paths or Markdown content with nearby line context inside a connected Tabula.md session. Do not use it for the host's local filesystem.",
  },
  list_comments: {
    title: "List Comments",
    description: "Use this when finding open, resolved, or all product comment threads inside a connected Tabula.md session before acting on a comment ID.",
  },
  add_comment: {
    title: "Add Comment",
    description: "Use this when the user wants a file-level or inclusive line-anchored product comment added inside a connected Tabula.md session.",
  },
  reply_to_comment: {
    title: "Reply to Comment",
    description: "Use this when replying to an existing product comment thread inside a connected Tabula.md session. Obtain its comment ID from List Comments.",
  },
  resolve_comment: {
    title: "Resolve Comment",
    description: "Use this when resolving or reopening an existing product comment thread inside a connected Tabula.md session.",
  },
  delete_comment: {
    title: "Delete Comment",
    description: "Use this when the user explicitly wants to permanently delete an existing product comment thread and its replies from a connected Tabula.md session.",
  },
  write_file: {
    title: "Write File",
    description: "Use this when creating or replacing one complete Markdown file inside a connected Tabula.md session. Read an existing file first and pass its revision; do not use it for local files.",
  },
  write_files: {
    title: "Write Files",
    description: "Use this when one atomic multi-file create or replace operation is needed inside a connected Tabula.md session. Pass revisions for existing files; do not use it for local files.",
  },
  edit_file: {
    title: "Edit File",
    description: "Use this when making small exact-text replacements inside one Markdown file in a connected Tabula.md session. Read it first and pass its revision; stale edits rebase only on safe matches.",
  },
  create_directory: {
    title: "Create Directory",
    description: "Use this when creating a directory and missing parents inside a connected Tabula.md session. An existing directory is a no-op; this does not affect local folders.",
  },
  move_file: {
    title: "Move or Rename",
    description: "Use this when moving or renaming one file or directory inside a connected Tabula.md session. The destination parent must exist, and files require their current revision.",
  },
  delete_path: {
    title: "Delete Path",
    description: "Use this when the user explicitly wants to delete a path inside a connected Tabula.md session. Files need revisions and non-empty directories require recursive true.",
  },
  import_copy: {
    title: "Import Copy",
    description: "Use this when the user provides a private Tabula.md #json URL. It returns relative Markdown files but does not join a live Room or write them to the local filesystem.",
  },
  export_copy: {
    title: "Export Copy",
    description: "Use this when the user wants a fixed encrypted Tabula.md #json handoff from files or a live session. Use Start Session instead for continued live collaboration.",
  },
};

export const getCoreToolMetadata = (name: CoreToolName): CoreToolMetadata => CORE_TOOL_METADATA[name];
