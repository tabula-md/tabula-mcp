# Security Policy

## Supported Versions

Security fixes target the latest published `@tabula-md/mcp` release and the
current `main` branch.

## Reporting a Vulnerability

Do not report suspected vulnerabilities in public issues if they include secrets,
room links, snapshot links, plaintext document contents, or exploit details.
Use GitHub private vulnerability reporting for this repository when available.

Include:

- affected version or commit
- deployment mode: stdio, MCPB, Vercel, Cloudflare, or another host
- whether `TABULA_MCP_DEPLOYMENT_MODE=remote` or `TABULA_MCP_PRODUCTION=1` was set
- a minimal reproduction without real room keys, snapshot keys, or user data

## Security Boundaries

Tabula MCP has two different data paths:

- MCP document checkpoints are agent working state and may contain plaintext
  Markdown.
- `export_copy` exports through Tabula JSON encrypted snapshot links;
  the decryption key stays in the `#json` URL fragment.

Hosted room access makes the hosted MCP server a trusted plaintext processor
for room keys and decrypted Markdown. The official endpoint must disclose this
boundary; use local stdio or MCPB when room plaintext must stay on the user's
device.

Production HTTP deployments must use authentication or an explicit public
unauthenticated policy, Redis/Upstash-backed checkpoints, and an explicit
browser Origin allowlist. Production memory
checkpoints are available only through the explicit unsafe
`TABULA_MCP_DOCUMENT_STORE_DRIVER=memory` plus `TABULA_MCP_ALLOW_MEMORY_STORE=1`
override for self-hosting and tests. Do not use that override for the official
hosted `mcp.tabula.md` service. Do not deploy public remote MCP endpoints with
wildcard browser origins unless the endpoint is intentionally unauthenticated
test infrastructure.
