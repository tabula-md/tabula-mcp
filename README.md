# Tabula MCP

Local MCP server and MCP App for drafting Tabula.md Markdown documents and
joining encrypted Tabula.md live rooms from Codex, Claude, and other MCP
clients.

Tabula MCP lets an agent create a local Markdown document in an MCP App, read a
shared Markdown room, and, when explicitly enabled, apply text patches back into
the room. It keeps Tabula.md's room security boundary intact: the room key is
read from the URL fragment and used inside this local MCP process. The Tabula
Room server still receives only encrypted envelopes.

## Status

Initial implementation. The server supports local MCP App documents, encrypted
share links for local documents, one-file live rooms, Markdown reads, outline
extraction, presence, and guarded text patches. Comment sync is not part of
this first version.

## Quick Start

Requirements:

- Node.js 22 or newer
- npm
- A Tabula.md room link or room server only if you want to open live rooms

```sh
git clone git@github.com:tabula-md/tabula-mcp.git
cd tabula-mcp
npm install
npm run build
```

For local Tabula.md development links such as `http://localhost:5173/r/...`,
Tabula MCP defaults the room server to `http://localhost:3002`.

For hosted Tabula.md links such as `https://tabula.md/r/...`, Tabula MCP
defaults the room server to `https://rooms.tabula.md`.

For self-hosted app links, configure the room service explicitly:

```sh
export TABULA_ROOM_URL=https://rooms.example.com
```

## MCP Client Configuration

Use the built server over stdio:

```json
{
  "mcpServers": {
    "tabula": {
      "command": "node",
      "args": ["/absolute/path/to/tabula-mcp/dist/index.js"]
    }
  }
}
```

Then ask the agent to create a document with `tabula_create_document`, or call
`tabula_connect_room` with a full room invite URL:

```txt
https://tabula.md/r/<roomId>#key=<roomKey>
```

The `#key` fragment is a secret. Anyone or any agent with that URL can decrypt
the room, and write access can edit it. Treat room links like bearer tokens.

Write access is disabled by default at the MCP process level. To start a
write-enabled server, opt in when launching the process:

```json
{
  "mcpServers": {
    "tabula": {
      "command": "node",
      "args": ["/absolute/path/to/tabula-mcp/dist/index.js"],
      "env": {
        "TABULA_ROOM_URL": "http://localhost:3002",
        "TABULA_MCP_ENABLE_WRITE": "1"
      }
    }
  }
}
```

You can also pass `--enable-write` in `args`. If both are present,
`--read-only` forces read-only mode.

## Tools

- `tabula_create_document`: create a local Tabula.md Markdown document and open the interactive MCP App editor in clients that support MCP Apps.
- `tabula_read_me`: return workflow guidance for documents, rooms, sharing, and security boundaries.
- `tabula_share_document`: export a local App document to an encrypted Tabula.md room link. The server receives only an encrypted snapshot; the room key stays in the returned URL fragment.
- `tabula_connect_room`: connect to a room URL using the server's current write mode. Read-only by default.
- `tabula_list_sessions`: list connected sessions in this MCP process.
- `tabula_room_status`: inspect connection state, room metadata, hash, and collaborators.
- `tabula_read_markdown`: read the current decrypted Markdown.
- `tabula_get_outline`: extract Markdown headings.
- `tabula_open_room_view`: open a connected room in the MCP App for status, outline, Markdown preview, refresh, and selection handoff in clients that support MCP Apps.
- `tabula_apply_text_patches`: edit with guarded non-overlapping text patches. Only exposed when the MCP process starts with write mode enabled.
- `tabula_set_presence`: publish cursor/selection presence to collaborators.
- `tabula_wait_for_changes`: wait until the room text hash changes.
- `tabula_disconnect_room`: close a session.

## MCP App Document

Tabula MCP includes a progressive MCP Apps surface in the same package. Call
`tabula_create_document` to open an editable local Markdown document when the
MCP client supports `text/html;profile=mcp-app`.

Call `tabula_read_me` once when the model needs to choose a Tabula.md workflow
or verify security boundaries. It returns concise topic-specific guidance for
local documents, encrypted rooms, sharing, and write policy.

