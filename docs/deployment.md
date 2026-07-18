# Deployment

Tabula MCP supports two hosted deployment targets:

- Vercel Functions through `api/mcp.ts` and `vercel.json`
- Cloudflare Workers through `workers/tabula-mcp-worker.ts` and `wrangler.jsonc`

The same MIT-licensed repository is intended to power self-hosted deployments
and the official hosted target:

```txt
https://mcp.tabula.md/mcp
```

Cloudflare Workers is the preferred target for the official hosted service. The
Cloudflare target routes `/mcp` traffic through a `TabulaMcpSessionDurableObject`
binding so each MCP session id is pinned to one stateful Durable Object.
Vercel remains supported for previews, self-hosting, and compatibility testing.

The official `mcp.tabula.md` endpoint is a public app-style MCP endpoint. It
does not require a bearer token, matching Tabula's no-login document product.
Keep authenticated account/workspace MCP on a separate future API endpoint.

Both targets use the shared Web-standard MCP handler in `src/server/web.ts`.
Both expose:

- `GET /` for service metadata
- `GET /health` for version, write policy, and process health metadata
- `GET /ready` for the same runtime contract plus checkpoint-store readiness
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

The hosted connector has read/write Room capabilities by default; the MCP host
controls approval for each mutating call. Start it with `--read-only` only for
a review-only deployment. Confirm the effective policy through `GET /health`
before advertising live agent editing.

The same store is used by both Vercel and Cloudflare deployments. Export/share
still goes through `tabula-json` as encrypted `#json` snapshot links.
Live room recovery is a separate encrypted checkpoint path: configure
`TABULA_MCP_FIREBASE_CONFIG`, `TABULA_FIREBASE_CONFIG`, or
`VITE_TABULA_FIREBASE_CONFIG` with the Firebase Web SDK config used by
Tabula. The MCP server encrypts the complete workspace Y.Doc update locally
with the `#room` key, writes the ciphertext blob to Firebase Storage, and uses
Firestore only for the generation pointer.
Production runtimes use the Firebase Storage and Firestore REST APIs through
standard `fetch`; Firebase emulators continue to use the SDK transport. This
keeps the checkpoint format identical while avoiding browser-only APIs such as
`XMLHttpRequest` in Cloudflare Workers.
Local MCP exposes filesystem workspace import and accepts paths only when the
client provides filesystem roots or the operator sets
`TABULA_MCP_ALLOWED_IMPORT_ROOTS` to comma- or newline-separated directories.
Hosted MCP accepts inline `files` for host-native Markdown. A trusted self-hosted
operator can expose `local-path` for server-side directories by setting
`TABULA_MCP_ALLOWED_IMPORT_ROOTS`; those paths are on the server, never the
user's device.
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
- production egress for room and JSON services is restricted to official Tabula
  services plus `TABULA_MCP_ALLOWED_ROOM_SERVER_URLS` and
  `TABULA_MCP_ALLOWED_JSON_SERVER_URLS`. Firebase endpoints come from the
  operator-supplied Web SDK configuration.
- remote room/workspace tools require stateful MCP HTTP sessions because connected
  room transports and workspace state live across tool calls. Cloudflare uses a
  Durable Object session binding for this affinity; Vercel requires sticky
  routing, a single instance, or an external session coordinator.
- MCP request bodies are capped by `TABULA_MCP_HTTP_MAX_REQUEST_BYTES`.
- per-client request rate is capped by `TABULA_MCP_RATE_LIMIT_MAX` per
  `TABULA_MCP_RATE_LIMIT_WINDOW_MS`. Mutation calls have a separate
  `TABULA_MCP_MUTATION_RATE_LIMIT_MAX`, and Export Copy request bytes are
  bounded by `TABULA_MCP_EXPORT_BYTES_LIMIT` per
  `TABULA_MCP_EXPORT_LIMIT_WINDOW_MS`. Cloudflare routes every session from the
  same normalized client network prefix to the same quota shard, so opening a
  new MCP session does not reset these counters.
