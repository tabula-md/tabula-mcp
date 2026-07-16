<p align="center">
  <a href="https://tabula.md">
    <img src="https://tabula.md/favicon.svg" alt="Tabula.md" width="56" />
  </a>
</p>

# Tabula.md MCP

Connect Codex, Claude, and other MCP clients to shared Tabula.md workspaces.

An agent can start with a private Markdown draft, join a live encrypted room,
or export a fixed encrypted copy for handoff.

## Choose a connection

**Local MCP** is the default for private work. The MCP process and its plaintext
working state stay on your device.

**Hosted MCP** is convenient for an HTTP-capable client, but the hosted service
processes the Markdown and room content that you give it. Do not use it for
content you would not trust to that service.

## Install

### Claude Desktop

Download the latest [Tabula.md MCP extension](https://github.com/tabula-md/tabula-mcp/releases/latest/download/tabula-mcp.mcpb),
install it, then restart Claude Desktop.

### Claude Code

Add the local stdio server:

```sh
claude mcp add tabula -- npx -y @tabula-md/mcp@latest
```

### Codex

Add the local stdio server:

```sh
codex mcp add tabula -- npx -y @tabula-md/mcp@latest
```

### Hosted MCP

Use the Streamable HTTP endpoint:

```text
https://mcp.tabula.md/mcp
```

## First handoff

Paste this into a client with Tabula MCP configured:

```text
Use your Tabula tools to join this room and work with me.
Keep the room URL private.
https://tabula.md/#room=...
```

The agent joins the room, finds and reads the relevant file, then writes its
change. The browser sees the update immediately.

## What agents can do

- **Draft** — create and revise a private Markdown draft.
- **Live session** — collaborate with people or other clients in a shared
  Tabula.md room.
- **Copy** — create an encrypted `#json` copy for a fixed handoff.

Use a live session when work should continue. Use a copy when the recipient
needs a snapshot instead of an ongoing workspace.

## References

- [Claude Desktop](docs/claude-desktop.md)
- [Claude Code](docs/claude-code.md)
- [Codex CLI](docs/codex-cli.md)
- [Self-hosting](docs/deployment.md)
- [Security model](docs/security-model.md)
- [Privacy policy](PRIVACY.md)
- [Changelog](CHANGELOG.md)

## License

MIT
