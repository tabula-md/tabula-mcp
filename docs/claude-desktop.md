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

Ask Claude to turn its current writing into a live workspace:

```text
Write a short project brief, then start a Tabula session with it.
```

Ask Claude to join a session:

```text
Use your Tabula tools to join this room and work with me.
Keep the room URL private.
https://tabula.md/#room=...
```

The expected write flow is:

```text
Join Session → List Files → Read Files → Write File / Write Files
```

For a fixed handoff, Claude can call **Import Copy** with a private `#json`
link. It receives relative Markdown paths and contents for host-native local
file creation; it does not join a live Session or write files by itself.

Claude Desktop's approval setting governs mutating MCP calls. A writable Tabula MCP connection does not require a second in-product agent permission.

The compact MCP App appears only after Claude finishes **Start Session** or
**Export Copy**. It offers **Open session** or **Open copy**, respectively.
Writing documents and joining an existing Session do not render redundant App cards.

The card is a presentation-only handoff surface. It does not call MCP tools or
depend on the App sharing Claude's in-memory Room session. Editing continues in
Tabula.md.
