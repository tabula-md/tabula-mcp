# Tabula MCP

MCP server and MCP App for drafting Tabula.md Markdown documents and joining
encrypted Tabula.md live rooms from Codex, Claude, and other MCP clients.

Tabula MCP lets an agent create a Markdown document checkpoint in an MCP App,
join a shared Tabula workspace room, and apply hash-guarded workspace document
changes as an agent collaborator. MCP document checkpoints are agent working state. Live room
recovery uses encrypted workspace room checkpoints when Firebase is configured.
Final handoff links still use Tabula.md's encrypted JSON snapshot flow, where
the JSON service receives only encrypted bytes and the snapshot key stays in the
`#json` fragment.

## Status

Early implementation. The server supports MCP App document checkpoints,
encrypted share links for App documents, encrypted workspace rooms, presence,
direct workspace collaboration events, bounded selection/change handoff from the bundled App,
stdio/MCPB local launch, and a Streamable HTTP `/mcp` endpoint for remote
deployments. The repository is MIT-licensed and contains the same deployment
entrypoints intended for self-hosting and the official hosted Tabula MCP
endpoint.

## Documentation

- [Codex CLI](docs/codex-cli.md): local stdio setup, approval behavior, and room workflow checks.
- [Claude Desktop](docs/claude-desktop.md): MCPB build, install, and manual smoke test.
- [Deployment](docs/deployment.md): Vercel and Cloudflare hosted MCP targets.
- [Security Model](docs/security-model.md): local trust boundary, room keys, share/export, and write policy.
- [MCP App Architecture](docs/mcp-app-architecture.md): bundled App shape, tool visibility, and source layout.
- [Release](docs/release.md): validation commands, MCPB checks, runtime support, and handoff notes.

## Quick Start

Requirements:

- Node.js `^20.19.0 || >=22.12.0`
- npm
- A Tabula.md room link or room server only if you want to open live rooms
- A Tabula JSON snapshot service only if you want to create encrypted snapshot
  share links
- Firebase Web config only if you want live room checkpoint recovery without an
  active peer

```sh
git clone git@github.com:tabula-md/tabula-mcp.git
cd tabula-mcp
npm install
npm run build
```

For local Tabula.md development links such as `http://localhost:5173/#room=...`,
Tabula MCP defaults the room server to `http://localhost:3002`.

For hosted Tabula.md links such as `https://tabula.md/#room=...`, Tabula MCP
defaults the room server to `https://rooms.tabula.md`.

For self-hosted app links, configure the room service explicitly:

```sh
export TABULA_ROOM_URL=https://rooms.example.com
```

For durable live room recovery, configure the same Firebase Web SDK config used
by Tabula.md. The complete Y.Doc update is encrypted locally with the `#room`
key before Firebase Storage receives it; Firestore stores only the opaque blob
pointer and generation:

```sh
export VITE_TABULA_FIREBASE_CONFIG='{"apiKey":"...","projectId":"..."}'
```

For hosted encrypted snapshot share links, Tabula MCP defaults the JSON
snapshot service to `https://json.tabula.md`. For local Tabula.md development
links such as `http://localhost:5173`, it defaults to `http://localhost:3004`.
For self-hosted app links, configure the snapshot service explicitly:

```sh
export TABULA_JSON_URL=https://json.example.com
```

## MCP Client Configuration

Use the built server over stdio for local MCP clients:

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

Then ask the agent to create a document checkpoint with `tabula_create_document`, or call
`tabula_connect_room` with a full room invite URL:

```txt
https://tabula.md/#room=<roomId>,<roomKey>
```

The `#room` fragment contains the room key and is a secret. Anyone or any agent
with that URL can decrypt the room. Treat room links like bearer tokens.

Agents edit the same workspace Y.Doc that Tabula.md uses. A Tabula room is a
workspace room; a one-document room is represented as a workspace with one
document. Agents use `tabula_apply_workspace_changes` to apply one atomic Yjs
transaction across the workspace tree and document texts. `document.patch` inputs
must include the latest lowercase SHA-256 hex `baseSha256` returned by the read
tools.

