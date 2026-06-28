# Security Model

Tabula.md MCP is a local MCP server. It intentionally moves plaintext Markdown
into the user's local MCP client and local MCP process, not into Tabula.md room
infrastructure.

## Trust Boundary

Trusted local boundary:

- MCP client process, such as Claude Desktop
- local `tabula-mcp` stdio server process
- MCP App webview storage controlled by the local host

Untrusted or remote boundary:

- Tabula Room server
- network intermediaries
- issue trackers, logs, public transcripts, screenshots, and telemetry

The local MCP process can decrypt room Markdown because the user gave it a room
URL containing a `#room` fragment with the room key. Do not run this server as a shared hosted service
unless you deliberately want that hosted service to become the plaintext trust
boundary.

## Room Links

A Tabula.md room URL has this shape:

```txt
https://tabula.md/#room=<roomId>,<roomKey>
```

The `#room` fragment contains the room key and is a bearer secret. Anyone or
any agent with the full URL can decrypt the room. Treat it like an access token.

The Tabula Room server must not receive:

- room keys
- plaintext Markdown
- decrypted Yjs updates
- decrypted presence payloads

The app origin and room server URL are separate. The app URL is the human-facing
Tabula.md link. The room server URL is the encrypted envelope transport.

## Local Documents

`tabula_create_document` creates a local document in the MCP server's document
registry. By default, saved local documents are checkpointed as plaintext files
in this machine's local application state so a restarted MCP process can recover
the latest documents.

Default checkpoint locations:

- macOS: `~/Library/Application Support/Tabula.md MCP/documents`
- Windows: `%LOCALAPPDATA%\Tabula.md MCP\documents`
- Linux: `$XDG_STATE_HOME/tabula-mcp/documents` or `~/.local/state/tabula-mcp/documents`

Set `TABULA_MCP_DOCUMENT_STORE_DIR` to choose a different local plaintext
checkpoint directory. Set `TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS=1` to keep
saved local documents memory-only for the MCP server session.
Use `tabula_list_documents` and `tabula_open_document` to resume checkpoints in
MCP Apps clients.

The Document App also stores unsaved plaintext drafts in the local MCP App
host's browser storage. Draft recovery is scoped by document id, size-limited,
and pruned. This is local recovery only; it is not encrypted room persistence
and is not uploaded to Tabula.md servers.

Implications:

- local document checkpoints may persist after the MCP server exits
- local browser drafts may persist after closing or reopening the App host
- memory-only mode loses saved MCP session documents when the MCP server exits
- users should share/export when they want a durable Tabula.md room link

## Encrypted Share

`tabula_share_document` turns a local App document into an encrypted Tabula.md
room snapshot.

The share flow is:

1. Generate a room id locally.
2. Generate a 32-byte room key locally.
3. Encode the Markdown as a Yjs snapshot locally.
4. Encrypt the snapshot locally with the room key.
5. Upload only the encrypted envelope to the room server.
6. Return a Tabula.md URL containing the room key in the `#room` fragment.

The returned URL is useful for collaboration, but it is also a bearer secret.
Only send it to intended collaborators or agents.

## Room Write Policy

Room write access is a server startup decision. The default MCPB and default
stdio server are read-only for rooms.

Write mode requires one of:

- `TABULA_MCP_ENABLE_WRITE=1`
- `--enable-write`

`--read-only` forces read-only mode even if another setting enables writes.

When write mode is disabled, `tabula_apply_text_patches` is not exposed to the
model. An agent cannot grant itself write access by changing tool arguments.

When write mode is enabled, room edits must use guarded text patches with the
latest `baseSha256`. This prevents blind full-document overwrites when another
collaborator has changed the room.

## Release Blockers

Treat these as release blockers:

- MCPB manifest contains installer `user_config`
- MCPB prompts for room keys, room URLs, or write settings
- room key appears in request bodies sent to the room server
- plaintext Markdown is uploaded during share/export
- `tabula_apply_text_patches` is exposed in default read-only mode
- docs or tool descriptions imply that `#room` links are safe to publish
