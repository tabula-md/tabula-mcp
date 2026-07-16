# MCP App Architecture

Tabula.md MCP ships one package that contains both the MCP server and the
bundled MCP App resource. This matches the current product goal: Claude Desktop
users install one `.mcpb`, then turn agent-created Markdown into an encrypted
Tabula.md copy or live session without manual setup.

## Product Shape

The MCP App is a compact Tabula Session Card:

- local Markdown document creation
- MCP document checkpointing
- encrypted export to a Tabula.md snapshot link
- creation and status handoff for an encrypted live room
- `Open a copy` or `Open session` actions into the actual Tabula.md app

The card is not a dashboard, a database, or a second document editor. Tabula.md
itself is the only visual editing and real-time collaboration surface. Claude
owns its surrounding conversation chrome; the MCP App intentionally stays
inline rather than imitating an entire Tabula desktop app inside that host.

The document checkpoint is private, local staging. A `#json` link opens a
standalone copy; a `#room` link opens the canonical collaboration object where
people and agent actors meet.

## Why The App Lives In This Repo

There is no separate `tabula-mcp-app` repository at this stage. Keeping the MCP
server, App resource, manifest template, tests, and MCPB packaging in this repo
keeps the release unit coherent:

- tool schemas and App calls evolve together
- bundle checks can verify server and App files at once
- Claude Desktop users install one artifact
- security checks can cover both model-facing tools and App-only tools

A separate App repo would only be useful if Tabula.md needed an independently
deployed web product surface with a separate release cadence.

## MCP Apps And MCP UI

The current target is the official MCP Apps surface through
`@modelcontextprotocol/ext-apps`. It provides App resources, App-only tools,
and host-mediated external-link opening for Claude Desktop-style hosts.

MCP UI can be revisited if Tabula.md needs a broader cross-host UI abstraction.
For the current Claude Desktop MCPB product, adding MCP UI would add another
integration layer without removing the need for MCP Apps metadata and bundle
validation.

## Runtime Structure

Current source layout:

```txt
src/
  app/
    document-app.html
    document-app.js
    document-app.css
    resource.ts
    tools.ts
    snapshots.ts
    types.ts
  app-dev/
    fixtures.js
    main.js
    mock-app.js
  documents/
    registry.ts
    schema.ts
    snapshot.ts
    store.ts
  server/
    create-server.ts
    http.ts
    web.ts
    register-room-tools.ts
    write-access.ts
  cli.ts
  index.ts
  room-client.ts
  protocol.ts
  crypto.ts
  share.ts
  guidance.ts
  workspace-contract.ts
api/
  mcp.ts
  health.ts
workers/
  tabula-mcp-worker.ts
```

Responsibilities:

- `src/cli.ts`: stdio/HTTP startup and command-line mode handling
- `src/server/create-server.ts`: server construction and tool registration
- `src/server/http.ts`: Streamable HTTP `/mcp`, `/health`, `/ready`, session lifecycle,
  and remote checkpoint store sharing
- `src/server/operational-policy.ts`: production auth, rate limit, request
  limit, stateless/stateful HTTP mode, session limit, timeout, and structured request log policy
- `src/server/origin-policy.ts`: browser Origin allowlist and CORS policy
- `src/server/web.ts`: Web-standard handler shared by Vercel Functions and
  Cloudflare Workers
- `src/server/register-room-tools.ts`: encrypted room tools
- `src/server/write-access.ts`: read-only/write-enabled policy
- `src/env.ts`: shared environment parsing helpers
- `src/app/resource.ts`: bundled Document App resource registration
- `src/app/tools.ts`: model-facing App tools and App-only state tools
- `src/documents/*`: document domain and local/remote checkpoint stores
- `src/share.ts`: encrypted JSON snapshot export
- `src/room-client.ts`, `src/protocol.ts`, `src/crypto.ts`, `src/workspace-contract.ts`:
  room transport adapters, protocol parsing, and MCP workspace tool views over
  the shared `@tabula-md/tabula` collaboration core
- `api/mcp.ts`, `api/health.ts`, `api/ready.ts`: Vercel deployment entrypoints
- `workers/tabula-mcp-worker.ts`: Cloudflare Workers deployment entrypoint

Room protocol and crypto modules should stay independent from the App UI.

## Package Exports

The npm package keeps `tabula-mcp` as the main CLI/bin entrypoint and exposes a
small ESM surface for tests, local embedding, and HTTP deployment:

- `@tabula-md/mcp`
- `@tabula-md/mcp/server`
- `@tabula-md/mcp/protocol`
- `@tabula-md/mcp/documents`

These exports point at built `dist/` modules and include TypeScript declaration
files. Keep the surface narrow until a broader public API is intentionally
designed.

## Test Layout

Tests live outside production source under `tests/`:

```txt
tests/
  app/
  documents/
  crypto.test.ts
  guidance.test.ts
  mcp-tools.test.ts
  protocol.test.ts
  share.test.ts
  text.test.ts
```

Keeping tests outside `src/` makes the packaged server source easier to scan and
keeps production module names aligned with runtime responsibilities.

## Tool Visibility

Model-facing tools:

