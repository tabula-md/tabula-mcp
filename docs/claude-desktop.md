# Claude Desktop

## Install the local MCPB

Download the latest public bundle from
[GitHub Releases](https://github.com/tabula-md/tabula-mcp/releases/latest/download/tabula-mcp.mcpb).

For a local development build:

```sh
npm ci
npm run build:mcpb
```

Open the generated `dist/tabula-mcp-*.mcpb`, install it, and restart Claude Desktop. Packaging also creates stable `dist/tabula-mcp.mcpb` and `dist/tabula-mcp.mcpb.sha256` aliases for the latest-release download. When replacing an older build, a full restart is required because Claude Desktop caches MCP App resources and tool definitions.

## Use

Ask Claude to create a private draft:

```text
Create a Tabula draft with a short project brief.
```

Ask Claude to join a session:

```text
Use your Tabula tools to join this room and work with me.
Keep the room URL private.
https://tabula.md/#room=...
```

The expected write flow is:

```text
Join Session → List Files → Read File → Write File
```

Claude Desktop's approval setting governs mutating MCP calls. A writable Tabula MCP connection does not require a second in-product agent permission.

The compact MCP App card offers:

- Draft: **Open a copy**, **Start session**
- Session: **Open session**, **Export copy**

The card is a handoff surface. Editing continues in Tabula.md.
