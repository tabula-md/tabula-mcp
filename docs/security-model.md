# Security Model

Tabula.md MCP can run as a local stdio/MCPB server or as a remote Streamable
HTTP MCP endpoint. In both modes, MCP document checkpoints are agent working
state and may contain plaintext Markdown. This is separate from Tabula.md core
services: `tabula-room` remains an encrypted relay, and `tabula-json` remains an
encrypted snapshot blob store.

## Trust Boundary

Trusted local boundary:

- MCP client process, such as Claude Desktop
- local `tabula-mcp` stdio server process
- MCP App webview storage controlled by the local host

Trusted remote MCP boundary, only when explicitly deployed:

- remote `tabula-mcp` HTTP process
- configured MCP document checkpoint store, such as Upstash Redis or Vercel KV
- MCP clients allowed to connect to that endpoint

Untrusted or remote boundary:

- Tabula Room server
- Tabula JSON snapshot service
- network intermediaries
- issue trackers, logs, public transcripts, screenshots, and telemetry

The MCP process can decrypt room Markdown because the user gave it a room URL
containing a `#room` fragment with the room key. Running Tabula MCP as a shared
hosted service deliberately moves MCP App document checkpoint plaintext, and any
room plaintext supplied to that MCP service, into the hosted MCP trust boundary.

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

## Snapshot Links

A Tabula.md encrypted snapshot URL has this shape:

```txt
https://tabula.md/#json=<snapshotId>,<snapshotKey>
```

The `#json` fragment contains the snapshot key and is a bearer secret. The
Tabula JSON snapshot service receives the snapshot id and encrypted bytes, not
the key or plaintext Markdown.

## MCP Document Checkpoints

`tabula_create_document` creates a document checkpoint in the MCP server's
document registry. Checkpoints are plaintext working state so the agent and MCP
App can continue editing without re-sending the full Markdown document on every
turn.

Local stdio/MCPB default checkpoint locations:

- macOS: `~/Library/Application Support/Tabula.md MCP/documents`
- Windows: `%LOCALAPPDATA%\Tabula.md MCP\documents`
- Linux: `$XDG_STATE_HOME/tabula-mcp/documents` or `~/.local/state/tabula-mcp/documents`

Set `TABULA_MCP_DOCUMENT_STORE_DIR` to choose a different local plaintext
checkpoint directory. Set `TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS=1` to keep
saved local documents memory-only for the MCP server session.
Use `tabula_list_documents` and `tabula_open_document` to resume checkpoints in
MCP Apps clients.

Remote HTTP mode is selected with `TABULA_MCP_DEPLOYMENT_MODE=remote` or by
starting the CLI with `--http`. It defaults to an in-process TTL memory
checkpoint store. For durable remote checkpoints, configure Upstash Redis or
Vercel KV-compatible REST credentials. These records are still plaintext MCP
working state; they are not Tabula JSON encrypted snapshots.

Remote checkpoint controls:

- `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory|redis`
- `TABULA_MCP_ALLOW_MEMORY_STORE=1`, unsafe production override only when `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory`
- `TABULA_MCP_DOCUMENT_TTL_SECONDS`, default 30 days
- `TABULA_MCP_MAX_DOCUMENT_CHECKPOINTS`, default 20
- `TABULA_MCP_REDIS_REST_URL` / `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL`
- `TABULA_MCP_REDIS_REST_TOKEN` / `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN`

Production/public HTTP controls:

