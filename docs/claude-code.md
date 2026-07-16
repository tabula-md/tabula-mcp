# Claude Code

Tabula.md MCP can be installed directly from npm or through the repository's
Claude Code plugin marketplace.

## Direct install

```sh
claude mcp add tabula -- npx -y @tabula-md/mcp@latest --enable-write
```

Omit `--enable-write`, or replace it with `--read-only`, for inspection-only
room access. Restart Claude Code if the server does not appear immediately,
then run `/mcp` to verify it.

## Plugin install

Add the Tabula.md marketplace, then install its plugin:

```sh
claude plugin marketplace add tabula-md/tabula-mcp
claude plugin install tabula-mcp@tabula-md
```

Restart Claude Code, or run `/reload-plugins` in an active session.

The plugin starts the pinned `@tabula-md/mcp` npm package with `npx`. Node.js
and npm must therefore be available in the environment that starts Claude
Code.

## Verify

In Claude Code, run `/mcp` and confirm that `tabula` is listed as a plugin
server. Then ask Claude to call `tabula_read_me`.

For local marketplace development:

```sh
claude plugin validate .
claude plugin marketplace add /absolute/path/to/tabula-mcp
claude plugin install tabula-mcp@tabula-md
```

Remove the local marketplace after the check if you do not want it to replace
the GitHub marketplace entry with the same `tabula-md` name.

## Release Versioning

The plugin pins an explicit npm version. Every release that publishes a new
`@tabula-md/mcp` version must update both of these files to the same version:

- `plugins/tabula-mcp/.claude-plugin/plugin.json`
- `plugins/tabula-mcp/.mcp.json`

Run `npm run check:claude-plugin` to verify that the marketplace entry, plugin
metadata, and pinned package version stay aligned. `npm run release:pack` runs
this check automatically.
