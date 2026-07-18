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

Tabula MCP has two explicit handoff paths:

- live sessions decrypt Markdown inside the connected MCP process so the agent
  can collaborate; optional recovery checkpoints leave that process only as
  encrypted Yjs blobs.
- `export_copy` exports through Tabula JSON encrypted snapshot links;
  the decryption key stays in the `#json` URL fragment.

Hosted room access makes the hosted MCP server a trusted plaintext processor
for room keys and decrypted Markdown. The official endpoint must disclose this
boundary; use local stdio or MCPB when room plaintext must stay on the user's
device.

Production HTTP deployments must use authentication or an explicit public
unauthenticated policy and an explicit browser Origin allowlist. They must also
provide stateful session affinity: the official Cloudflare deployment uses one
Durable Object per MCP session. Do not deploy public remote MCP endpoints with
wildcard browser origins unless the endpoint is intentionally unauthenticated
test infrastructure.
