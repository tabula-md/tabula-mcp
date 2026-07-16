# Claude Desktop

Tabula.md MCP is packaged for Claude Desktop as a zero-config MCP Bundle
(`.mcpb`). Normal users should not enter a room URL, room key, token, or write
setting during installation.

## Build

```sh
npm install
npm run release:pack
```

Build and release packaging require Node.js `^20.19.0 || >=22.12.0`.

The bundle includes `assets/icon.png` for the Claude Desktop extension listing
and is written to `dist/tabula-mcp-<version>.mcpb`, with a matching
`dist/tabula-mcp-<version>.mcpb.sha256` checksum.

`release:pack` builds the TypeScript server, bundles the Document App, stages
the MCPB directory, validates the manifest, packs the bundle, and runs the
local MCPB checker, then writes the checksum file.

Before installing in Claude Desktop, run `npm run test:stdio` to smoke-test the
built stdio server with the same MCP transport shape Claude Desktop uses.

## Install

Install the generated `.mcpb` in Claude Desktop by double-clicking it, dragging
it into Claude Desktop, or using:

```txt
Settings -> Extensions -> Advanced settings -> Install Extension
```

The installer should not ask for configuration. If an install screen asks for
Tabula room settings, room keys, or write mode, treat that as a release blocker.

## Create A Document

Ask Claude to create a Tabula.md document, or call `tabula_create_document`
directly from an MCP tool inspector.

Expected behavior:

1. Claude opens the Tabula.md Document App.
2. Inline mode shows the Markdown preview with `Open in Tabula` and `Edit`.
3. Clicking `Edit` opens fullscreen editing, where title editing and
   Editor/Split/Preview modes work.
4. Save stores the document in the local MCP server process.
5. Send Changes posts a compact edit summary back into model context.
6. Share creates an encrypted `https://tabula.md/#json=...,...` link. If the
   App has unsent edits, the share handoff also includes a compact edit summary.

Local App documents are checkpointed as plaintext files on this machine so they
can recover across MCP process restarts. They are not uploaded to Tabula.md room
infrastructure until the user explicitly shares them.

To resume a local document after restarting Claude Desktop or the MCP server,
ask Claude to list local Tabula.md documents with `tabula_list_documents`, then
open one with `tabula_open_document`.

## Open A Room

Ask Claude to connect a Tabula.md room URL:

```txt
https://tabula.md/#room=<roomId>,<roomKey>
```

Hosted `https://tabula.md/#room=...` links use `https://rooms.tabula.md`.
Local development links such as `http://localhost:5173/#room=...` default to
`http://localhost:3002`.

Expected behavior:

1. `tabula_create_workspace` or `tabula_import_markdown_workspace` can prepare a multi-file Markdown workspace, and `tabula_create_workspace_room` can publish it as a new encrypted live room. Inline `source.files` import is zero-config; local folder import requires MCP roots or `TABULA_MCP_ALLOWED_IMPORT_ROOTS`.
2. If `VITE_TABULA_FIREBASE_CONFIG`, `TABULA_FIREBASE_CONFIG`, or
   `TABULA_MCP_FIREBASE_CONFIG` is set, the created room is also saved as an
   encrypted live room checkpoint for later recovery.
3. `tabula_connect_room` connects an existing encrypted room as a
   `tabula-mcp` agent actor and reports whether checkpoint recovery was loaded,
   missing, disabled, or failed. Checkpoint recovery is optional: when it is
   unavailable, Claude can still join an active room and receive the workspace
   from a browser or another live peer. Until `stateReceived` is true, the MCP
   keeps workspace reads and edits blocked to avoid treating an empty local
   CRDT as the shared workspace.
4. `tabula_open_room_view` opens the App room view.
5. `tabula_read_workspace`, `tabula_read_workspace_context`,
   `tabula_read_workspace_document`, and `tabula_apply_workspace_changes` let
   the agent inspect bounded context with document, path, query, and changed-since filters, read exact full text when needed, and
   apply hash-guarded workspace document changes when room state is available.
   A one-document room is still represented as a workspace with one document.
6. `tabula_share_workspace` exports a workspace as an encrypted multi-file
   `#json` snapshot link.
7. The room server only receives encrypted envelopes.

Some Claude surfaces are tool-first and may not expose MCP resources to the
model. That is fine: the tools are complete. If a client does expose resources,
Tabula returns `tabula://...` `resourceUri` handles as read-only mirrors of the
same workspace metadata and Markdown.

Workspace reads are compact by default. Use `tabula_read_workspace_context`
before reading full documents, and pass `detail: "tree"` to
`tabula_read_workspace` only when the folder/node tree matters.

The `#room` fragment contains the room key and is a bearer secret. Do not paste
production room links into logs, issue trackers, or public screenshots.

## Room Editing

Claude edits live rooms through `tabula_apply_workspace_changes`. Document text
and folder-tree changes are committed atomically to the shared workspace Y.Doc
and synchronized through encrypted RoomWire v2 packets. `document.patch`
inputs must use the latest `baseSha256` from `tabula_read_workspace_document`
or `tabula_room_status`.

## Manual Smoke Check

After installing the MCPB in Claude Desktop:

1. Ask Claude: `Call tabula_read_me for document guidance.`
2. Ask Claude: `Create a Tabula.md document titled Release Notes.`
3. Confirm the inline view shows preview plus `Open in Tabula` and `Edit`.
4. Click `Edit`, update the title and Markdown, then click Save.
5. Ask Claude to call `tabula_list_documents` and confirm the saved document is
   listed.
6. Ask Claude to call `tabula_open_document` and confirm the App reopens it.
7. Click Send Changes and confirm Claude sees the edit summary.
8. Make one more small edit, click Share, and confirm Claude receives both a
   snapshot URL with `#json=` and a compact edit summary for the unsent change.
9. Open the share URL in Tabula.md and confirm the snapshot import flow starts.

If the App fails to open, verify that the MCPB contains `server/document-app.html`
and that `npm run check:mcpb` passes.
