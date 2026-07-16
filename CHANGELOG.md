# Changelog

## Unreleased

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
