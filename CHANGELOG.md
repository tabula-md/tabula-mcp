# Changelog

## 0.1.1

- Added directory-ready MCPB metadata: an HTTPS privacy policy URL, complete
  tool display titles, and the white-background Tabula.md icon.
- Added a release check that keeps the npm package, Claude Code plugin, MCPB,
  privacy policy, and generated directory submission assets aligned.
- Prepared stateful Cloudflare MCP HTTP deployment for workspace-room tools.

## Unreleased

- Added Vercel and Cloudflare hosted MCP deployment targets.
- Added production guardrails for remote HTTP deployments: bearer auth,
  Redis-backed checkpoints, request limits, rate limits, bounded sessions, and
  structured request logging.
- Added stateless production HTTP mode for hosted document workflows when remote
  room tools are disabled.
- Added an explicit unsafe production memory checkpoint override for
  Excalidraw-style self-hosting.
- Added `/ready` readiness metadata alongside `/health`.
- Hardened production browser Origin handling and default local HTTP binding.
- Added MIT/open-source operations documents: `SECURITY.md`,
  `CONTRIBUTING.md`, and this changelog.
