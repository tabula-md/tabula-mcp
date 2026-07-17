# Changelog

## Unreleased

## 0.4.1

- Flattened `tabula_export_copy` inputs so agents pass either `files` or
  `sessionId` directly, with described parameters, concrete examples, and
  actionable errors for invalid source combinations.
- Described every model-facing input, corrected destructive annotations for
  file replacement, removed redundant session ids from file-tool results, and
  made invalid room links and path conflicts recoverable.
- Added `tabula_import_copy` so agents can decrypt a received `#json` handoff
  into safe relative Markdown paths for host-native local materialization,
  without treating a fixed copy as a live collaboration Session.
- Preserved exported workspace titles, active files, comments, and expiry
  metadata across Copy handoffs.
- Replaced the oversized MCP App handoff panel with a single-row receipt for
  encrypted Copies and live Sessions, including compact inline host approval
  states and desktop/mobile height regression coverage.
- Updated MCPB release verification to require the compact receipt instead of
  the removed summary block.

## 0.4.0

- Replaced the singular `tabula_read_file` tool with `tabula_read_files`, which
  reads one or more Markdown files in input order and returns each revision in
  one bounded response without silently truncating content.

## 0.3.0

- Removed Tabula's private-draft tools and resources. Claude, Codex, and local
  filesystems remain the writing surface; Tabula now receives Markdown only
  when creating an encrypted Copy or live Session.
- Added atomic multi-file Session writes, including nested folder creation and
  preflight revision checks that prevent partial updates.
- Reduced the default MCP surface to eight high-level tools centered on live
  Session files and encrypted handoff.

## 0.2.2

- Made `tabula_write_file` flush the encrypted room checkpoint before returning
  success so the latest agent edit survives an immediate MCP disconnect.
- Added file-service coverage for durable flush success and failure behavior.

## 0.2.1

- Replaced the production Firebase checkpoint SDK transport with standard REST
  requests so Cloudflare Workers can create durable encrypted sessions without
  relying on the unavailable `XMLHttpRequest` runtime API.
- Preserved generation-guarded checkpoint writes, encrypted blob cleanup, and
  Firebase emulator coverage while adding REST conflict and error tests.

## 0.2.0

- Replaced the 0.1 workspace/CRDT tool surface with nine high-level Draft,
  Session, file, and Copy tools. No legacy adapter is registered.
- Added path-based list, read, search, and write operations. The server now
  validates revisions and computes Yjs text patches instead of asking models
  to construct patch offsets.
- Unified MCP App and model exports through `tabula_export_copy` and the shared
  Tabula schema-v2 snapshot serializer, including nested folder preservation.
- Reduced default `tools/list` below 14 KB and replaced `tabula_read_me` with
  server instructions.
- Made the compact Session Card call the same Start Session and Export Copy
  services as model-facing tools.
- Preserved the OIDC npm and GitHub Release workflow, including provenance,
  versioned MCPB artifacts, stable download aliases, and post-publish checks.

## 0.1.6

- Made Room connection intentionally read/write capable by default. MCP hosts
  such as Claude Desktop remain responsible for per-tool mutation approval;
  `--read-only` is the explicit inspection-only server mode.
- Made **Start session** create the actual Claude Room collaborator immediately.
  The Session Card now reports only Awareness collaborators, never the internal
  relay socket count, and no longer includes an `Invite Claude` or a redundant
  `Allow Claude to edit` control.
- Simplified the Session Card to a centered **[Tabula mark] Tabula** header and
  removed document titles from the collaboration chrome.
- Added `tabula_update_document` for intentional edits to an existing private
  draft; when a Room is connected, new document creation writes directly to the
  shared workspace.

## 0.1.5

- Aligned encrypted **Open a copy** `#json` snapshots with Tabula.md's shared
  schema v2 contract, including the workspace root folder and ordered file
  placement required by the Tabula.md app.
- Reused the shared Tabula encryption and snapshot codec instead of maintaining
  a divergent MCP copy, with an interoperability test that decrypts and parses
  MCP snapshots through the Tabula package.
- Replaced the MCP App's cloned Markdown editor with a compact Tabula.md
  Session Card. Actual writing and real-time collaboration now always happen
  in Tabula.md through **Open a copy** or **Open session**.
- Fingerprinted the bundled MCP App resource URI so Claude Desktop cannot reuse
  a stale App resource after an MCPB update.
- Released the card as a new MCPB/plugin version so Claude Desktop recognizes
  the update as a new extension install.

## 0.1.4

- Rebuilt the MCP App around the same Tabula.md visual language: branded app
  chrome, a local-draft state, and the existing Tabula workbench for local
  Markdown editing.
- Made a connected Room a distinct live-session handoff rather than a second,
  misleading editor. Inline results keep a compact preview and **Open
  session**; fullscreen presents one focused Tabula.md session surface.
- Display the active Room document title instead of the internal Room ID in
  the MCP App and its Room snapshots.

## 0.1.3

- Made the MCP App's collaboration transition explicit: local documents offer
  **Open a copy** for an encrypted `#json` snapshot or **Start session** for a
  live encrypted `#room` session; connected rooms offer **Open session**.
- Made a Room the authoritative collaboration object after a session starts;
  the pre-session local document remains a private draft checkpoint rather
  than a second collaboration copy.
- Allow local MCPB clients to create temporary live sessions without Firebase
  persistence, while hosted MCP rejects that unsafe mode unless encrypted Room
  persistence is configured.

## 0.1.2

- Let local MCPB clients join active encrypted rooms without Firebase checkpoint
  persistence, then wait safely for browser or agent workspace state.
- Block workspace reads and edits until the connected room has received state,
  preventing empty local CRDT state from being treated as shared content.
- Added browser-peer-to-no-persistence-MCP end-to-end coverage.

- Reworked public installation around the published `@tabula-md/mcp` package
  for Codex, Claude Code, and generic local MCP clients.
- Added `--help`, `--version`, and secret-free `--doctor` CLI surfaces.
- Clarified local and hosted MCP plaintext trust boundaries.
- Added operational-log redaction for bearer tokens and Tabula room/snapshot
  URL fragments.
- Added a full local collaboration release gate for maintainers with sibling
  Tabula app and room checkouts.

## 0.1.1

- Added directory-ready MCPB metadata: an HTTPS privacy policy URL, complete
  tool display titles, and the white-background Tabula.md icon.
- Added a release check that keeps the npm package, Claude Code plugin, MCPB,
  privacy policy, and generated directory submission assets aligned.
- Prepared stateful Cloudflare MCP HTTP deployment for workspace-room tools.

- Added Vercel and Cloudflare hosted MCP deployment targets.
- Added production guardrails for remote HTTP deployments: bearer auth,
  Redis-backed checkpoints, request limits, rate limits, bounded sessions, and
  structured request logging.
- Added an explicit unsafe production memory checkpoint override for
  Excalidraw-style self-hosting.
- Added `/ready` readiness metadata alongside `/health`.
- Hardened production browser Origin handling and default local HTTP binding.
- Added MIT/open-source operations documents: `SECURITY.md`,
  `CONTRIBUTING.md`, and this changelog.
