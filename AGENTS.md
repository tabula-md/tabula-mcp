# AGENTS.md

## Project Overview

Tabula.md MCP is a local stdio MCP server and MCP App for drafting Markdown
documents, handing document context back to agents, and joining encrypted
Tabula.md live rooms from agent clients.

## Product Direction

- Keep the product Markdown-document-first. Do not turn the MCP App into a
  dashboard, database, or hosted plaintext processor.
- Keep local App documents local unless the user explicitly shares them as an
  encrypted Tabula.md room link.
- Preserve the Tabula.md room security model.
- Treat room URLs with `#key=...` as bearer secrets.
- Keep the MCP process local by default.
- Default room sessions to read-only.
- Require explicit write access and hash-guarded patches for edits.
- Keep Claude Desktop `.mcpb` installation zero-config. Do not add installer
  prompts for room URLs, room keys, tokens, or write mode.
- Do not add hosted plaintext processing without an architecture decision.

## Commands

- Install: `npm install`
- Test: `npm test`
- App smoke: `npm run test:app`
- Built stdio smoke: `npm run test:stdio`
- Build: `npm run build`
- MCPB build: `npm run build:mcpb`
- Release pack: `npm run release:pack`
- Bundle check: `npm run check:mcpb`
- Typecheck: `npm run typecheck`
- Dev stdio server: `npm run dev`
- Dev App harness: `npm run dev:app`

## Code Style

- Keep protocol, crypto, text patching, and MCP tool registration separate.
- Keep MCP App resource/tools, document registry/store/snapshot, room tools,
  and CLI entrypoint in their existing separated modules.
- Use structured parsers and schemas for external input.
- Do not log room URLs, room keys, plaintext Markdown, decrypted envelopes, or
  generated encrypted share links.
- Prefer small, tested helpers for security-sensitive behavior.

## Validation

Run focused checks for small changes. Before release-facing handoff, run:

```sh
npm run typecheck
npm test
npm run test:app
npm run test:stdio
npm run release:pack
npm audit --json
git diff --check
```

Run `npm run check:mcpb` after MCPB packaging changes. Run `npm run
check:exports` and `npm run check:pack` after package exports or publish
allowlist changes.
