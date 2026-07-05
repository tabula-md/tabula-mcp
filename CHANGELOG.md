# Changelog

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
