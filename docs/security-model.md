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

`tabula_write_file` requires the revision returned by `tabula_read_file` for replacements. The server checks that revision immediately before applying the collaboration change and rejects stale writes.

The model never supplies Yjs updates, document IDs, or text patch offsets.

## Export

Draft and Session export use one `exportCopy()` service and the official `@tabula-md/tabula` schema-v2 serializer. This prevents the MCP App and model tool from producing incompatible `#json` payloads.

## MCP resources

Tabula registers read-only Draft, Session manifest, and Session file resource templates. Resource URIs contain only local draft or session handles and encoded file paths. Draft resources require a previously returned `draftId` and are not enumerable, preventing a hosted MCP session from listing a shared Draft store. Resources never contain `#room` or `#json` URLs, room keys, relay URLs, CRDT node identifiers, or checkpoint metadata. Resource reads share the same plaintext trust boundary as the corresponding MCP read tools, while all mutations remain tool calls governed by the MCP host.
