# MCP App Architecture

Tabula.md MCP ships one package that contains both the MCP server and the
bundled MCP App resource. This matches the current product goal: Claude Desktop
users install one `.mcpb`, then create, preview, edit, and share Markdown
without manual setup.

## Product Shape

The primary product surface is the Tabula.md Document App:

- local Markdown document creation
- title editing
- Markdown editor
- Editor, Split, and Preview modes
- outline navigation
- local draft recovery
- MCP document checkpointing
- save into the MCP checkpoint store
- Send Changes back into model context
- encrypted share/export to a Tabula.md snapshot link
- read-only connected room view

The App is not a dashboard and not a database. It should remain document-first.

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
`@modelcontextprotocol/ext-apps`. It provides App resources, App-only tools, and
model context updates for Claude Desktop-style hosts.

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
- `tabula_app_room_snapshot`

App-only tools are marked with MCP Apps visibility metadata so model-facing
tool lists stay focused while the App can still load and save state.

## Context Sync

The Document App uses `updateModelContext` for explicit model handoff.

The App should not send the full Markdown document on every keystroke. It should
send bounded summaries, hashes, changed ranges, and short excerpts. Full text
handoff should remain a deliberate tool or user action.

Inline mode is preview-first and exposes only `Open in Tabula` plus `Edit`.
Editing and context handoff controls live in fullscreen mode.

When the user shares an App document with unsent edits, the App saves the
current document checkpoint, creates the encrypted snapshot link, and includes
the compact change summary in the same `updateModelContext` payload. This keeps
the common "edit, then share" flow closed without requiring a separate Send
Changes click.

Selection handoff is also bounded. If the user selects a large range, the App
sends a head/tail excerpt plus original and excerpt lengths instead of the full
selected text. The model can ask the user for a narrower selection when exact
middle text is needed.

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
session. It verifies the local document edit -> save -> model-context -> share
loop, bounded selection handoff, the read-only room refresh path, and fullscreen
display mode requests.

## Release Assets

Release-facing assets live under `assets/`. The MCPB manifest points to
`assets/icon.png` and the packaging script copies that directory into the staged
bundle root. Keep generated `dist/` bundle output out of git; commit only the
source asset and packaging scripts.
