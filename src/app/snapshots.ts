import type { DocumentRegistry } from "../documents/registry.js";
import type { TabulaDocumentSnapshot } from "../documents/schema.js";
import { summarizeDocument } from "../documents/snapshot.js";
import type { SessionRegistry } from "../registry.js";

type RoomStatus = Awaited<ReturnType<ReturnType<SessionRegistry["get"]>["getStatus"]>>;

export const summarizeRoomStatus = (status: RoomStatus) => ({
  sessionId: status.sessionId,
  roomId: status.roomId,
  shareUrl: status.shareUrl,
  status: status.status,
  writeAccess: status.writeAccess,
  textLength: status.textLength,
  sha256: status.sha256,
  peerCount: status.peerCount,
  collaboratorCount: status.collaborators.length,
  hydrationStatus: status.hydrationStatus,
  stateReceived: status.stateReceived,
  ...(status.lastStateReceivedAt ? { lastStateReceivedAt: status.lastStateReceivedAt } : {}),
});

export const documentSnapshotContent = (document: TabulaDocumentSnapshot) => ({
  mode: "document",
  document: summarizeDocument(document),
  markdown: document.markdown,
  outline: document.outline,
});

export const readDocumentSnapshot = async (documents: DocumentRegistry, documentId?: string) =>
  documentSnapshotContent(await documents.get(documentId));

export const readRoomSnapshot = async (registry: SessionRegistry, sessionId?: string) => {
  const session = registry.get(sessionId);
  const status = await session.getStatus();

  const room = summarizeRoomStatus(status);
  if (!status.stateReceived) {
    return {
      mode: "room",
      room,
      status: room,
      markdown: "",
      outline: [],
      waitingForWorkspaceState: true,
    };
  }

  const [markdown, outline] = await Promise.all([
    session.readMarkdown(),
    session.getOutline(),
  ]);

  return {
    mode: "room",
    room,
    status: room,
    markdown: markdown.markdown,
    outline: outline.outline,
    waitingForWorkspaceState: false,
  };
};
