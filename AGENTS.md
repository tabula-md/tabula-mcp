# AGENTS.md

## Project Overview

Tabula MCP is a local stdio MCP server and MCP App for handing host-native
Markdown files to encrypted Tabula copies and live rooms, then collaborating
on those files from agent clients.

## Product Direction

- Keep the product Markdown-document-first. Do not turn the MCP App into a
  dashboard, database, or hosted plaintext processor.
- Do not duplicate host-native writing or filesystem draft features. Accept
  Markdown files only when the user explicitly requests a Copy or Session.
- Preserve the Tabula room security model.
- Treat room URLs with `#room=...` as bearer secrets because the fragment
  contains the room key.
- Keep the MCP process local by default.
- Treat hosted MCP as an explicitly disclosed trusted plaintext processor, not
  as an equivalent privacy mode to local stdio or MCPB.
- Keep writes host-governed and revision-guarded. `--read-only` is the explicit
  inspection-only mode.
- Keep Claude Desktop `.mcpb` installation zero-config. Do not add installer
  prompts for room URLs, room keys, tokens, or write mode.
- Do not weaken the hosted plaintext trust disclosure or its production
  security controls without an architecture decision.

## Commands

- Install: `npm install`
- Test: `npm test`
- App smoke: `npm run test:app`
- Built stdio smoke: `npm run test:stdio`
- Build: `npm run build`
- MCPB build: `npm run build:mcpb`
- Release pack: `npm run release:pack`
- Full release gate: `npm run release:verify`
- Bundle check: `npm run check:mcpb`
- Typecheck: `npm run typecheck`
- Dev stdio server: `npm run dev`
- Dev App harness: `npm run dev:app`

## Code Style

- Keep protocol, crypto, text patching, and MCP tool registration separate.
- Keep MCP App resources, Session resources, room tools, and the CLI entrypoint
  in their existing separated modules.
- Use structured parsers and schemas for external input.
- Do not log room URLs, room keys, plaintext Markdown, decrypted envelopes, or
  generated encrypted share links.
- Prefer small, tested helpers for security-sensitive behavior.

## Validation

Run focused checks for small changes. Before release-facing handoff, run:

```sh
npm run release:verify
```

Run `npm run check:mcpb` after MCPB packaging changes. Run `npm run
check:exports` and `npm run check:pack` after package exports or publish
allowlist changes.