For the one-click Claude Desktop path, use the MCPB flow instead. It is
zero-config and uses the same direct workspace collaboration surface.

## Remote HTTP MCP

Official hosted target:

```txt
https://mcp.tabula.md/mcp
```

The official hosted endpoint is intended to match Tabula.md's no-login product
shape: MCP clients can connect without a bearer token. It exposes the same
agent workspace surface as local stdio where the runtime can support it:
workspace creation/import from inline files, encrypted JSON snapshot export,
new room creation, and existing room connection. Room and workspace tools require
stateful MCP HTTP sessions because the MCP server keeps active room transports
and workspace state between tool calls.

This repository contains the deployable code for that shape. Domain binding,
secrets, Redis/Upstash credentials, logs, and abuse controls live in the hosting
environment, not in the repository.

To run a local Excalidraw-style remote MCP endpoint, start the built package
with `--http`:

```sh
npm run build
TABULA_MCP_DEPLOYMENT_MODE=remote \
node dist/index.js --http --port 3005
```

The endpoint is available at:

```txt
http://localhost:3005/mcp
```

Remote mode deliberately treats MCP document checkpoints as agent working state.
Those checkpoints may contain plaintext Markdown because the MCP server and App
need the current draft to continue editing. This is separate from Tabula's
encrypted share/export path:

```txt
working draft/edit state -> MCP document checkpoint store
final handoff link      -> tabula-json encrypted #json snapshot
live collaboration      -> tabula-room encrypted relay
live room recovery      -> Firebase encrypted workspace room checkpoint
```

By default, remote mode uses an in-process TTL memory checkpoint store. For a
durable production deployment, configure Upstash Redis or Vercel KV-compatible
REST credentials:

```sh
TABULA_MCP_DEPLOYMENT_MODE=remote \
TABULA_MCP_PRODUCTION=1 \
TABULA_MCP_PUBLIC_UNAUTHENTICATED=1 \
TABULA_MCP_ALLOWED_ORIGINS='https://tabula.md' \
UPSTASH_REDIS_REST_URL=https://... \
UPSTASH_REDIS_REST_TOKEN=... \
node dist/index.js --http --port 3005
```

Supported remote checkpoint environment variables:

- `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory|redis`
- `TABULA_MCP_ALLOW_MEMORY_STORE=1` allows `memory` in production only when `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory` is also set
- `TABULA_MCP_DOCUMENT_TTL_SECONDS` defaults to 30 days
- `TABULA_MCP_MAX_DOCUMENT_CHECKPOINTS` defaults to 20
- `TABULA_MCP_REDIS_REST_URL` or `UPSTASH_REDIS_REST_URL` or `KV_REST_API_URL`
- `TABULA_MCP_REDIS_REST_TOKEN` or `UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_TOKEN`
- `TABULA_MCP_REDIS_KEY_PREFIX` defaults to `tabula-mcp:documents`

`GET /health` returns process-level service metadata. `GET /ready` checks that
the active checkpoint store can be reached.

`TABULA_MCP_ALLOWED_ORIGINS` can be set to a comma-separated browser origin
allowlist. In development, unset origins allow custom browser MCP connector
testing. In production, browser requests with an `Origin` header are rejected
unless that origin is explicitly listed. Server-to-server clients that do not
send `Origin` are still allowed through the Origin gate.

Production/public endpoint controls:

