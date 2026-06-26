# AGENTS.md

## Project Overview

Tabula MCP is a local stdio MCP server for joining Tabula.md encrypted live
rooms from agent clients.

## Product Direction

- Preserve the Tabula.md room security model.
- Treat room URLs with `#key=...` as bearer secrets.
- Keep the MCP process local by default.
- Default room sessions to read-only.
- Require explicit write access and hash-guarded patches for edits.
- Do not add hosted plaintext processing without an architecture decision.

## Commands

- Install: `npm install`
- Test: `npm test`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Dev stdio server: `npm run dev`

## Code Style

- Keep protocol, crypto, text patching, and MCP tool registration separate.
- Use structured parsers and schemas for external input.
- Do not log room URLs, room keys, plaintext Markdown, or decrypted envelopes.
- Prefer small, tested helpers for security-sensitive behavior.

## Validation

Run `npm test` and `npm run build` after changing protocol, crypto, room client,
or MCP tool behavior.
