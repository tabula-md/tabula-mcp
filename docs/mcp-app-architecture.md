# MCP App Architecture

Tabula.md MCP ships one package that contains both the MCP server and the
bundled MCP App resource. This matches the current product goal: Claude Desktop
users install one `.mcpb`, then create, edit, review, and share Markdown without
manual setup.

## Product Shape

The primary product surface is the Tabula.md Document App:

- local Markdown document creation
- title editing
- Markdown editor
- Editor, Split, and Preview modes
- outline navigation
- local draft recovery
- save into the local MCP session
- Send Changes back into model context
- encrypted share/export to a Tabula.md room link
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
    register-room-tools.ts
    write-access.ts
  cli.ts
  index.ts
  room-client.ts
  protocol.ts
  crypto.ts
  share.ts
  guidance.ts
```

Responsibilities:

- `src/cli.ts`: stdio startup and command-line write-mode handling
- `src/server/create-server.ts`: server construction and tool registration
- `src/server/register-room-tools.ts`: encrypted room tools
- `src/server/write-access.ts`: read-only/write-enabled policy
- `src/app/resource.ts`: bundled Document App resource registration
- `src/app/tools.ts`: model-facing App tools and App-only state tools
- `src/documents/*`: local document domain
- `src/share.ts`: encrypted room snapshot export
- `src/room-client.ts`, `src/protocol.ts`, `src/crypto.ts`: room transport,
  protocol parsing, and encryption primitives

Room protocol and crypto modules should stay independent from the App UI.

## Tool Visibility

Model-facing tools:

- `tabula_read_me`
- `tabula_create_document`
- `tabula_share_document`
- `tabula_connect_room`
- `tabula_list_sessions`
- `tabula_room_status`
- `tabula_read_markdown`
- `tabula_get_outline`
- `tabula_open_room_view`
- `tabula_set_presence`
- `tabula_wait_for_changes`
- `tabula_disconnect_room`
- `tabula_apply_text_patches` only when server write mode is enabled

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