- `TABULA_MCP_PRODUCTION=1` or Vercel production runtime enables production guardrails.
- `TABULA_MCP_AUTH_TOKEN` is required in production unless `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` is set.
- `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` makes production remote MCP public/no-auth and ignores any stale auth token secret.
- Production remote mode requires Redis/Upstash REST credentials by default.
- Production memory checkpoints require explicit unsafe opt-in with `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory` and `TABULA_MCP_ALLOW_MEMORY_STORE=1`.
- `TABULA_MCP_RATE_LIMIT_MAX` and `TABULA_MCP_RATE_LIMIT_WINDOW_MS` control per-client request throttling.
- `TABULA_MCP_MAX_ACTIVE_SESSIONS` and `TABULA_MCP_SESSION_IDLE_TTL_MS` bound in-memory MCP sessions.
- `TABULA_MCP_HTTP_MAX_REQUEST_BYTES` limits MCP request body size.
- `TABULA_MCP_REQUEST_TIMEOUT_MS` bounds individual MCP request handling.
- `TABULA_MCP_ALLOWED_ROOM_SERVER_URLS` and `TABULA_MCP_ALLOWED_JSON_SERVER_URLS` allow additional production egress targets for trusted self-hosted Tabula services.
- `TABULA_MCP_FIREBASE_CONFIG`, `TABULA_FIREBASE_CONFIG`, or `VITE_TABULA_FIREBASE_CONFIG` enables encrypted live room checkpoint blobs in Firebase Storage with generation pointers in Firestore.
- `TABULA_MCP_ALLOWED_IMPORT_ROOTS` allows comma- or newline-separated local directories for `tabula_import_markdown_workspace` when the MCP client does not provide MCP filesystem roots. Prefer MCP roots where supported; use `source.files` in hosted clients.
- `TABULA_MCP_ALLOW_ANY_EGRESS=1` disables production egress allowlists for a trusted self-hosted deployment.
- `TABULA_MCP_LOG_LEVEL=silent|error|warn|info|debug` controls structured JSON request logs.
- `TABULA_MCP_STATELESS_HTTP=1` is rejected for remote deployments because room/workspace tools require stateful MCP sessions.
- `TABULA_MCP_STATEFUL_HTTP=1` forces stateful HTTP sessions; Cloudflare routes sessions through `TabulaMcpSessionDurableObject`, while other platforms need sticky routing, a single instance, or an external session coordinator.

Vercel and Cloudflare deployment targets are included:

- Vercel: `vercel.json`, `api/mcp.ts`, `api/health.ts`, `api/ready.ts`
- Cloudflare Workers: `wrangler.jsonc`, `workers/tabula-mcp-worker.ts`, and `TabulaMcpSessionDurableObject` for MCP session affinity

Use `npm run check:deploy-targets` before deploying. See
[Deployment](docs/deployment.md) for environment variables, secrets, and session
boundary notes.

Use `npm run measure:mcp-context` when changing tool descriptions, schemas, or
large result payloads. `npm run check:context-budget` is part of
`release:verify` and keeps the MCP catalog and default workspace results within
agent context budgets.

## Package Exports

The package is primarily a `tabula-mcp` stdio server, but it also exposes a
small ESM surface for tests and local embedding:

- `@tabula-md/mcp`: stdio/HTTP server factories plus document-store helpers
- `@tabula-md/mcp/server`: stdio/HTTP server factories and write-mode helpers
- `@tabula-md/mcp/protocol`: room URL and room server resolution helpers
- `@tabula-md/mcp/documents`: document registry, snapshots, and checkpoint stores

## Tools