- active MCP sessions are capped per client by
  `TABULA_MCP_MAX_SESSIONS_PER_CLIENT` (default 10). Expiring leases are cleaned
  by Durable Object alarms after abnormal disconnects. Configure a coarse
  account-wide Cloudflare WAF/rate-limiting rule separately; the application
  deliberately avoids one global Durable Object that would serialize all users.
- one MCP connection may hold at most `TABULA_MCP_MAX_ROOMS_PER_SESSION`
  Room connections (default 8), and Cloudflare caps Room leases across a client
  quota shard with `TABULA_MCP_MAX_ROOMS_PER_CLIENT` (default 32). Room quota
  records contain only random connection IDs and expiry times, never Room URLs,
  keys, or Markdown. Leave Session releases one lease; MCP DELETE and Session
  Durable Object alarms release all remaining leases and WebSockets.
- Room file tools require the explicit `sessionId` returned by Join Room or
  Start Session. MCP Resources advertise parameterized URI templates but do not
  enumerate connected Room handles or file paths.
- request handling is bounded by `TABULA_MCP_REQUEST_TIMEOUT_MS`. A timeout
  aborts pre-commit Room work and closes its affected MCP session. A committed
  mutation keeps the session and its short-lived operation receipt so an exact
  retry returns the original result. Export uploads also keep the MCP session
  long enough to retry against the Copy service's idempotency key.
- structured JSON request logs are controlled by `TABULA_MCP_LOG_LEVEL`.

Hosted production exposes the same agent workspace surface as local stdio:
workspace creation/import from inline files, encrypted workspace export, room
creation, and room connection. A hosted MCP server that joins a room becomes a
trusted plaintext processor for that room key and decrypted Markdown.
Cloudflare deployments route stateful MCP sessions through
`TabulaMcpSessionDurableObject`; non-Cloudflare deployments need equivalent
session affinity.

For trusted self-hosted Tabula deployments, set:

```sh
TABULA_MCP_ALLOWED_ROOM_SERVER_URLS=https://rooms.example.com
TABULA_MCP_ALLOWED_JSON_SERVER_URLS=https://json.example.com
```

`TABULA_MCP_ALLOW_ANY_EGRESS=1` disables this protection and should not be used
on the official public endpoint.

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
VITE_TABULA_FIREBASE_CONFIG='{"apiKey":"...","projectId":"..."}'
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
- `TabulaMcpSessionDurableObject` for `/mcp` session affinity
- `TabulaMcpQuotaDurableObject` shards request and active-session limits by a
  secret HMAC of the normalized client network prefix

`wrangler.jsonc` enables `nodejs_compat`, runs `npm run build` before bundling,
imports the generated `dist/document-app.html` as a text module, and declares
the session and quota Durable Object bindings and migrations. The quota class
is introduced by the `v2` migration and must be deployed before production
traffic uses the updated Worker.

Set Redis REST credentials and the quota identity HMAC key as secrets:

```sh
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put TABULA_MCP_QUOTA_HASH_SECRET
```

Use a new random value for `TABULA_MCP_QUOTA_HASH_SECRET`; do not reuse the MCP
authorization token. The Worker never stores the source IP or Room/Copy URLs in
quota state. Rotating this secret resets quota shard identities.

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
connected room sessions, and local workspace state in runtime memory. The
Cloudflare Worker routes each MCP session id to `TabulaMcpSessionDurableObject`.
For Vercel or another platform, use sticky routing, a single instance, or an
external session coordinator.

`TABULA_MCP_STATELESS_HTTP=1` is rejected for remote deployments. You may set
`TABULA_MCP_STATEFUL_HTTP=1` explicitly, but it is already the remote default.

## Validation

Run both deployment target checks:

```sh
npm run check:deploy-targets
```

The release gate includes this check.
