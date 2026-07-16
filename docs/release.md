# Release

This checklist is for preparing a Tabula.md MCPB release or PR that changes the
MCP server, bundled App, packaging, or security behavior.

## Automated Validation

Run:

```sh
npm run release:verify
```

Before a public release, also run the cross-repository multi-file collaboration
gate from a checkout that has sibling `tabula-md` and `tabula-room` repositories:

```sh
npm run release:verify:full
```

The GitHub Actions CI workflow runs the same `npm run release:verify` gate on
pull requests and pushes to `main` using Node.js 22.12.0. It installs Playwright
Chromium before running the App browser smoke.

Equivalent individual commands:

```sh
npm run typecheck
npm test
npm run test:app
npm run test:stdio
npm run test:e2e:local-collab
npm run check:claude-plugin
npm run check:deploy-targets
npm run check:exports
npm run check:pack
npm run release:pack
npm audit --json
git diff --check
```

Expected results:

- TypeScript passes.
- Vitest passes.
- App smoke test passes, including static bundle checks and the Playwright
  document/room flow smoke.
- Built stdio server smoke passes, including tool gating, App resource reads,
  local document save/open, and encrypted share upload checks. The stdio smoke
  also runs a zero-config path with no Tabula-specific environment variables:
  it creates a document, writes the default local checkpoint, restarts the
  server, reopens the checkpoint, and shares with an explicit JSON snapshot
  service argument.
- The full local release gate creates a multi-file room, connects the MCP as an
  agent actor, reads workspace context, applies a guarded change, and observes
  the result in Tabula.md. It is separate from public CI while its sibling
  service repositories are not all public dependencies.
- Claude Code marketplace configuration passes, including the marketplace
  entry, plugin metadata, and the explicit npm package version pinned by the
  plugin MCP configuration.
- HTTP server tests pass, including `/health` metadata and a Streamable HTTP MCP
  client connection to `/mcp`.
- Vercel and Cloudflare deployment target checks pass: the Vercel API entrypoint
  smokes locally, and Wrangler bundles the Cloudflare Worker with `--dry-run`.
- Package ESM subpath exports import from built `dist/`.
- npm package dry-run includes built package files and excludes generated MCPB artifacts.
- MCPB validates, packs, and passes `check:mcpb` against both the staging
  directory and unpacked `.mcpb` artifact. The unpacked artifact's bundled
  `server/index.js` also passes the stdio smoke, covering tool gating, App
  resource reads, checkpoint recovery, and encrypted share upload checks from
  the same layout Claude Desktop installs.
- `npm audit --json` reports zero vulnerabilities.
- `git diff --check` reports no whitespace errors.

`npm run release:pack` validates the MCPB staging directory, packs the MCPB,
unpacks the generated artifact for the same bundle checks, and writes:

```txt
dist/tabula-mcp-<version>.mcpb
dist/tabula-mcp-<version>.mcpb.sha256
```

Generated `dist/` output, staged `dist/mcpb/` contents, `.mcpb` files, and
`.sha256` checksum files are not source artifacts and should not be committed.
They are also excluded from npm package contents except for the built JS,
declaration files, and bundled App HTML needed by package exports and the CLI.

## MCPB Checks

The staged bundle and unpacked `.mcpb` artifact must include:

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
The manifest must list all default model-facing tools exposed by the
MCPB server, including document, sharing, workspace room status,
workspace apply, presence, wait, and disconnect tools. It must not list
App-only helper tools or legacy single-document room patch tools. `check:mcpb`
starts the bundled default server from the staged and unpacked bundle layouts
and compares the actual model-facing tool list against the manifest so future
tool registration drift is caught automatically.
The packed artifact must not include packaging-only lockfiles.

The packed artifact must also start successfully over stdio from its unpacked
bundle layout. This catches missing bundled dependencies, broken server
entrypoints, missing App resources, and accidental installer-only assumptions
before manual Claude Desktop testing.

The packed artifact smoke also covers the zero-config document flow without
`TABULA_MCP_DOCUMENT_STORE_DIR`, `TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS`,
`TABULA_JSON_URL`, `TABULA_ROOM_URL`, or write-mode environment variables. Share
tests pass the JSON snapshot service URL as a tool argument, matching the
no-installer-settings MCPB model.

The default MCPB must expose the same workspace room collaboration surface as
the stdio server without installer prompts for room URLs, keys, tokens, or
write-mode settings.

Hosted release checks must keep production guardrails intact: production remote
HTTP requires `TABULA_MCP_AUTH_TOKEN` unless `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1`
is explicitly set, uses Redis/Upstash REST credentials by default, applies
Origin/request/rate/session limits, exposes the same room/workspace tool surface
as local stdio, and uses stateful MCP HTTP sessions for remote room/workspace
tools. Public unauthenticated production still rejects memory checkpoint fallback.
Production memory checkpoints are allowed only when both
`TABULA_MCP_DOCUMENT_STORE_DRIVER=memory` and `TABULA_MCP_ALLOW_MEMORY_STORE=1`
are explicitly set.

## Manual Claude Desktop Check

After installing the generated `.mcpb`:

1. Call `tabula_read_me`.
2. Create a local document with `tabula_create_document`.
3. Confirm inline mode shows preview plus `Open in Tabula` and `Edit`.
4. Click `Edit`, then edit title and Markdown in fullscreen.
5. Switch between Editor, Split, and Preview.
6. Save the document.
7. Call `tabula_list_documents` and confirm the document checkpoint appears.
8. Call `tabula_open_document` and confirm the App reopens the checkpoint.
9. Click Send Changes and confirm Claude receives a compact summary.
10. Click Share and confirm Claude receives a `https://tabula.md/#json=...,...`
   link.
11. Open that link in Tabula.md and confirm the snapshot import flow starts.
12. For room testing, connect a separate live room link with `tabula_connect_room`.
13. Open the room view with `tabula_open_room_view`.
14. Confirm Markdown preview, outline, refresh, and selection handoff work.

For local Tabula.md development, run the room server separately and use local
links such as:

```txt
http://localhost:5173/#room=<roomId>,<roomKey>
```

Those links route to `http://localhost:3002` by default.

## Runtime Support

Current policy:

- Stdio server and npm package: macOS, Windows, and Linux on Node.js
  `^20.19.0 || >=22.12.0`
- Claude Desktop MCPB one-click compatibility: macOS and Windows
- Linux: manual stdio configuration only until Claude Desktop MCPB installation
  behavior is verified there

Do not lower the Node version, broaden MCPB platform claims, or remove the
Linux caveat without testing the full App, MCPB, and room flows on that runtime.

## Security Review

Before release, inspect security-sensitive changes for:

- room URL parsing
- hash fragment handling
- room server request bodies
- encrypted snapshot upload
- local and remote plaintext document checkpointing
- remote HTTP checkpoint store selection
- Vercel and Cloudflare deployment entrypoints
- local draft storage
- write-mode gating
- App-only tool visibility
- manifest installer configuration

Room keys and plaintext Markdown must stay inside the intended MCP trust
boundary. For local stdio/MCPB, that is the user's machine and MCP App host. For
remote HTTP, that includes the hosted `tabula-mcp` process and configured
checkpoint store. Encrypted room envelopes may go to the Tabula Room server;
encrypted JSON snapshot bytes may go to the Tabula JSON snapshot service.

## PR Handoff Notes

PR descriptions should include:

- user-visible workflow changed
- security boundary impact
- automated validation commands and results
- manual Claude Desktop check status, if performed
- manual Codex CLI check status, if performed
- residual risk, especially around host support or room server availability
