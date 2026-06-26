# Tabula MCP

Local MCP server for joining encrypted Tabula.md live rooms from Codex, Claude,
and other MCP clients.

Tabula MCP lets an agent read a shared Markdown room and, when explicitly
enabled, apply text patches back into the room. It keeps Tabula.md's room
security boundary intact: the room key is read from the URL fragment and used
inside this local MCP process. The Tabula Room server still receives only
encrypted envelopes.

## Status

Initial implementation. The server supports one-file live rooms, Markdown reads,
outline extraction, presence, and guarded text patches. Comment sync is not part
of this first version.

## Quick Start

Requirements:

- Node.js 22 or newer
- npm
- A reachable Tabula Room server

```sh
git clone git@github.com:tabula-md/tabula-mcp.git
cd tabula-mcp
npm install
npm run build
```

For local Tabula.md development links such as `http://localhost:5173/r/...`,
Tabula MCP defaults the room server to `http://localhost:3002`.

For hosted app links such as `https://tabula.md/r/...`, configure the room
service explicitly:

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
      "args": ["/absolute/path/to/tabula-mcp/dist/index.js"],
      "env": {
        "TABULA_ROOM_URL": "http://localhost:3002"
      }
    }
  }
}
```

Then ask the agent to call `tabula_connect_room` with a full room invite URL:

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

- `tabula_connect_room`: connect to a room URL using the server's current write mode. Read-only by default.
- `tabula_list_sessions`: list connected sessions in this MCP process.
- `tabula_room_status`: inspect connection state, room metadata, hash, and collaborators.
- `tabula_read_markdown`: read the current decrypted Markdown.
- `tabula_get_outline`: extract Markdown headings.
- `tabula_open_room_view`: open an MCP App Room View for status, outline, Markdown preview, refresh, and selection handoff in clients that support MCP Apps.
- `tabula_apply_text_patches`: edit with guarded non-overlapping text patches. Only exposed when the MCP process starts with write mode enabled.
- `tabula_set_presence`: publish cursor/selection presence to collaborators.
- `tabula_wait_for_changes`: wait until the room text hash changes.
- `tabula_disconnect_room`: close a session.

## MCP App Room View

Tabula MCP includes a progressive MCP Apps surface in the same package. After
connecting a room, call `tabula_open_room_view` to render an interactive
read-only view when the MCP client supports `text/html;profile=mcp-app`.

The Room View is bundled into `dist/room-view.html` during `npm run build`.
It does not replace the text tools: clients without MCP Apps support can keep
using `tabula_read_markdown`, `tabula_get_outline`, and
`tabula_apply_text_patches` normally.

The app uses an internal `tabula_app_room_snapshot` tool for refreshes. It is
marked app-only so model-facing tool lists stay focused, while the normal
read/write tools remain the compatibility path for Codex, Claude, and other
MCP clients.

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

## Validation

```sh
npm test
npm run build
```