The Document App is bundled into `dist/document-app.html` during `npm run build`.
It provides title editing, outline navigation, and Editor/Split/Preview modes
for local Markdown drafts. It also opens connected rooms through
`tabula_open_room_view` as a read-only room mode. It does not replace the text
tools: clients without MCP Apps support can keep using `tabula_read_markdown`,
`tabula_get_outline`, and `tabula_apply_text_patches` normally.

Local App documents are session-local: the saved copy lives in the local MCP
process and is lost when that process exits. The MCP App also keeps an unsaved
plaintext draft in the host browser's local storage, scoped by document id, so
refreshing or reopening the App can recover recent edits. Saving clears the
matching local draft. Exporting a local App document into an encrypted Tabula.md
share link is available through `tabula_share_document` and the App's `Share`
control.

The app uses internal `tabula_app_document_snapshot`,
`tabula_app_save_document`, and `tabula_app_room_snapshot` tools for App state.
They are marked app-only so model-facing tool lists stay focused, while the
normal read/write tools remain the compatibility path for Codex, Claude, and
other MCP clients.

For local App documents, the `Send Changes` control sends a compact Markdown
change summary back into model context. It uses changed ranges and bounded
excerpts instead of sending the whole document on every edit.

If a recovered browser draft differs from the latest saved MCP session snapshot,
the App marks the draft as restored or conflicted and asks the user to review it
before saving. This draft recovery is local to the MCP App host; it does not
upload plaintext Markdown to Tabula.md room infrastructure.

The `Share` control saves the current App document into the local MCP session,
then uploads only an encrypted Yjs snapshot to the Tabula Room server. It sends
the resulting `https://tabula.md/r/...#key=...` link back into model context.
Treat that link as a bearer secret.

## Claude Desktop MCPB

For Claude Desktop experiments, build a one-click MCP Bundle:

```sh
npm run build:mcpb
```

The bundle is written to `dist/tabula-mcp-<version>.mcpb`. Install it by
double-clicking the file, dragging it into Claude Desktop, or using
Settings -> Extensions -> Advanced settings -> Install Extension.

No installation settings are required for normal use. After installation, create
a local document with `tabula_create_document` or connect a room with
`tabula_connect_room`. Hosted `https://tabula.md/r/...` links use
`https://rooms.tabula.md`, and local development links use
`http://localhost:3002`. Clients that support MCP Apps can then open the
interactive Tabula.md document surface. To share a local App document, use the
App's `Share` control or ask the model to call `tabula_share_document`; this
creates an encrypted room snapshot without installer configuration.

The MCPB is intentionally read-only. Use manual MCP client configuration with
`TABULA_MCP_ENABLE_WRITE=1` only for explicit write-enabled development or
review sessions.

## Editing Model

Editing is a server startup decision, not a per-tool argument. In the default
read-only mode, the MCP server does not expose `tabula_apply_text_patches`, so
an agent cannot grant itself write access by changing `tabula_connect_room`
arguments.

To edit, start the MCP process with `TABULA_MCP_ENABLE_WRITE=1` or
`--enable-write`, then connect to the room normally.

Edits must use `tabula_apply_text_patches` with the latest `baseSha256` returned
by `tabula_read_markdown` or `tabula_room_status`. This avoids blind full-file
overwrites when another collaborator has changed the room.

Patch offsets are JavaScript string offsets in the old document:

```json
{
  "baseSha256": "...",
  "patches": [
    { "from": 0, "to": 0, "insert": "# Draft\n\n" }
  ]
}
```

## Security Boundary

Tabula MCP is intentionally local. It decrypts Markdown because the user gives
the MCP client a room URL containing `#key=...`. Do not run it as a shared
hosted service unless you are deliberately moving the plaintext trust boundary
to that service.

The Tabula Room server must not receive:

- room keys
- plaintext Markdown
- decrypted Yjs updates
- decrypted presence payloads

Local App draft recovery stores plaintext Markdown in the MCP App host browser's
local storage. This is intended only as local recovery for Claude Desktop or
another trusted local MCP Apps host, and is separate from encrypted room
sharing.

`tabula_share_document` creates a room id and 32-byte room key locally, encrypts
the local Markdown as a Yjs snapshot, and uploads only that encrypted envelope to
the configured room server. The returned share URL includes the room key in the
fragment, so it should be shared only with intended collaborators or agents.

## Validation

```sh
npm test
npm run build
```
