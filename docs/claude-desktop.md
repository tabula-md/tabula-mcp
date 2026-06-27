# Claude Desktop

Tabula.md MCP is packaged for Claude Desktop as a zero-config MCP Bundle
(`.mcpb`). Normal users should not enter a room URL, room key, token, or write
setting during installation.

## Build

```sh
npm install
npm run release:pack
```

The bundle includes `assets/icon.png` for the Claude Desktop extension listing
and is written to `dist/tabula-mcp-<version>.mcpb`, with a matching
`dist/tabula-mcp-<version>.mcpb.sha256` checksum.

`release:pack` builds the TypeScript server, bundles the Document App, stages
the MCPB directory, validates the manifest, packs the bundle, and runs the
local MCPB checker, then writes the checksum file.

## Install

Install the generated `.mcpb` in Claude Desktop by double-clicking it, dragging
it into Claude Desktop, or using:

```txt
Settings -> Extensions -> Advanced settings -> Install Extension
```

The installer should not ask for configuration. If an install screen asks for
Tabula room settings, room keys, or write mode, treat that as a release blocker.

## Create A Document

Ask Claude to create a Tabula.md document, or call `tabula_create_document`
directly from an MCP tool inspector.

Expected behavior:

1. Claude opens the Tabula.md Document App.
2. The document title and Markdown body are editable.
3. Editor, Split, and Preview modes work.
4. Save stores the document in the local MCP server process.
5. Send Changes posts a compact edit summary back into model context.
6. Share creates an encrypted `https://tabula.md/r/...#key=...` link.

Local App documents are checkpointed as plaintext files on this machine so they
can recover across MCP process restarts. They are not uploaded to Tabula.md room
infrastructure until the user explicitly shares them.

To resume a local document after restarting Claude Desktop or the MCP server,
ask Claude to list local Tabula.md documents with `tabula_list_documents`, then
open one with `tabula_open_document`.

## Open A Room

Ask Claude to connect a Tabula.md room URL:

```txt
https://tabula.md/r/<roomId>#key=<roomKey>
```

Hosted `https://tabula.md/r/...` links use `https://rooms.tabula.md`.
Local development links such as `http://localhost:5173/r/...` default to
`http://localhost:3002`.

Expected behavior:

1. `tabula_connect_room` connects the encrypted room in read-only mode.
2. `tabula_open_room_view` opens the App room view.
3. `tabula_read_markdown` and `tabula_get_outline` return decrypted local
   Markdown to the model.
4. The room server only receives encrypted envelopes.

The `#key` fragment is a bearer secret. Do not paste production room links into
logs, issue trackers, or public screenshots.

## Write-Enabled Development

The MCPB is intentionally read-only for room writes. To test write mode, use a
manual stdio MCP configuration instead of the MCPB:

```json
{
  "mcpServers": {
    "tabula": {
      "command": "node",
      "args": ["/absolute/path/to/tabula-mcp/dist/index.js"],
      "env": {
        "TABULA_MCP_ENABLE_WRITE": "1"
      }
    }
  }
}
```

`--read-only` overrides `--enable-write` and `TABULA_MCP_ENABLE_WRITE=1`.

## Manual Smoke Check

After installing the MCPB in Claude Desktop:

1. Ask Claude: `Call tabula_read_me for document guidance.`
2. Ask Claude: `Create a Tabula.md document titled Release Notes.`
3. Edit the Markdown in the App.
4. Click Save.
5. Ask Claude to call `tabula_list_documents` and confirm the saved document is
   listed.
6. Ask Claude to call `tabula_open_document` and confirm the App reopens it.
7. Click Send Changes and confirm Claude sees the edit summary.
8. Click Share and confirm Claude receives a room URL with `#key=`.
9. Open the share URL in Tabula.md or reconnect it with `tabula_connect_room`.
10. Open the room view and confirm Markdown preview and outline render.

If the App fails to open, verify that the MCPB contains `server/document-app.html`
and that `npm run check:mcpb` passes.
