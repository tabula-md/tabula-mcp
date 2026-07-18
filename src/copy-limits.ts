import {
  WORKSPACE_ROOM_MAX_CONTENT_BYTES,
  WORKSPACE_ROOM_MAX_DOCUMENTS,
  WORKSPACE_ROOM_MAX_FOLDERS,
} from "@tabula-md/tabula/workspace-limits";

// Copy input/output remains intentionally smaller than the workspace format
// because it crosses an MCP model context. Structural maxima come from the
// shared Tabula contract so this service can never accept an artifact the app
// is unable to represent.
export const maxCopyFiles = Math.min(100, WORKSPACE_ROOM_MAX_DOCUMENTS);
export const maxCopyFolders = Math.min(100, WORKSPACE_ROOM_MAX_FOLDERS);
export const maxCopyCharacters = 200_000;
export const maxCopyFileBytes = 5 * 1024 * 1024;
export const maxCopyPathBytes = 1024;
export const maxCopyPlaintextBytes = WORKSPACE_ROOM_MAX_CONTENT_BYTES;
export const maxEncryptedCopyBytes = 8 * 1024 * 1024;
