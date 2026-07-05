# Contributing

Tabula MCP is MIT-licensed and intended to be usable as a local MCP server,
MCPB package, self-hosted HTTP endpoint, and the basis for the official hosted
`mcp.tabula.md` deployment.

## Development

```sh
npm install
npm run build
npm test
```

Before sending a release-oriented change, run:

```sh
npm run release:verify
```

## Scope

Keep patches scoped to `tabula-mcp`. Changes to `tabula-md`, `tabula-room`,
`tabula-json`, or infrastructure repositories should be separate unless the
maintainers explicitly request a coordinated change.

## Production Defaults

Hosted production behavior should stay safe by default:

- local HTTP binds to `127.0.0.1` unless a host is configured
- production remote HTTP requires `TABULA_MCP_AUTH_TOKEN`
- production remote checkpoints require Redis/Upstash REST credentials
- production browser Origins are denied unless `TABULA_MCP_ALLOWED_ORIGINS` is configured
- remote room tools stay disabled unless `TABULA_MCP_ALLOW_REMOTE_ROOM=1`

If a change weakens one of these defaults, document why and add tests covering
the new boundary.
