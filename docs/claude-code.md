# Claude Code

Install the Tabula plugin or configure the published stdio server:

```sh
claude mcp add tabula -- npx -y @tabula-md/mcp@0.2.0
```

Suggested prompt:

```text
Use your Tabula tools to join this room and work with me.
Keep the room URL private.
https://tabula.md/#room=...
```

Claude should call `tabula_join_room`, list and read the relevant file, then call `tabula_write_file` once with the latest revision.

Version 0.2 has no legacy tool adapter. Restart Claude Code after upgrading so it reloads the nine core tool definitions.
