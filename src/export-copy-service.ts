import type { DocumentRegistry } from "./documents/registry.js";
import type { RuntimeEnvironment } from "./env.js";
import type { SessionRegistry } from "./registry.js";
import { shareMarkdownDocument, shareMarkdownWorkspace } from "./share.js";
import { readSessionExportSnapshot } from "./workspace-file-service.js";

export type ExportCopySource =
  | { kind: "draft"; draftId: string }
  | { kind: "session"; sessionId: string; paths?: readonly string[] };

export const exportCopy = async ({
  source,
  documents,
  registry,
  env,
}: {
  source: ExportCopySource;
  documents: DocumentRegistry;
  registry: SessionRegistry;
  env?: RuntimeEnvironment;
}) => {
  const createdAt = new Date();
  if (source.kind === "draft") {
    const draft = await documents.get(source.draftId);
    const shared = await shareMarkdownDocument({
      title: draft.title,
      markdown: draft.markdown,
      appOrigin: env?.TABULA_APP_ORIGIN?.trim() || "https://tabula.md",
      env,
      now: () => createdAt,
    });
    return {
      copyUrl: shared.shareUrl,
      fileCount: 1,
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
