export const tabulaReadMeTopics = ["overview", "documents", "rooms", "sharing", "security"] as const;

export type TabulaReadMeTopic = (typeof tabulaReadMeTopics)[number];

export type TabulaReadMe = {
  product: "Tabula.md";
  topic: TabulaReadMeTopic;
  summary: string;
  nextActions: string[];
  securityRules: string[];
  avoid: string[];
};

const securityRules = [
  "Treat any Tabula.md room URL with a #room fragment as a bearer secret because the fragment contains the room key.",
  "Treat any Tabula.md snapshot URL with a #json fragment as a bearer secret because the fragment contains the snapshot key.",
  "Never send room keys or plaintext Markdown to the Tabula Room server.",
  "Hosted Tabula MCP document checkpoints may temporarily store plaintext Markdown for agent editing; use encrypted share export for handoff links.",
  "Encrypted live room checkpoints may be saved to Firebase Storage with an opaque Firestore pointer; neither service receives the room key or plaintext Markdown.",
  "Room edits use the same workspace Y.Doc, binary RoomWire v2 sync, and Awareness actor state as Tabula.md.",
  "Use current lowercase SHA-256 hex sha256/baseSha256 values before applying guarded workspace document patches.",
  "Encrypted share export may upload encrypted snapshot bytes to the Tabula JSON service, but not plaintext Markdown or snapshot keys.",
  "Filesystem workspace import reads paths visible to the MCP server runtime; hosted clients should provide inline files instead of local user paths.",
  "tabula:// resource URIs are session-local read handles and must never contain #room keys, #json keys, or plaintext secrets.",
  "Prefer compact workspace context before full Markdown reads; full document text should be requested deliberately.",
];

const avoid = [
  "Do not ask the user for installer configuration when the Claude Desktop MCPB is installed.",
  "Do not claim an MCP App document checkpoint is durable after the MCP process exits unless the configured checkpoint store is durable or the document has been exported.",
  "Do not treat App draft recovery as encrypted room storage; it is plaintext local browser storage.",
  "Do not treat MCP document checkpoints as Tabula JSON snapshots or live room checkpoints; MCP checkpoints are working state, Firebase room checkpoints are encrypted live recovery, and #json links are encrypted handoff artifacts.",
  "Do not invent single-document room workflows; use workspace documents even when the workspace contains one document.",
  "Do not rely on MCP resources as the only workflow surface; some clients expose only tools.",
];

const summaries: Record<TabulaReadMeTopic, string> = {
  overview:
    "Tabula.md MCP is for Markdown-first collaboration with people and agents. Use MCP App document checkpoints for drafting, workspace tools for multi-file Markdown projects, encrypted room tools for live collaboration, and encrypted snapshot export when a workspace should become a Tabula.md handoff link.",
  documents:
    "For a new draft, call tabula_create_document. To resume a saved checkpoint, call tabula_list_documents, then tabula_open_document. The App editor can save into the MCP document checkpoint store, recover unsaved browser drafts, send compact changes back into model context, and share the saved document as an encrypted snapshot link.",
  rooms:
    "For a new live room, create or import a workspace and call tabula_create_workspace_room. For an existing Tabula.md room link, call tabula_connect_room with the full URL including #room=<roomId>,<roomKey>. The MCP client joins as an agent actor, loads/saves encrypted live room checkpoints when Firebase is configured, or waits for state from an active peer when it is not. Do not read or edit workspace content until stateReceived is true.",
  sharing:
    "To share an MCP App document, call tabula_share_document or use the App Share control. To share a multi-file workspace, call tabula_share_workspace. The MCP process creates a snapshot key, encrypts a Tabula JSON snapshot, uploads only encrypted bytes, and returns a #json share URL.",
  security:
    "Tabula.md room keys live in URL fragments and must remain client-side. The MCP process may decrypt locally because the user supplied the secret, but the room server should only see encrypted envelopes.",
};

const nextActionsByTopic: Record<TabulaReadMeTopic, string[]> = {
  overview: [
    "Use tabula_create_document for a new Markdown draft checkpoint.",
    "Use tabula_create_workspace or tabula_import_markdown_workspace for multi-file Markdown workspaces; prefer source.files unless the MCP client grants filesystem roots or TABULA_MCP_ALLOWED_IMPORT_ROOTS is configured.",
    "Use tabula_create_workspace_room when the agent should create a new live collaboration room.",
    "Use tabula_list_documents and tabula_open_document to resume a saved checkpoint.",
    "Use tabula_connect_room for an existing Tabula.md room URL.",
    "Use returned tabula:// resourceUri handles only when the MCP client supports resources; otherwise continue with read tools.",
    "Use tabula_read_me with topic=security before changing room links, write mode, or sharing behavior.",
  ],
  documents: [
    "Create or open the document App before asking the user to edit Markdown interactively.",
    "Use Send Changes after App edits when the model needs updated context.",
    "Use Save before treating the MCP checkpoint copy as current.",
  ],
  rooms: [
    "Use tabula_create_workspace_room to create a new encrypted workspace room from an imported or inline workspace.",
    "Read room status before deciding whether a room is connected or writable.",
    "Check checkpointStatus after connecting or creating a room to see whether encrypted live room recovery was loaded, saved, missing, disabled, or failed.",
    "Expect room content to arrive from an encrypted live room checkpoint or as workspace metadata plus document state from connected peers.",
    "Use tabula_read_workspace and tabula_read_workspace_document for room content, even when there is only one document.",
    "Use tabula_read_workspace_context with documentIds, pathGlobs, query, or changedSince for bounded planning context before reading full documents.",
    "Pass detail=tree to tabula_read_workspace only when folder/node structure is needed.",
    "Use tabula:// resourceUri handles as optional read-only mirrors when the client exposes MCP resources.",
    "Use tabula_apply_workspace_changes for hash-guarded direct agent edits.",
  ],
  sharing: [
    "Call tabula_share_document only for MCP App documents that should become encrypted snapshot links.",
    "Call tabula_share_workspace for multi-file workspaces that should become encrypted snapshot links.",
    "Open the returned shareUrl in Tabula.md when the user wants to import or hand off the snapshot.",
    "Tell the user the returned URL is secret because #json contains the snapshot key.",
    "If upload fails, explain that no plaintext fallback was used.",
  ],
  security: [
    "Keep #room/#json links and their fragment keys out of logs and issue text.",
    "Use remote Tabula MCP only when the MCP service is allowed to hold temporary plaintext checkpoints for agent editing.",
    "Prefer encrypted snapshot export over plaintext upload.",
    "Ask before changing persistence boundaries or moving room processing to a remote MCP server.",
  ],
};

export const getTabulaReadMe = (topic: TabulaReadMeTopic = "overview"): TabulaReadMe => ({
  product: "Tabula.md",
  topic,
  summary: summaries[topic],
  nextActions: nextActionsByTopic[topic],
  securityRules,
  avoid,
});

export const formatTabulaReadMe = (readMe: TabulaReadMe) =>
  [
    `Tabula.md MCP read_me (${readMe.topic})`,
    "",
    readMe.summary,
    "",
    "Next actions:",
    ...readMe.nextActions.map((item) => `- ${item}`),
    "",
    "Security rules:",
    ...readMe.securityRules.map((item) => `- ${item}`),
    "",
    "Avoid:",
    ...readMe.avoid.map((item) => `- ${item}`),
  ].join("\n");
