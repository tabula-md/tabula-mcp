# Security model

## Bearer-secret links

Tabula collaboration links contain secrets in URL fragments:

- `#room=<roomId>,<roomKey>` grants access to a live encrypted session.
- `#json=<snapshotId>,<snapshotKey>` grants access to a fixed encrypted copy.

The model must not echo a Room URL after joining. Exported Copy URLs should be produced only when the user requests a handoff.

## Encryption boundaries

- Room relays receive encrypted Yjs envelopes.
- JSON snapshot storage receives encrypted snapshot bytes.
- The key remains in the URL fragment and is not sent to those services as part of HTTP requests.
- A local MCPB decrypts content on the user's device.
- A hosted MCP service is a trusted plaintext participant for rooms it joins.

## Writes

The MCP server is writable by default. Claude Desktop, Claude Code, Codex, or another MCP host controls approval for mutating calls.

`tabula_write_files` and `tabula_edit_file` require revisions returned by
`tabula_read_files` when they change existing files. Moving, renaming, or
deleting a file is revision-guarded as well. The server validates existing
files before applying a collaboration transaction and rejects stale or
ambiguous changes without partially applying them. Deleting a non-empty
directory requires explicit recursive intent. Batch reads are limited to 20
files and 100,000 total characters; oversized reads fail without silently
truncating Markdown.

The model never supplies Yjs updates, document IDs, or text patch offsets.
Text edits are applied as incremental Yjs operations so unaffected collaborative
positions are preserved.

## Export

File and Session export use one `exportCopy()` service and the official `@tabula-md/tabula` schema-v2 serializer. This prevents the MCP App and model tool from producing incompatible `#json` payloads.

## Copy import

`tabula_import_copy` downloads encrypted bytes using the public snapshot ID,
decrypts them with the client-only fragment key, validates the schema, and
returns safe relative Markdown paths. It does not join a Room, persist a live
connection, or write to the local filesystem. Filesystem writes and overwrite
approval remain the MCP host's responsibility.

## MCP resources

Tabula registers read-only Session manifest and Session file resource templates. Resource URIs contain only session handles and encoded file paths. Resources never contain `#room` or `#json` URLs, room keys, relay URLs, CRDT node identifiers, or checkpoint metadata. Resource reads share the same plaintext trust boundary as the corresponding MCP read tools, while all mutations remain tool calls governed by the MCP host.