- `tabula_create_document`: create a Tabula.md Markdown document checkpoint and open the interactive MCP App editor in clients that support MCP Apps.
- `tabula_list_documents`: list Tabula.md document checkpoints in this MCP server.
- `tabula_open_document`: open the latest or selected document checkpoint in the MCP App editor.
- `tabula_read_me`: return workflow guidance for documents, rooms, sharing, and security boundaries.
- `tabula_share_document`: export an App document checkpoint to an encrypted Tabula.md snapshot link. The JSON snapshot service receives only encrypted bytes; the snapshot key stays in the returned `#json` URL fragment.
- `tabula_create_workspace`: create a local MCP workspace from zero or more inline Markdown files.
- `tabula_import_markdown_workspace`: import Markdown files into a local MCP workspace from an inline files array, or from a local filesystem path allowed by MCP roots or `TABULA_MCP_ALLOWED_IMPORT_ROOTS`.
- `tabula_share_workspace`: export a workspace as an encrypted multi-file Tabula.md `#json` snapshot link.
- `tabula_create_workspace_room`: create a new encrypted Tabula.md live room from a workspace, publish workspace metadata and document state, save an encrypted live room checkpoint when Firebase is configured, and return a `#room` URL.
- `tabula_connect_room`: connect to a room URL as a `tabula-mcp` agent actor and load the encrypted live room checkpoint when Firebase is configured.
- `tabula_list_sessions`: list connected sessions in this MCP process.
- `tabula_room_status`: inspect connection state, room metadata, hash, actor capabilities, and collaborators.
- `tabula_read_workspace`: read decrypted workspace tree metadata from a connected room session or a local/imported MCP workspace, including document ids, titles, hashes, paths, and cache status.
- `tabula_read_workspace_document`: read decrypted Markdown for one cached workspace document from a room session or local/imported workspace.
- `tabula_read_workspace_context`: read bounded Markdown excerpts from selected, searched, path-filtered, or changed cached workspace documents for agent planning without loading every document in full.
- `tabula_apply_workspace_changes`: apply multi-document `document.patch`/`document.create`/`document.rename`/`document.move`/`document.delete` inputs atomically to the connected workspace CRDT.
- `tabula_open_room_view`: open a connected room in the MCP App for status, outline, Markdown preview, refresh, and selection handoff in clients that support MCP Apps.
- `tabula_set_presence`: publish cursor/selection presence to collaborators.
- `tabula_wait_for_changes`: wait until the active document hash or workspace CRDT changes, returning document hash summaries.
- `tabula_disconnect_room`: close a session.

## Resources

Tabula MCP remains tool-first so Claude Desktop, Claude Code, Codex, and other
tool-oriented MCP clients can use the full workflow. For clients that also
support MCP resources, the server exposes read-only workspace mirrors:

- `tabula://workspace/{workspaceId}`: workspace tree metadata JSON for a
  local/imported MCP workspace.
- `tabula://workspace/{workspaceId}/document/{documentId}`: Markdown text for a
  local/imported workspace document.
- `tabula://room/{sessionId}/workspace`: workspace tree metadata JSON for a
  connected room session.
- `tabula://room/{sessionId}/document/{documentId}`: cached Markdown text for a
  connected room document.

Workspace tools return these `resourceUri` values when available. Resource URIs
never include `#room` keys or encrypted share secrets; they are only handles to
state already held by this MCP server session. If a client ignores resources,
use `tabula_read_workspace`, `tabula_read_workspace_context`, and
`tabula_read_workspace_document`.

## Context Budget

Tabula MCP is tool-first, but tool catalogs are part of the model context in
many clients. Keep tool definitions concise and avoid exposing large output
schemas in `tools/list`. Tool results return exact machine-readable data in
`structuredContent`; large results use a short `content` summary plus
`resource_link` entries instead of duplicating the full JSON as text.

Default workspace reads are summary-first. `tabula_create_workspace`,
`tabula_import_markdown_workspace`, and `tabula_read_workspace` omit the full
workspace node tree unless `detail: "tree"` is passed. Use
`tabula_read_workspace_context` for bounded excerpts and
`tabula_read_workspace_document` only when exact full Markdown is needed.
`tabula_wait_for_changes` omits active-document Markdown by default; pass
`includeMarkdown: true` only when the caller needs it.

Current release budget checks:

- tool-only `tools/list`: <= 24 KB
- MCP App-capable `tools/list`: <= 32 KB
- 20-file default workspace context result: <= 12 KB
- 2 KB document read result: <= 4 KB

## MCP App Document

Tabula MCP includes a progressive MCP Apps surface in the same package. Call
`tabula_create_document` to open an editable Markdown document checkpoint when the
MCP client supports `text/html;profile=mcp-app`.

