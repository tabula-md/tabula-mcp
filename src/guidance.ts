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
  "Treat any Tabula.md room URL with a #key fragment as a bearer secret.",
  "Never send room keys or plaintext Markdown to the Tabula Room server.",
  "Default room sessions are read-only; room writes require server-level opt-in with TABULA_MCP_ENABLE_WRITE=1 or --enable-write.",
  "Use current sha256/baseSha256 values before applying guarded room patches.",
  "Encrypted share export may upload encrypted snapshot envelopes, but not plaintext Markdown or room keys.",
];

const avoid = [
  "Do not ask the user for installer configuration when the Claude Desktop MCPB is installed.",
  "Do not claim a local App document is durable after the MCP process exits unless it has been exported or otherwise persisted.",
  "Do not treat App draft recovery as encrypted room storage; it is plaintext local browser storage.",
  "Do not call read-only room views write-capable unless the server was explicitly started in write mode.",
];

const summaries: Record<TabulaReadMeTopic, string> = {
  overview:
    "Tabula.md MCP is for Markdown-first collaboration with people and agents. Use local App documents for drafting, encrypted room tools for existing Tabula.md rooms, and encrypted share export when a local draft should become a Tabula.md room link.",
  documents:
    "For a new draft, call tabula_create_document. The App editor can save into the local MCP session, recover unsaved browser drafts, send compact changes back into model context, and share the saved document as an encrypted room link.",
  rooms:
    "For an existing Tabula.md room link, call tabula_connect_room with the full URL including #key. Open tabula_open_room_view for a read-only App view, or use read_markdown/get_outline/wait_for_changes for text workflows.",
  sharing:
    "To share a local App document, call tabula_share_document or use the App Share control. The MCP process creates a room id and key locally, encrypts the Markdown as a Yjs snapshot, uploads only the encrypted envelope, and returns a #key share URL.",
  security:
    "Tabula.md room keys live in URL fragments and must remain client-side. The MCP process may decrypt locally because the user supplied the secret, but the room server should only see encrypted envelopes.",
};

const nextActionsByTopic: Record<TabulaReadMeTopic, string[]> = {
  overview: [
    "Use tabula_create_document for a new local Markdown draft.",
    "Use tabula_connect_room for an existing Tabula.md room URL.",
    "Use tabula_read_me with topic=security before changing room links, write mode, or sharing behavior.",
  ],
  documents: [
    "Create or open the document App before asking the user to edit Markdown interactively.",
    "Use Send Changes after App edits when the model needs updated context.",
    "Use Save before treating the local MCP session copy as current.",
  ],
  rooms: [
    "Read room status before deciding whether a room is connected or writable.",
    "Use tabula_get_outline for structure before large edits.",
    "Use tabula_apply_text_patches only when the server exposes it and a current baseSha256 is available.",
  ],
  sharing: [
    "Call tabula_share_document only for local App documents that should become encrypted room links.",
    "Tell the user the returned URL is secret because #key decrypts the room.",
    "If upload fails, explain that no plaintext fallback was used.",
  ],
  security: [
    "Keep #key values out of logs, issue text, and hosted plaintext processing.",
    "Prefer encrypted snapshot export over plaintext upload.",
    "Ask before enabling room writes or changing persistence boundaries.",
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
