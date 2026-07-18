export type TabulaCoreErrorCode =
  | "copy_import_failed"
  | "directory_not_empty"
  | "edit_ambiguous"
  | "edit_not_found"
  | "file_not_found"
  | "invalid_input"
  | "invalid_path"
  | "invalid_range"
  | "parent_folder_not_found"
  | "path_exists"
  | "read_too_large"
  | "session_not_found"
  | "session_not_ready"
  | "stale_revision"
  | "write_failed"
  | "write_disabled";

export class TabulaCoreError extends Error {
  readonly code: TabulaCoreErrorCode;
  readonly details: Record<string, unknown>;
  readonly retry?: string;

  constructor(
    code: TabulaCoreErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retry?: string } = {},
  ) {
    super(message);
    this.name = "TabulaCoreError";
    this.code = code;
    this.details = options.details ?? {};
    this.retry = options.retry;
  }
}

export const coreErrorContent = (error: unknown) => {
  if (error instanceof TabulaCoreError) {
    const structuredContent = {
      code: error.code,
      message: error.message,
      ...error.details,
      ...(error.retry ? { retry: error.retry } : {}),
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    };
  }

  const message = error instanceof Error ? error.message : "Unknown Tabula MCP error.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
};
