export type TabulaCoreErrorCode =
  | "copy_import_failed"
  | "directory_not_empty"
  | "edit_ambiguous"
  | "edit_not_found"
  | "file_not_found"
  | "invalid_input"
  | "invalid_path"
  | "invalid_range"
  | "internal_error"
  | "parent_folder_not_found"
  | "path_exists"
  | "read_too_large"
  | "session_not_found"
  | "session_limit"
  | "session_not_ready"
  | "stale_cursor"
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

  const structuredContent = {
    code: "internal_error" as const,
    message: "Tabula could not complete the operation because of an unexpected internal error.",
    retry: "Retry once. If the problem continues, reconnect the session and report the failure.",
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
};
