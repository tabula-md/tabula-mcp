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
  "Default room sessions are proposal-first and use workspace.proposal.created events for agent edits.",
  "Use current lowercase SHA-256 hex sha256/baseSha256 values before proposing guarded workspace document patches.",
  "Encrypted share export may upload encrypted snapshot bytes to the Tabula JSON service, but not plaintext Markdown or snapshot keys.",
];

const avoid = [
  "Do not ask the user for installer configuration when the Claude Desktop MCPB is installed.",
  "Do not claim an MCP App document checkpoint is durable after the MCP process exits unless the configured checkpoint store is durable or the document has been exported.",
  "Do not treat App draft recovery as encrypted room storage; it is plaintext local browser storage.",
  "Do not treat MCP document checkpoints as Tabula JSON snapshots; checkpoints are working state, while #json links are encrypted handoff artifacts.",
  "Do not invent single-document room workflows; use workspace documents even when the workspace contains one document.",
];

const summaries: Record<TabulaReadMeTopic, string> = {
  overview:
    "Tabula.md MCP is for Markdown-first collaboration with people and agents. Use MCP App document checkpoints for drafting, encrypted room tools for existing Tabula.md rooms, and encrypted snapshot export when a draft should become a Tabula.md handoff link.",
  documents:
    "For a new draft, call tabula_create_document. To resume a saved checkpoint, call tabula_list_documents, then tabula_open_document. The App editor can save into the MCP document checkpoint store, recover unsaved browser drafts, send compact changes back into model context, and share the saved document as an encrypted snapshot link.",
  rooms:
    "For an existing Tabula.md room link, call tabula_connect_room with the full URL including #room=<roomId>,<roomKey>. The MCP client joins as an agent actor, can publish presence, and proposes workspace document changes through encrypted workspace.proposal.created events.",
  sharing:
    "To share an MCP App document, call tabula_share_document or use the App Share control. The MCP process creates a snapshot key, encrypts a Tabula JSON snapshot, uploads only encrypted bytes, and returns a #json share URL.",
  security:
    "Tabula.md room keys live in URL fragments and must remain client-side. The MCP process may decrypt locally because the user supplied the secret, but the room server should only see encrypted envelopes.",
};

const nextActionsByTopic: Record<TabulaReadMeTopic, string[]> = {
  overview: [
    "Use tabula_create_document for a new Markdown draft checkpoint.",
    "Use tabula_list_documents and tabula_open_document to resume a saved checkpoint.",
    "Use tabula_connect_room for an existing Tabula.md room URL.",
    "Use tabula_read_me with topic=security before changing room links, write mode, or sharing behavior.",
  ],
  documents: [
    "Create or open the document App before asking the user to edit Markdown interactively.",
    "Use Send Changes after App edits when the model needs updated context.",
    "Use Save before treating the MCP checkpoint copy as current.",
  ],
  rooms: [
    "Read room status before deciding whether a room is connected or writable.",
    "Expect room content to arrive as workspace metadata plus document state from connected peers.",
    "Use tabula_read_workspace and tabula_read_workspace_document for room content, even when there is only one document.",
    "Use tabula_propose_workspace_changes for reviewable agent edits.",
  ],
  sharing: [
    "Call tabula_share_document only for MCP App documents that should become encrypted snapshot links.",
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