Call `tabula_read_me` once when the model needs to choose a Tabula.md workflow
or verify security boundaries. It returns concise topic-specific guidance for
local documents, encrypted rooms, sharing, and write policy.

The Document App is bundled into `dist/document-app.html` during `npm run build`.
Inline mode shows a Markdown preview with `Open in Tabula` and `Edit` actions.
Editing happens in fullscreen, where the App provides title editing, outline
context, and Editor/Split/Preview modes for local Markdown drafts. It also opens connected rooms through
`tabula_open_room_view` as a read-only room mode. It does not replace the
workspace room tools: clients without MCP Apps support can keep using
`tabula_read_workspace`, `tabula_read_workspace_document`, and
`tabula_apply_workspace_changes` normally. Agents can also create/import a
workspace first, share it as an encrypted `#json` link, or create a fresh live
room with `tabula_create_workspace_room`.

Local stdio/MCPB App documents are checkpointed as plaintext files in this
machine's local application state so the MCP server can recover them across
process restarts.
Set `TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS=1` to make local documents
memory-only for a server session, or `TABULA_MCP_DOCUMENT_STORE_DIR` to choose a
different local checkpoint directory. The MCP App also keeps an unsaved
plaintext draft in the host browser's local storage, scoped by document id, so
refreshing or reopening the App can recover recent edits. Saving clears the
matching local draft.

Remote HTTP deployments use a checkpoint store selected by
`TABULA_MCP_DEPLOYMENT_MODE=remote`: in-process TTL memory by default, or
Upstash Redis/Vercel KV REST when configured. These remote checkpoints are
plaintext MCP working state, not encrypted Tabula JSON snapshots. Exporting an
App document into an encrypted Tabula.md share link is available through
`tabula_share_document` and the App's `Share` control.

The app uses internal `tabula_app_document_snapshot`,
`tabula_app_save_document`, and `tabula_app_room_snapshot` tools for App state.
They are marked app-only so model-facing tool lists stay focused, while the
normal read/write tools remain the compatibility path for Codex, Claude, and
other MCP clients.

For MCP App document checkpoints, the `Send Changes` control sends a compact
Markdown change summary back into model context. It uses changed ranges and
bounded excerpts instead of sending the whole document on every edit.

The `Send Selection` control similarly bounds large selections to a head/tail
excerpt with truncation metadata instead of sending the full selected text.

If a recovered browser draft differs from the latest saved MCP session snapshot,
the App marks the draft as restored or conflicted and asks the user to review it
before saving. This draft recovery is local to the MCP App host; it does not
upload plaintext Markdown to Tabula.md room infrastructure.

The `Share` control saves the current App document into the MCP checkpoint
store, then uploads only encrypted snapshot bytes to the Tabula JSON snapshot
service.
It sends the resulting `https://tabula.md/#json=...,...` link back into model
context. If the user has unsent App edits, the share handoff also includes the
same compact change summary used by `Send Changes`, so the model can understand
what changed without receiving the full Markdown body.
Treat that link as a bearer secret.

See [MCP App Architecture](docs/mcp-app-architecture.md) for the bundled App
resource structure and [Security Model](docs/security-model.md) for plaintext
and room key boundaries.

## Claude Desktop MCPB

For Claude Desktop experiments, build a one-click MCP Bundle:

```sh
npm run release:pack
```

The bundle includes `assets/icon.png` for Claude Desktop extension listings and
is written to `dist/tabula-mcp-<version>.mcpb`, with a matching
`dist/tabula-mcp-<version>.mcpb.sha256` checksum. Install the `.mcpb` by
double-clicking the file, dragging it into Claude Desktop, or using Settings ->
Extensions -> Advanced settings -> Install Extension.

