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

## Tools

- `tabula_connect_room`: connect to a room URL. Read-only by default.
- `tabula_list_sessions`: list connected sessions in this MCP process.
- `tabula_room_status`: inspect connection state, room metadata, hash, and collaborators.
- `tabula_read_markdown`: read the current decrypted Markdown.
- `tabula_get_outline`: extract Markdown headings.
- `tabula_apply_text_patches`: edit with guarded non-overlapping text patches.
- `tabula_set_presence`: publish cursor/selection presence to collaborators.
- `tabula_wait_for_changes`: wait until the room text hash changes.
- `tabula_disconnect_room`: close a session.

## Editing Model

`tabula_connect_room` defaults to:

```json
{ "writeAccess": false }
```

To edit, connect with:

```json
{ "writeAccess": true }
```

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
