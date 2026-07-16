# Release

## Verify

```sh
npm ci
npm run release:verify
```

For a live local collaboration check:

```sh
npm run release:verify:full
```

Public releases use `.github/workflows/release.yml` on tags shaped as
`v<package-version>`. The npm Trusted Publisher must authorize the canonical
repository and workflow. The workflow publishes with OIDC provenance, creates
the GitHub Release, uploads versioned and stable MCPB artifacts, and verifies
the public npm and GitHub surfaces.

## Build artifacts

```sh
npm run build:mcpb
npm run check:mcpb
npm pack --dry-run
```

Expected version alignment for this release:

```text
@tabula-md/mcp             0.2.2
tabula-mcp MCPB            0.2.2
Claude Code plugin         0.2.2
mcp.tabula.md health       0.2.2
```

`npm run release:pack` produces both versioned and stable artifacts:

```text
dist/tabula-mcp-0.2.2.mcpb
dist/tabula-mcp-0.2.2.mcpb.sha256
dist/tabula-mcp.mcpb
dist/tabula-mcp.mcpb.sha256
```

The stable artifact supports the permanent latest-release URL:
`https://github.com/tabula-md/tabula-mcp/releases/latest/download/tabula-mcp.mcpb`.

## Manual acceptance

1. Install `dist/tabula-mcp-0.2.2.mcpb` and restart Claude Desktop.
2. Confirm exactly nine core tools are loaded.
3. Create a Draft.
4. Use **Open a copy** and confirm the resulting `#json` opens in Tabula.md.
5. Use **Start session** and confirm the Room opens.
6. From another Tabula client, edit the Room.
7. Ask Claude to list, read, and write one file.
8. Confirm one `tabula_write_file` call succeeds without validation retries.
9. Export the live Session and confirm nested folders survive the Copy.

## Deployment

Publish npm first, then deploy the hosted MCP and distribute the matching MCPB/plugin. Restart clients after replacing 0.1.x because 0.2.0 intentionally removes the old tool names and does not register a legacy adapter.
