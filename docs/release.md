# Release

This checklist is for preparing a Tabula.md MCPB release or PR that changes the
MCP server, bundled App, packaging, or security behavior.

## Automated Validation

Run:

```sh
npm run typecheck
npm test
npm run test:app
npm run check:exports
npm run check:pack
npm run release:pack
npm audit --json
git diff --check
```

Expected results:

- TypeScript passes.
- Vitest passes.
- App smoke test passes.
- Package ESM subpath exports import from built `dist/`.
- npm package dry-run includes built package files and excludes generated MCPB artifacts.
- MCPB validates, packs, and passes `check:mcpb`.
- `npm audit --json` reports zero vulnerabilities.
- `git diff --check` reports no whitespace errors.

`npm run release:pack` validates the MCPB staging directory, packs the MCPB,
runs the bundle checker, and writes:

```txt
dist/tabula-mcp-<version>.mcpb
dist/tabula-mcp-<version>.mcpb.sha256
```

Generated `dist/` output, staged `dist/mcpb/` contents, `.mcpb` files, and
`.sha256` checksum files are not source artifacts and should not be committed.
They are also excluded from npm package contents except for the built JS,
declaration files, and bundled App HTML needed by package exports and the CLI.

## MCPB Checks

The staged bundle must include:

- `manifest.json`
- server entrypoint files
- bundled `document-app.html`
- App tool/resource files
- document domain files
- share/export files
- guidance files
- `assets/icon.png`
- `README.md`
- `docs/`
- `LICENSE`

The manifest must not contain installer `user_config`.
The manifest must point `icon` and a `512x512` `icons` entry at
`assets/icon.png`.

The default MCPB must be read-only for room writes. Write-enabled testing uses
manual stdio configuration, not installer prompts.

## Manual Claude Desktop Check

After installing the generated `.mcpb`:

1. Call `tabula_read_me`.
2. Create a local document with `tabula_create_document`.
3. Edit title and Markdown in the App.
4. Switch between Editor, Split, and Preview.
5. Save the document.
6. Call `tabula_list_documents` and confirm the document checkpoint appears.
7. Call `tabula_open_document` and confirm the App reopens the checkpoint.
8. Click Send Changes and confirm Claude receives a compact summary.
9. Click Share and confirm Claude receives a `https://tabula.md/r/...#key=...`
   link.
10. Connect that link with `tabula_connect_room`.
11. Open the room view with `tabula_open_room_view`.
12. Confirm Markdown preview, outline, refresh, and selection handoff work.

For local Tabula.md development, run the room server separately and use local
links such as:

```txt
http://localhost:5173/r/<roomId>#key=<roomKey>
```

Those links route to `http://localhost:3002` by default.

## Runtime Support

Current policy:

- Node.js 22 or newer
- Claude Desktop MCPB compatibility: macOS and Windows
- Linux: manual stdio testing only until MCPB installation behavior is verified

Do not lower the Node version or broaden platform claims without testing the
full App, MCPB, and room flows on that runtime.

## Security Review

Before release, inspect security-sensitive changes for:

- room URL parsing
- hash fragment handling
- room server request bodies
- encrypted snapshot upload
- local plaintext document checkpointing
- local draft storage
- write-mode gating
- App-only tool visibility
- manifest installer configuration

Room keys and plaintext Markdown must stay inside the local MCP process and
local MCP App host, except for encrypted snapshot envelopes sent to the room
server.

## PR Handoff Notes

PR descriptions should include:

- user-visible workflow changed
- security boundary impact
- automated validation commands and results
- manual Claude Desktop check status, if performed
- residual risk, especially around host support or room server availability
