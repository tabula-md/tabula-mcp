export const documentFixture = {
  document: {
    documentId: "123e4567-e89b-42d3-a456-426614174000",
    title: "Local Draft",
    source: "local-document",
    status: "draft",
    textLength: 167,
    sha256: "fixture-document-hash",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    outlineCount: 2,
  },
  markdown: "# Local Draft\n\nUse this harness to test editor, preview, save, share, and model context sync.\n\n## Plan\n\n- Edit Markdown\n- Save a snapshot\n- Send changes\n- Open in Tabula",
  outline: [
    {
      depth: 1,
      text: "Local Draft",
      line: 1,
      offset: 0,
    },
    {
      depth: 2,
      text: "Plan",
      line: 5,
      offset: 96,
    },
  ],
};

export const roomFixture = {
  mode: "room",
  room: {
    sessionId: "123e4567-e89b-42d3-a456-426614174999",
    roomId: "dev-room",
    shareUrl: "http://localhost:5173/#room=dev-room,dev-only-not-a-real-key",
    status: "connected",
    writeAccess: false,
    sha256: "fixture-room-hash",
    textLength: 80,
    peerCount: 2,
  },
  markdown: "# Shared Room\n\nThis read-only fixture simulates an encrypted Tabula.md room snapshot.\n\n## Notes",
  outline: [
    {
      depth: 1,
      text: "Shared Room",
      line: 1,
      offset: 0,
    },
    {
      depth: 2,
      text: "Notes",
      line: 5,
      offset: 84,
    },
  ],
};