- `TABULA_MCP_PRODUCTION=1` or Vercel production runtime enables fail-fast production guardrails.
- `TABULA_MCP_AUTH_TOKEN` is required in production unless `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` is set.
- `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` makes production remote MCP public/no-auth for anonymous document workflows, ignores any configured auth token, forces stateless HTTP, blocks remote room tools, and requires Redis checkpoints.
- Production remote mode requires Redis/Upstash REST credentials by default.
- Production memory checkpoints require explicit unsafe opt-in with `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory` and `TABULA_MCP_ALLOW_MEMORY_STORE=1`.
- Production browser requests with an `Origin` header are rejected unless the origin is in `TABULA_MCP_ALLOWED_ORIGINS`.
- Production remote document workflows default to stateless HTTP when hosted room tools are disabled.
- `TABULA_MCP_RATE_LIMIT_MAX` / `TABULA_MCP_RATE_LIMIT_WINDOW_MS` throttle per-client MCP requests.
- `TABULA_MCP_MAX_ACTIVE_SESSIONS` / `TABULA_MCP_SESSION_IDLE_TTL_MS` bound in-memory MCP transport sessions.
- `TABULA_MCP_HTTP_MAX_REQUEST_BYTES` limits MCP request bodies.
- `TABULA_MCP_REQUEST_TIMEOUT_MS` limits individual request handling.
- `TABULA_MCP_LOG_LEVEL` enables structured JSON request logs.
- `TABULA_MCP_ALLOW_REMOTE_ROOM=1` is required before hosted production exposes room connection tools.
- `TABULA_MCP_STATELESS_HTTP=1` forces stateless HTTP sessions for serverless document workflows.
- `TABULA_MCP_STATEFUL_HTTP=1` forces stateful HTTP sessions and should only be used with sticky routing, a single instance, or a session coordinator.

The Document App also stores unsaved plaintext drafts in the local MCP App
host's browser storage. Draft recovery is scoped by document id, size-limited,
and pruned. This is local recovery only; it is not encrypted room persistence
and is not uploaded to Tabula.md servers.

Implications:

- local document checkpoints may persist after the MCP server exits
- local browser drafts may persist after closing or reopening the App host
- memory-only mode loses saved MCP session documents when the MCP server exits
- remote Redis/KV checkpoints persist until TTL or explicit deletion
- users should share/export when they want an encrypted Tabula.md snapshot link

## Encrypted Share

`tabula_share_document` turns a local App document into an encrypted Tabula.md
snapshot link.

The share flow is:

1. Generate a 32-byte snapshot key locally.
2. Serialize the Markdown as a Tabula JSON snapshot locally.
3. Encrypt the snapshot locally with the snapshot key.
4. Upload only encrypted bytes to the JSON snapshot service.
5. Return a Tabula.md URL containing the snapshot key in the `#json` fragment.

The returned URL is useful for handoff/import, but it is also a bearer secret.
Only send it to intended collaborators or agents.

## Room Write Policy

Direct room write access is a server startup decision. The default MCPB and
default stdio server are proposal-first for rooms: they can send encrypted patch
proposals, but they do not expose direct write tools.

Hosted production remote servers do not expose room connection tools by default
because a remote MCP server that joins a room becomes a trusted plaintext
processor for the room key and decrypted Markdown. Set
`TABULA_MCP_ALLOW_REMOTE_ROOM=1` only when that trust boundary is intentional.
Remote room tools also require stateful HTTP sessions; stateless production mode
is for document checkpoints and encrypted snapshot sharing, not live room
connections.

Write mode requires one of:

- `TABULA_MCP_ENABLE_WRITE=1`
- `--enable-write`

`--read-only` forces read-only mode even if another setting enables writes.

When write mode is disabled, `tabula_apply_text_patches` is not exposed to the
model. An agent cannot grant itself direct write access by changing tool
arguments. It can still use `tabula_propose_workspace_changes` to send an
encrypted `workspace.proposal.created` event for collaborators to review, or
`tabula_propose_text_patches` for legacy single-document `patch.proposed`
events.

Patch proposals and direct room edits must use guarded text patches with the
latest `baseSha256`. The value is lowercase SHA-256 hex and maps to Tabula.md's
room collaboration hash contract. Workspace proposals use the same hash guard
inside each `document.patch` change. This prevents blind full-document
overwrites when another collaborator has changed the room.

## Release Blockers

Treat these as release blockers:

- MCPB manifest contains installer `user_config`
- MCPB prompts for room keys, room URLs, or write settings
- room key appears in request bodies sent to the room server
- snapshot key appears in request bodies sent to the JSON snapshot service
- plaintext Markdown is uploaded during share/export
- remote HTTP mode silently uses local file checkpoints
- official hosted production uses `TABULA_MCP_ALLOW_MEMORY_STORE=1`
- public unauthenticated production exposes remote room tools
- production HTTP allows wildcard browser origins by default
- docs imply that remote MCP checkpoints are encrypted Tabula JSON snapshots
- `tabula_apply_text_patches` is exposed in default proposal-first mode
- docs or tool descriptions imply that `#room` or `#json` links are safe to publish
