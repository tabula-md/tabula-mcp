# Deployment

Tabula MCP supports local stdio and stateful Streamable HTTP deployments. The
official hosted endpoint is:

```text
https://mcp.tabula.md/mcp
```

Cloudflare Workers is the official production target. Vercel remains a build-
verified preview and self-hosting target, but it is suitable for live sessions
only when the operator supplies single-instance or sticky session affinity.

## Data and state model

Tabula MCP does not keep a second private-draft or plaintext document-checkpoint
database. Claude, Codex, ChatGPT, or the local filesystem owns Markdown until a
user explicitly starts or joins a live Room, or exports/imports a fixed Copy.

During a live session, the MCP runtime is a trusted plaintext participant and
holds the room key and decrypted Yjs working state. The Room relay receives
encrypted collaboration envelopes. Optional recovery writes encrypted Yjs
checkpoint blobs to Firebase Storage and an opaque generation pointer to
Firestore. Export Copy uploads only an encrypted snapshot to Tabula JSON.

Consequently:

- `/health` reports process policy and version, not a fictitious document store.
- `/ready` reports that the MCP runtime can accept requests; Room/Copy provider
  failures are reported by the operation that uses them.
- closing an MCP session must close its Room connections and clear decrypted
  working state.

## HTTP surface

Both HTTP targets expose:

- `GET /` — service metadata
- `GET /health` — version, write policy, deployment mode, and public policy
- `GET /ready` — runtime readiness
- `/mcp` — Streamable HTTP MCP
- `/sse` and `/message` — compatibility rewrites to `/mcp`

Remote deployments require stateful MCP sessions. `TABULA_MCP_STATELESS_HTTP=1`
is rejected because Room connections and decrypted Yjs state must survive
between tool calls.

## Public endpoint guardrails

Production mode is enabled by `TABULA_MCP_PRODUCTION=1`,
`TABULA_MCP_PUBLIC_ENDPOINT=1`, or Vercel production. Configure:

```sh
TABULA_MCP_DEPLOYMENT_MODE=remote
TABULA_MCP_PRODUCTION=1
TABULA_MCP_PUBLIC_UNAUTHENTICATED=1
TABULA_MCP_ALLOWED_ORIGINS=https://tabula.md
```

Use `TABULA_MCP_AUTH_TOKEN` instead of
`TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` for a private deployment. The official
no-login endpoint intentionally uses the public policy.

Additional guardrails:

- production browser Origins are denied unless allowlisted;
- production Room/JSON egress is restricted to official services plus
  `TABULA_MCP_ALLOWED_ROOM_SERVER_URLS` and
  `TABULA_MCP_ALLOWED_JSON_SERVER_URLS`;
- request bodies, request duration, mutations, Copy bytes, active sessions, and
  active Rooms are bounded by their `TABULA_MCP_*` limits;
- Cloudflare quota shards use an HMAC of the normalized client network prefix,
  so opening a new MCP session does not reset quota;
- Room URLs, Copy URLs, keys, Markdown, and prompts must not enter logs;
- file and comment tools require the explicit `sessionId` returned by Start
  Session or Join Room.

The hosted endpoint has read/write Room capabilities by default. The MCP host
continues to approve mutating tool calls. Use `--read-only` only for an
intentionally review-only self-hosted deployment.

## Cloudflare Workers (official)

The Cloudflare target uses:

- `workers/tabula-mcp-worker.ts`
- `wrangler.jsonc`
- one `TabulaMcpSessionDurableObject` per MCP session for transport and Room
  affinity
- `TabulaMcpQuotaDurableObject` shards for request, mutation, export-byte,
  active-session, and active-Room limits

Set the quota identity HMAC key:

```sh
npx wrangler secret put TABULA_MCP_QUOTA_HASH_SECRET
```

Use a new random value; do not reuse an MCP authorization token. Configure
optional encrypted Room recovery with the same Firebase Web SDK config used by
Tabula:

```sh
npx wrangler secret put VITE_TABULA_FIREBASE_CONFIG
```

Deploy and validate:

```sh
npm run check:cloudflare
npm run deploy:cloudflare
```

The Session Durable Object owns live plaintext working state only while its MCP
session is active. The Quota Durable Object stores leases and counters, never
Room/Copy URLs, keys, or Markdown.

## Vercel (preview/self-host compatibility)

The Vercel target uses `api/mcp.ts`, `api/health.ts`, `api/ready.ts`, and
`vercel.json`. It is retained to verify that the Web-standard handler bundles
outside Cloudflare.

Vercel Functions do not by themselves guarantee that successive stateful MCP
requests reach the process holding the Room connection. An operator must use a
single long-lived instance, sticky routing, or an external session coordinator.
Without that, Start/Join can appear to succeed and a later file tool can report
`session_not_found`. This is why Vercel is not the official production target.

Validate or deploy a trusted self-hosted preview:

```sh
npm run check:vercel
npm run deploy:vercel
```

## Trusted custom services

For trusted self-hosted Tabula services:

```sh
TABULA_MCP_ALLOWED_ROOM_SERVER_URLS=https://rooms.example.com
TABULA_MCP_ALLOWED_JSON_SERVER_URLS=https://json.example.com
```

`TABULA_MCP_ALLOW_ANY_EGRESS=1` disables egress protection and must not be used
for the official public endpoint.

## Validation

Run both deployment build checks and the complete release gate:

```sh
npm run check:deploy-targets
npm run release:verify
```
