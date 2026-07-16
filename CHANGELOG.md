# Changelog

## Unreleased

## 0.1.5

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
