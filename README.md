# Tabula.md MCP

Connect Codex, Claude, and other MCP clients to shared Tabula.md workspaces.

It exposes three product concepts:

- **Draft** — a private Markdown draft stored by the MCP runtime.
- **Live Session** — an encrypted `#room` workspace that people and agents can edit together.
- **Copy** — an encrypted `#json` snapshot for a fixed handoff.

The model sees a file-oriented API. Room encryption, Yjs updates, document IDs, checkpoints, and patch offsets stay inside the server.

## Core workflow

Join an existing session:

```text
tabula_join_room
→ tabula_list_files
→ tabula_read_file
→ tabula_write_file
```

Start from a private draft:

```text
tabula_create_draft
→ tabula_update_draft
→ tabula_start_session
```

Hand off a fixed result:

```text
tabula_export_copy
→ https://tabula.md/#json=...
```

Use `Start Session` when collaborators should continue editing. Use `Export Copy` when the recipient should receive an immutable copy of the current state.

## Core tools

The default server exposes exactly nine model-facing tools:

| Tool | Purpose |
|---|---|
| `tabula_create_draft` | Create a private Markdown draft. |
| `tabula_update_draft` | Replace a private draft. |
| `tabula_start_session` | Turn a draft into a live encrypted session. |
| `tabula_join_room` | Join a private `#room` URL. |
| `tabula_list_files` | List session files and folders. |
| `tabula_read_file` | Read Markdown and its revision. |
| `tabula_search_files` | Search paths and content by line. |
| `tabula_write_file` | Create or replace a Markdown file. |
| `tabula_export_copy` | Export a draft or session as an encrypted `#json` copy. |

For an existing file, call `tabula_read_file` first and pass its `revision` as `expectedRevision` to `tabula_write_file`. The server rejects stale writes and computes the collaboration patch itself.

## Read-only resources

MCP clients can also read Draft and Session content through read-only resource templates:

```text
tabula://draft/{draftId}
tabula://session/{sessionId}
tabula://session/{sessionId}/file/{encodedPath}
```

The Session resource is a compact path and revision manifest. File resources return Markdown. Drafts are readable only when the client already knows the `draftId` returned by a tool; `resources/list` never enumerates a potentially shared Draft store. Resources do not expose room URLs, room keys, CRDT nodes, internal document IDs, or checkpoint state. Changes still go through `tabula_write_file`; tool results do not automatically attach a resource link for every file.

## Install

### Claude Desktop

Download the latest
[Tabula.md MCP extension](https://github.com/tabula-md/tabula-mcp/releases/latest/download/tabula-mcp.mcpb),
then install it by double-clicking the file or from **Settings → Extensions →
Advanced settings → Install Extension**.

For a local development build:

```sh
npm ci
npm run build:mcpb
```

Open `dist/tabula-mcp-0.2.2.mcpb` in Claude Desktop and restart Claude Desktop after replacing an older build.

### Claude Code or Codex CLI

Run the published stdio server:

```sh
npx -y @tabula-md/mcp@0.2.2
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "tabula": {
      "command": "npx",
      "args": ["-y", "@tabula-md/mcp@0.2.2"]
    }
  }
}
```

### Hosted MCP

Use the Streamable HTTP endpoint:

```text
https://mcp.tabula.md/mcp
```

The hosted runtime is a trusted plaintext participant in rooms it joins. Use the local MCPB when room plaintext and keys must remain on the user's device.

## Example prompt

```text
Use your Tabula tools to join this room and work with me.
Keep the room URL private.
If Tabula tools are unavailable, tell me to set up Tabula MCP.
https://tabula.md/#room=...
```

Expected behavior:

1. The agent calls `tabula_join_room`.
2. It lists files when the target is unknown.
3. It reads the selected file.
4. It writes once with the returned revision.
5. The browser sees the change immediately.

The model never constructs `changes[]`, `patches[]`, or text offsets.

## MCP App

Draft and Session tools can show a compact Tabula card in MCP Apps-capable hosts.

Draft actions:

- **Open a copy** — export and open an encrypted `#json` snapshot.
- **Start session** — create a live `#room` session.

Session actions:

- **Open session** — open the current live `#room` link.
- **Export copy** — export the current session state as a fixed `#json` snapshot.

The MCP App is a handoff card, not a second Markdown editor.

## Security model

- `#room` and `#json` URLs contain bearer secrets in their URL fragments.
- Do not echo a room URL after joining it.
- Room relays receive encrypted collaboration envelopes.
- JSON snapshot storage receives encrypted snapshot bytes.
- A local MCP runtime decrypts content on the user's device.
- A hosted MCP runtime decrypts content inside the hosted MCP process.
- Claude Desktop or the MCP host controls approval for mutating tool calls.
- Tabula does not require a second agent-specific write permission after the host approves a writable MCP call.

## Configuration

Common environment variables:

| Variable | Purpose |
|---|---|
| `TABULA_ROOM_URL` | Override the Room relay URL. |
| `TABULA_JSON_URL` | Override the encrypted JSON snapshot service. |
| `TABULA_MCP_AUTH_TOKEN` | Protect the hosted MCP endpoint. |
| `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` | Explicitly allow a public hosted endpoint. |
| `TABULA_MCP_DOCUMENT_STORE_DIR` | Override local draft storage. |

The local server is writable by default so the MCP host can govern approvals. Use `--read-only` to disable live session writes.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:app
npm run test:stdio
npm run check:context-budget
```

Run the full local Room and encrypted Copy browser flow when the sibling Tabula repositories are available:

```sh
npm run test:e2e:local-collab
```

Build and verify the extension:

```sh
npm run build:mcpb
npm run check:mcpb
```

## 0.2 migration

Version 0.2 intentionally removes the 0.1 tool surface. No legacy adapter is registered.

| 0.1 tool | 0.2 replacement |
|---|---|
| `tabula_create_document` | `tabula_create_draft` |
| `tabula_update_document` | `tabula_update_draft` |
| `tabula_create_workspace_room` | `tabula_start_session` |
| `tabula_connect_room` | `tabula_join_room` |
| `tabula_read_workspace` | `tabula_list_files` |
| `tabula_read_workspace_document` | `tabula_read_file` |
| `tabula_read_workspace_context` | `tabula_search_files` |
| `tabula_apply_workspace_changes` | `tabula_write_file` |
| `tabula_share_document`, `tabula_share_workspace` | `tabula_export_copy` |
| `tabula_read_me` | Server instructions |

Reinstall the MCPB or restart the MCP client after upgrading so cached tool and MCP App definitions are discarded.

## Privacy Policy

See the [Tabula.md MCP privacy policy](https://mcp.tabula.md/privacy) for plaintext trust boundaries, encrypted service data, and retention details.

## License

MIT
