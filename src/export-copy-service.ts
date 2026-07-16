import { assertMarkdownSize } from "./documents/snapshot.js";
import type { RuntimeEnvironment } from "./env.js";
import type { SessionRegistry } from "./registry.js";
import { shareMarkdownWorkspace } from "./share.js";
import { readSessionExportSnapshot } from "./workspace-file-service.js";

export type ExportCopyFile = {
  path: string;
  content: string;
};

export type ExportCopySource =
  | { kind: "files"; title?: string; files: readonly ExportCopyFile[] }
  | { kind: "session"; sessionId: string; paths?: readonly string[] };

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
  if (source.kind === "files") {
    for (const file of source.files) {
      assertMarkdownSize(file.content);
    }
    const shared = await shareMarkdownWorkspace({
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
    };
  }

  const snapshot = await readSessionExportSnapshot({
    registry,
    sessionId: source.sessionId,
    paths: source.paths,
  });
  const rootTitle = snapshot.workspace.nodes.find((node) => node.id === snapshot.workspace.rootId)?.title;
  const shared = await shareMarkdownWorkspace({
    title: rootTitle ?? "Tabula session",
    files: snapshot.files,
    activeFileId: snapshot.activeDocumentId,
    appOrigin: env?.TABULA_APP_ORIGIN?.trim() || "https://tabula.md",
    env,
    now: () => createdAt,
  });
  return {
    copyUrl: shared.shareUrl,
    fileCount: snapshot.files.length,
    encrypted: true as const,
    createdAt: createdAt.toISOString(),
  };
};
