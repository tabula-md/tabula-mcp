# Deployment

Tabula MCP supports two hosted deployment targets:

- Vercel Functions through `api/mcp.ts` and `vercel.json`
- Cloudflare Workers through `workers/tabula-mcp-worker.ts` and `wrangler.jsonc`

The same MIT-licensed repository is intended to power self-hosted deployments
and the official hosted target:

```txt
https://mcp.tabula.md/mcp
```

Cloudflare Workers is the preferred target for the official hosted service.
Vercel remains supported for previews, self-hosting, and compatibility testing.

The official `mcp.tabula.md` endpoint is a public app-style MCP endpoint. It
does not require a bearer token, matching Tabula.md's no-login document product.
Keep authenticated account/workspace MCP on a separate future API endpoint.

Both targets use the shared Web-standard MCP handler in `src/server/web.ts`.
Both expose:

- `GET /` for service metadata
- `GET /health` for health metadata
- `GET /ready` for checkpoint-store readiness
- `/mcp` for Streamable HTTP MCP
- `/sse` and `/message` as compatibility rewrites to `/mcp`

## Production Checkpoint Store

Hosted MCP document checkpoints are plaintext working state for agent editing.
Do not use the default memory store for official production traffic. Configure
Upstash Redis or Vercel KV-compatible REST credentials:

```sh
TABULA_MCP_DEPLOYMENT_MODE=remote
TABULA_MCP_PRODUCTION=1
TABULA_MCP_PUBLIC_UNAUTHENTICATED=1
TABULA_MCP_DOCUMENT_STORE_DRIVER=redis
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

The same store is used by both Vercel and Cloudflare deployments. Export/share
still goes through `tabula-json` as encrypted `#json` snapshot links.
When production mode is enabled, startup fails if the auth token is missing
unless `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` is explicitly set. Redis REST
credentials are required by default. Excalidraw-style production memory fallback
is available only when both `TABULA_MCP_DOCUMENT_STORE_DRIVER=memory` and
`TABULA_MCP_ALLOW_MEMORY_STORE=1` are set; public unauthenticated production
still rejects that memory fallback and must use Redis.

## Public Endpoint Guardrails

Production mode is enabled by `TABULA_MCP_PRODUCTION=1`,
`TABULA_MCP_PUBLIC_ENDPOINT=1`, or Vercel's production runtime. In production:

- `/mcp` requires `Authorization: Bearer <TABULA_MCP_AUTH_TOKEN>` unless `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` is set.
- `TABULA_MCP_PUBLIC_UNAUTHENTICATED=1` makes `/mcp` public/no-auth and ignores any configured auth token.
- memory document checkpoints require explicit unsafe opt-in; configure Redis/Upstash REST for official production.
- browser requests with an `Origin` header are rejected unless the origin is in
  `TABULA_MCP_ALLOWED_ORIGINS`.
- remote room/workspace tools require stateful MCP HTTP sessions because connected
  room transports and workspace state live across tool calls.
- MCP request bodies are capped by `TABULA_MCP_HTTP_MAX_REQUEST_BYTES`.
- per-client request rate is capped by `TABULA_MCP_RATE_LIMIT_MAX` per
  `TABULA_MCP_RATE_LIMIT_WINDOW_MS`.
- active in-memory MCP sessions are capped by `TABULA_MCP_MAX_ACTIVE_SESSIONS`
  and pruned after `TABULA_MCP_SESSION_IDLE_TTL_MS`.
- request handling is bounded by `TABULA_MCP_REQUEST_TIMEOUT_MS`.
- structured JSON request logs are controlled by `TABULA_MCP_LOG_LEVEL`.

Hosted production exposes the same agent workspace surface as local stdio:
workspace creation/import from inline files, encrypted workspace export, room
creation, and room connection. A hosted MCP server that joins a room becomes a
trusted plaintext processor for that room key and decrypted Markdown. Deploy
stateful sessions behind sticky routing, a single instance, or a future Durable
Object session coordinator.

## Vercel

The Vercel target uses:

- `vercel.json`
- `api/mcp.ts`
- `api/health.ts`
- `api/ready.ts`

Configure environment variables in Vercel project settings or with the Vercel
CLI:

```sh
TABULA_MCP_DEPLOYMENT_MODE=remote
TABULA_MCP_PRODUCTION=1
TABULA_MCP_ALLOWED_ORIGINS=https://tabula.md
TABULA_MCP_PUBLIC_UNAUTHENTICATED=1
TABULA_MCP_DOCUMENT_STORE_DRIVER=redis
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

Deploy:

```sh
npm run deploy:vercel
```

Validate locally before deploying:

```sh
npm run check:vercel
```

## Cloudflare Workers

The Cloudflare target uses:

- `wrangler.jsonc`
- `workers/tabula-mcp-worker.ts`

`wrangler.jsonc` enables `nodejs_compat`, runs `npm run build` before bundling,
and imports the generated `dist/document-app.html` as a text module.

Set Redis REST credentials as secrets:

```sh
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Set non-secret environment values in `wrangler.jsonc` or through your deployment
environment:

```json
{
  "vars": {
    "TABULA_MCP_DEPLOYMENT_MODE": "remote",
    "TABULA_MCP_PRODUCTION": "1",
    "TABULA_MCP_PUBLIC_UNAUTHENTICATED": "1",
    "TABULA_MCP_ALLOWED_ORIGINS": "https://tabula.md",
    "TABULA_MCP_DOCUMENT_STORE_DRIVER": "redis"
  }
}
```

Deploy:

```sh
npm run deploy:cloudflare
```

Validate bundling without deploying:

```sh
npm run check:cloudflare
```

## Session Boundary

Remote deployments use stateful HTTP sessions because the public tool surface
includes room/workspace operations. Stateful mode keeps active MCP transports,
connected room sessions, and local workspace state in runtime memory. For
production stateful deployments, use sticky routing, a single instance, or a
future Cloudflare Durable Object session coordinator.

`TABULA_MCP_STATELESS_HTTP=1` is rejected for remote deployments. You may set
`TABULA_MCP_STATEFUL_HTTP=1` explicitly, but it is already the remote default.

## Validation

Run both deployment target checks:

```sh
npm run check:deploy-targets
```

The release gate includes this check.
