# Tabula.md MCP

Connect Codex, Claude, and other MCP clients to shared Tabula.md workspaces.

[Open Tabula.md](https://tabula.md)

People work in Tabula.md. Agents use MCP to read and change the same Markdown
files. No Tabula.md account is required.

## Install

Requirements: Node.js `^20.19.0 || >=22.12.0`, npm, and an MCP client.

### Codex

```sh
codex mcp add tabula -- npx -y @tabula-md/mcp@latest
```

### Claude Code

```sh
claude mcp add tabula -- npx -y @tabula-md/mcp@latest
```

Claude Code can also install the repository plugin:

```sh
claude plugin marketplace add tabula-md/tabula-mcp
claude plugin install tabula-mcp@tabula-md
```

### Other local MCP clients

```json
{
  "mcpServers": {
    "tabula": {
      "command": "npx",
      "args": ["-y", "@tabula-md/mcp@latest"]
    }
  }
}
```

### Claude Desktop

Until the first public MCPB release is available, build the extension from this
repository with `npm run release:pack`. Then install
`dist/tabula-mcp-<version>.mcpb` by double-clicking it or from **Settings →
Extensions → Advanced settings → Install Extension**. No installer
configuration is required.

See [Claude Desktop setup](docs/claude-desktop.md) for the complete check.

## Use it

Give the agent a complete live-session invite and a concrete task:

```text
Join this Tabula.md session, review the workspace, and update findings.md:

https://tabula.md/#room=<roomId>,<roomKey>
```

The complete URL is a bearer secret. Anyone or any agent with it can decrypt
and edit the session. Do not put it in logs, issues, or public screenshots.

Local MCP connections allow changes by default. Codex, Claude, and other MCP
hosts still control approval for mutating tool calls. Start the server with
`--read-only` for inspection-only use.

Check an installation without reading files or secrets:

```sh
npx -y @tabula-md/mcp@latest --doctor
```

## Core workflows

### Join a live session

```text
tabula_connect_room
→ tabula_read_workspace
→ tabula_read_workspace_context
→ tabula_read_workspace_document when exact text is needed
→ tabula_apply_workspace_changes
→ tabula_wait_for_changes
```

### Start a live session from Markdown files

```text
tabula_import_markdown_workspace
→ tabula_create_workspace_room
→ share the returned #room URL
```

### Create a non-live copy link

```text
tabula_create_workspace or tabula_import_markdown_workspace
→ tabula_share_workspace
→ share the returned #json URL
```

Agents can create, read, rename, move, patch, and delete Markdown documents.
Changes use the latest document hash to avoid silently overwriting a newer
collaborator edit.

## Session Card

MCP App-compatible clients can show a compact Tabula.md Session Card.

- **Open a copy** creates an encrypted, non-live `#json` link.
- **Start session** creates a live `#room` and connects the agent.
- **Open session** continues in the full Tabula.md collaboration surface.

The card is a handoff surface, not a second editor. Clients without MCP Apps
support use the same workspace tools directly.

## Local and hosted modes

Local stdio or MCPB is the recommended path for private collaboration.

| Path | Runs in | Plaintext boundary | Best for |
| --- | --- | --- | --- |
| Local stdio or MCPB | Your device | Working drafts and room decryption stay in the local MCP process; the model receives content returned by tools | Private live-session work |
| Hosted MCP | Tabula.md infrastructure | The hosted MCP runtime is a trusted plaintext participant for the MCP session | Installation-free clients and MCP Apps |
| Tabula Room | Encrypted relay | Receives encrypted collaboration messages, not room keys or Markdown | Live synchronization |
| Tabula JSON | Encrypted snapshot store | Receives encrypted snapshot bytes, not snapshot keys or Markdown | Non-live copy links |

The official hosted endpoint is:

```text
https://mcp.tabula.md/mcp
```

Using it deliberately moves the MCP plaintext boundary to the hosted runtime.
This is separate from the blind Tabula Room relay. Read the
[security model](docs/security-model.md) before hosting or integrating the
remote endpoint.

## Service defaults

Hosted `https://tabula.md/#room=...` links use
`https://rooms.tabula.md`. Local Tabula.md development links use
`http://localhost:3002`.

Hosted `#json` copy links use `https://json.tabula.md`. Local development uses
`http://localhost:3004`.

Self-hosted deployments can override these services:

```sh
export TABULA_ROOM_URL=https://rooms.example.com
export TABULA_JSON_URL=https://json.example.com
```

Encrypted Firebase room recovery is optional for local sessions while a peer
remains connected. Hosted MCP must configure encrypted room recovery before it
can start a new live session. See [Deployment](docs/deployment.md) for Vercel,
Cloudflare, Redis, Firebase, origin policy, and production settings.

## Develop

```sh
npm install
npm test
npm run test:app
npm run test:stdio
```

Inspect the Session Card locally:

```sh
npm run dev:app
```

Open `http://127.0.0.1:5174/index-dev.html?tabula-dev=1` for a private draft or
add `&fixture=room` for a connected live session.

Build the npm server and MCP App:

```sh
npm run build
```

Build the one-click Claude Desktop bundle:

```sh
npm run release:pack
```

Run the complete release gate:

```sh
npm run release:verify
```

## Documentation

- [Codex CLI](docs/codex-cli.md)
- [Claude Code](docs/claude-code.md)
- [Claude Desktop](docs/claude-desktop.md)
- [Deployment](docs/deployment.md)
- [Security Model](docs/security-model.md)
- [MCP App Architecture](docs/mcp-app-architecture.md)
- [Release](docs/release.md)

## Privacy Policy

Read the [Tabula.md MCP Privacy Policy](PRIVACY.md) for local checkpoints,
hosted working state, encrypted services, retention, and support data.

## License

[MIT](LICENSE)
