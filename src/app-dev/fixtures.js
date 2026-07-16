export const documentFixture = {
  document: {
    documentId: "123e4567-e89b-42d3-a456-426614174000",
    title: "Launch Brief",
    source: "local-document",
    status: "draft",
    textLength: 167,
    sha256: "9b8f4c2d1a6e7f30",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    outlineCount: 2,
  },
  markdown:
    "# Launch Brief\n\nAlign the launch narrative before the next review.\n\n## Goal\n\n- Clarify the customer problem\n- Confirm the key proof points\n- Share the final Markdown brief",
  outline: [
    {
      depth: 1,
      text: "Launch Brief",
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
    roomId: "research-review",
    shareUrl: "http://localhost:5173/#room=research-review,example-key-for-local-preview-only",
    status: "connected",
    sha256: "5e7a1c4d2b9f0836",
    textLength: 80,
    collaboratorCount: 1,
    agentConnected: true,
    hydrationStatus: "ready",
    stateReceived: true,
    lastStateReceivedAt: "2026-06-28T00:00:00.000Z",
  },
  markdown:
    "# Research Review\n\nA teammate shared this encrypted Markdown room for review.\n\n## Questions\n\n- Which claim needs more evidence?\n- What should the next agent investigate?",
  outline: [
    {
      depth: 1,
      text: "Research Review",
      line: 1,
      offset: 0,
    },
    {
      depth: 2,
      text: "Questions",
      line: 5,
      offset: 84,
    },
  ],
};
