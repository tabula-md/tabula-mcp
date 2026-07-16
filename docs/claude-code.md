# Claude Code

Install the Tabula plugin or configure the published stdio server:

```sh
claude mcp add tabula -- npx -y @tabula-md/mcp@latest
```

Suggested prompt:

```text
Use your Tabula tools to join this room and work with me.
Keep the room URL private.
https://tabula.md/#room=...
```

Claude should call `tabula_join_room`, list and read relevant files, then call
`tabula_write_file` or `tabula_write_files` with the latest revisions. It can
pass Markdown read from the local filesystem directly to Start Session, Export
Copy, or Write Files.

Version 0.2 has no legacy tool adapter. Restart Claude Code after upgrading so
it reloads the eight core tool definitions.