- `tabula_read_me`
- `tabula_create_document`
- `tabula_update_document`
- `tabula_list_documents`
- `tabula_open_document`
- `tabula_share_document`
- `tabula_create_workspace`
- `tabula_import_markdown_workspace`
- `tabula_share_workspace`
- `tabula_create_workspace_room`
- `tabula_connect_room`
- `tabula_list_sessions`
- `tabula_room_status`
- `tabula_open_room_view`
- `tabula_read_workspace`
- `tabula_read_workspace_document`
- `tabula_read_workspace_context`
- `tabula_apply_workspace_changes`
- `tabula_set_presence`
- `tabula_wait_for_changes`
- `tabula_disconnect_room`

Workspace context remains tool-first for MCP client compatibility. Read-only
MCP resources mirror workspace data in clients that support them:
`tabula://workspace/{workspaceId}`,
`tabula://workspace/{workspaceId}/document/{documentId}`,
`tabula://room/{sessionId}/workspace`, and
`tabula://room/{sessionId}/document/{documentId}`. Tool outputs include
`resourceUri` handles when available, but agents must be able to create, import,
inspect, filter, share, and apply hash-guarded changes through tools alone.
`tabula_read_workspace_context` is the bounded context tool: use
`documentIds`, `pathGlobs`, `query`, and `changedSince` instead of reading every
document in full. Local filesystem imports are limited to MCP roots or
`TABULA_MCP_ALLOWED_IMPORT_ROOTS`; hosted clients should pass inline
`source.files`. Resource URIs never include `#room` keys or encrypted share
secrets.

Tool results are context-budgeted. Exact objects are returned in
`structuredContent`, while `content` uses concise text plus `resource_link`
entries for larger results. Do not add large output schemas or full JSON text
duplication back to model-facing tools without raising the context budget and
updating `scripts/measure-mcp-context.mjs`.

App-only tools:

- `tabula_app_document_snapshot`
- `tabula_app_save_document`
- `tabula_app_start_room_from_document`
- `tabula_app_room_snapshot`

`tabula_app_start_room_from_document` turns a local draft into a Room and
connects Claude as the actual read/write collaborator that published it. There
is no invisible transport, phantom collaborator, or second product-level write
switch. The MCP host remains responsible for asking the user to approve each
mutating tool call. All App-only tools are marked with MCP Apps visibility
metadata so model-facing tool lists stay focused.

## Collaboration Boundary

The Session Card never becomes a parallel Markdown editor and does not send
keystrokes or selections back into the model context. The model works through
document and workspace tools; people edit in the actual Tabula.md browser app.

A local draft exposes **Open a copy** (encrypted `#json` snapshot) and **Start
session** (a live encrypted `#room`). Starting a session connects Claude as a
real Room collaborator. The card shows **Open session** and a collaborator
count derived only from Awareness actors, never relay sockets. The connected
Room is the sole collaboration object for human and agent reads and writes; no
later local checkpoint edits are silently mirrored into it.

MCP hosts cache App resources by URI. `resource.ts` fingerprints the bundled
App HTML into the `ui://tabula/document-<hash>.html` resource URI, so a changed
local MCPB loads its matching Session Card instead of a stale card from an
earlier install.

## Checkpoint Stores

MCP document checkpoints are working state, not Tabula JSON share artifacts.

Local stdio/MCPB mode uses `FileDocumentStore` by default so Claude Desktop-style
installations can recover saved drafts after the MCP process restarts. It can be
made memory-only with `TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS=1`.

Remote HTTP mode uses `MemoryDocumentStore` with TTL by default, or
`UpstashRedisDocumentStore` when Upstash Redis or Vercel KV-compatible REST
credentials are configured. This mirrors the Excalidraw MCP pattern: the MCP
server keeps plaintext checkpoints for iterative agent editing, while
`tabula_share_document` exports the final handoff through the encrypted
`tabula-json` snapshot flow.

Live room checkpoints are a separate room-collaboration persistence path. When
Firebase is configured, `tabula_create_workspace_room` and `tabula_connect_room`
use the same encrypted Y.Doc checkpoint contract as `tabula-md`. Firebase
Storage stores the encrypted blob; Firestore stores only its generation,
opaque path, size, update time, and expiry. The room key remains in the `#room`
fragment and is used only inside the MCP client process.

## Dev Harness

The dev harness is intentionally separate from the production App bundle:

```txt
index-dev.html
src/app-dev/
```

Run it with:

```sh
npm run dev:app
```

Open:

```txt
http://127.0.0.1:5174/index-dev.html?tabula-dev=1
http://127.0.0.1:5174/index-dev.html?tabula-dev=1&fixture=room
```

The MCPB checker verifies that dev-only fixtures are not included in the
production bundled App.

`npm run test:app` also starts the dev harness in a real Playwright Chromium
session. It verifies the local draft -> encrypted copy -> live Room -> actual
Tabula.md handoff flow on desktop and narrow hosts. It asserts that the card
does not bundle or expose a second Markdown editor.

## Release Assets

Release-facing assets live under `assets/`. The MCPB manifest points to
`assets/icon.png` and the packaging script copies that directory into the staged
bundle root. Keep generated `dist/` bundle output out of git; commit only the
source asset and packaging scripts.
