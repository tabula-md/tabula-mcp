<p align="center">
  <a href="https://tabula.md">
    <img src="https://tabula.md/favicon.svg" alt="Tabula" width="56" />
  </a>
</p>

# Tabula MCP

Connect Codex, Claude, and other MCP clients to shared Tabula workspaces.

Draft in Claude, Codex, or the local filesystem. Tabula receives Markdown only
when an agent joins or starts a live encrypted session, or exports a fixed
encrypted copy for handoff.

## Choose a connection

**Local MCP** is the default for private work. The MCP process and its plaintext
working state stay on your device.

**Hosted MCP** is convenient for an HTTP-capable client, but the hosted service
processes the Markdown and room content that you give it. Do not use it for
content you would not trust to that service.

## Install

### Claude Desktop

Download the latest [Tabula MCP extension](https://github.com/tabula-md/tabula-mcp/releases/latest/download/tabula-mcp.mcpb),
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

- **Live session** — start from one or more Markdown files, or join an existing
  Tabula room and collaborate with people or other clients.
- **Copy** — export one or more Markdown files as an encrypted `#json` snapshot,
  or import a received copy as relative paths and Markdown for the agent to
  materialize in a user-chosen local folder.
- **Workspace files** — list, read, search, and atomically write files and
  nested folders in a connected session.
- **Comments** — read comment threads, add file-level or line-anchored
  comments, reply, resolve or reopen, and delete threads when requested.

Use a live session when work should continue. Use a copy when the recipient
needs a snapshot instead of an ongoing workspace.

Importing a copy does not join a room or write to the filesystem. The agent
uses its host-native file tools, so local path access and overwrite approval
remain under the host's control.

## References

- [Claude Desktop](docs/claude-desktop.md)
- [Claude Code](docs/claude-code.md)
- [Codex CLI](docs/codex-cli.md)
- [Self-hosting](docs/deployment.md)
- [Security model](docs/security-model.md)
- [Privacy policy](PRIVACY.md)
- [Changelog](CHANGELOG.md)

## Backed By

Tabula MCP is backed by
[Marker Inc Korea](https://github.com/Marker-Inc-Korea).

## License

MIT