No installation settings are required for normal use. After installation, create
a document with `tabula_create_document` or connect a room with
`tabula_connect_room`. Hosted `https://tabula.md/#room=...` links use
`https://rooms.tabula.md`, and local development links use `http://localhost:3002`.
Set `VITE_TABULA_FIREBASE_CONFIG` or `TABULA_FIREBASE_CONFIG` in manual stdio
configuration when local agents should restore encrypted live room checkpoints
without waiting for an active browser peer.
Clients that support MCP Apps can then open the interactive Tabula.md document
surface. To share an App document checkpoint, use the App's `Share` control or
ask the model to call `tabula_share_document`; this creates an encrypted JSON
snapshot link without installer configuration.

The MCPB exposes the same direct workspace room tool surface as the stdio
server. Room edits still require hash-guarded `document.patch` inputs, and the
room server only sees encrypted `room-event` envelopes.

For step-by-step installation and manual verification, see
[Claude Desktop](docs/claude-desktop.md).

## Runtime Support

The stdio server and npm package are intended to run on macOS, Windows, and
Linux with Node.js `^20.19.0 || >=22.12.0`.

The generated Claude Desktop `.mcpb` declares macOS and Windows compatibility
because those are the one-click install targets verified for this package.
Linux remains supported through manual stdio configuration until Claude Desktop
MCPB installation behavior is verified there.

## MCP App Dev Harness

To inspect the App UI without an MCP host, run:

```sh
npm run dev:app
```

Then open `http://127.0.0.1:5174/index-dev.html?tabula-dev=1` for a local
document fixture, or add `&fixture=room` for the read-only room fixture. The
mock bridge implements App inputs, snapshots, save, share, display mode, and
model context updates inside the browser only.

For an App smoke check:

```sh
npm run test:app
```

This runs static bundle assertions and a Playwright browser flow against the dev
harness. The browser flow edits and saves a local document in fullscreen, sends
compact change and selection context, shares an encrypted link, opens the room
fixture, refreshes it, and exercises fullscreen mode. If Chromium is missing in
a fresh environment, run `npx playwright install chromium`.

## Editing Model

Room editing uses one model: direct workspace collaboration through
`tabula_apply_workspace_changes`. The tool can bundle multiple `document.patch`,
`document.create`, `document.rename`, `document.move`, and `document.delete`
inputs in one call. The MCP client validates the full change set against a
temporary workspace Y.Doc, then applies one Yjs update to the live room. A
one-document room is still represented as a workspace with one document.

Patch inputs must use the latest `baseSha256` returned by
`tabula_read_workspace_document` or `tabula_room_status`. Hashes are lowercase
SHA-256 hex values, matching Tabula.md's room collaboration contract. This
avoids blind full-file overwrites when another collaborator has changed the
room.

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
the MCP client a room URL containing a `#room` key fragment. Do not run it as a shared
hosted service unless you are deliberately moving the plaintext trust boundary
to that service.

The Tabula Room server must not receive:

- room keys
- plaintext Markdown
- decrypted Yjs updates
- decrypted presence payloads

MCP document checkpoints store plaintext Markdown because agents and the MCP App
need the working draft for iterative editing. In local stdio/MCPB mode this lives
on the user's machine by default. In remote HTTP mode this lives in the configured
remote checkpoint store, so only deploy remote Tabula MCP where that service is
allowed to hold temporary plaintext working state. This is separate from
Firebase live room checkpoints and `tabula-json`; both receive only encrypted
bytes for their respective room recovery and export-link workflows.

`tabula_share_document` creates a 32-byte snapshot key locally, serializes the
local Markdown as a Tabula JSON snapshot, and uploads only encrypted bytes to
the configured JSON snapshot service. The returned share URL includes the
snapshot key in the `#json` fragment, so it should be shared only with intended
collaborators or agents.

See [Security Model](docs/security-model.md) for the complete trust boundary and
release-blocking security checks.

## Validation

For the full release gate:

```sh
npm run release:verify
```

Equivalent individual checks:

```sh
npm run typecheck
npm test
npm run test:app
npm run test:stdio
npm run release:pack
npm audit --json
```
