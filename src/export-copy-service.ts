import { assertMarkdownSize } from "./markdown-limits.js";
import { TabulaCoreError } from "./core-errors.js";
import type { RuntimeEnvironment } from "./env.js";
import type { SessionRegistry } from "./registry.js";
import { InvalidShareWorkspaceError, shareMarkdownWorkspace } from "./share.js";
import { readSessionExportSnapshot } from "./workspace-file-service.js";

export type ExportCopyFile = {
  path: string;
  content: string;
};

export type ExportCopySource =
  | { kind: "files"; title?: string; files: readonly ExportCopyFile[] }
  | { kind: "session"; sessionId: string; paths?: readonly string[] };

export type ExportCopyInput = {
  title?: string;
  files?: readonly ExportCopyFile[];
  sessionId?: string;
  paths?: readonly string[];
};

const invalidSourceOptions = {
  details: {
    expected: "Pass files for host-native Markdown or sessionId for a connected live session, but not both.",
    examples: [
      { files: [{ path: "sample.md", content: "# Sample\n" }] },
      { sessionId: "00000000-0000-4000-8000-000000000000", paths: ["sample.md"] },
    ],
  },
  retry: "Call Export Copy again with exactly one of files or sessionId.",
};

export const resolveExportCopySource = ({
  title,
  files,
  sessionId,
  paths,
}: ExportCopyInput): ExportCopySource => {
  const hasFiles = files !== undefined;
  const hasSession = sessionId !== undefined;

  if (hasFiles === hasSession) {
    throw new TabulaCoreError(
      "invalid_input",
      "Export Copy requires exactly one source: files or sessionId.",
      invalidSourceOptions,
    );
  }

  if (hasFiles) {
    if (paths !== undefined) {
      throw new TabulaCoreError(
        "invalid_input",
        "paths can only be used with sessionId, not files.",
        invalidSourceOptions,
      );
    }
    return {
      kind: "files",
      files,
      ...(title !== undefined ? { title } : {}),
    };
  }

  if (title !== undefined) {
    throw new TabulaCoreError(
      "invalid_input",
      "title can only be used with files, not sessionId.",
      invalidSourceOptions,
    );
  }

  if (sessionId === undefined) {
    throw new TabulaCoreError(
      "invalid_input",
      "Export Copy requires exactly one source: files or sessionId.",
      invalidSourceOptions,
    );
  }

  return {
    kind: "session",
    sessionId,
    ...(paths !== undefined ? { paths } : {}),
  };
};

export const exportCopy = async ({
  source,
  registry,
  env,
}: {
  source: ExportCopySource;
  registry: SessionRegistry;
  env?: RuntimeEnvironment;
}) => {
  const createdAt = new Date();
  const share = async (input: Parameters<typeof shareMarkdownWorkspace>[0]) => {
    try {
      return await shareMarkdownWorkspace(input);
    } catch (error) {
      if (error instanceof InvalidShareWorkspaceError) {
        throw new TabulaCoreError("invalid_input", "The Markdown files cannot form a valid Tabula copy.", {
          details: { reason: error.message, ...(error.conflicts.length ? { conflicts: error.conflicts } : {}) },
          retry: "Rename conflicting paths or export fewer or smaller Markdown files, then retry.",
        });
      }
      throw error;
    }
  };
  if (source.kind === "files") {
    for (const file of source.files) {
      assertMarkdownSize(file.content);
    }
    const shared = await share({
      title: source.title,
      files: source.files.map((file, index) => ({
        id: `inline-${index + 1}`,
        path: file.path,
        title: file.path.split("/").at(-1) || "Untitled.md",
        text: file.content,
      })),
      appOrigin: env?.TABULA_APP_ORIGIN?.trim() || "https://tabula.md",
      env,
      now: () => createdAt,
    });
    return {
      copyUrl: shared.shareUrl,
      fileCount: source.files.length,
      encrypted: true as const,
      createdAt: createdAt.toISOString(),
      ...(shared.expiresAt ? { expiresAt: shared.expiresAt } : {}),
    };
  }

  const snapshot = await readSessionExportSnapshot({
    registry,
    sessionId: source.sessionId,
    paths: source.paths,
  });
  const rootTitle = snapshot.workspace.nodes.find((node) => node.id === snapshot.workspace.rootId)?.title;
  const shared = await share({
    title: rootTitle ?? "Tabula session",
    files: snapshot.files,
    activeFileId: snapshot.activeDocumentId,
    commentsByFileId: snapshot.commentsByFileId,
    appOrigin: env?.TABULA_APP_ORIGIN?.trim() || "https://tabula.md",
    env,
    now: () => createdAt,
  });
  return {
    copyUrl: shared.shareUrl,
    fileCount: snapshot.files.length,
    encrypted: true as const,
    createdAt: createdAt.toISOString(),
    ...(shared.expiresAt ? { expiresAt: shared.expiresAt } : {}),
  };
};
