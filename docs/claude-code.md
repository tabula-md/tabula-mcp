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

Claude should call `tabula_join_room`, list relevant paths, and use
`tabula_read_file` for one file or line range. It then calls
`tabula_edit_file` for exact replacements or `tabula_write_file` for a complete
single-file write, using the latest revision. `tabula_read_files` and
`tabula_write_files` are the batch alternatives. It can
pass Markdown read from the local filesystem directly to Start Session, Export
Copy, or Write Files.

Claude can create directories and move, rename, or delete Session paths with
the dedicated filesystem-shaped tools. Non-empty directory deletion requires
`recursive: true`.

For a received `#json` link, Claude calls `tabula_import_copy` and then uses its
host file tools to materialize the returned relative Markdown paths. It must
ask before overwriting existing files. Import Copy is not a live Session.

There is no legacy tool adapter. Restart Claude Code after upgrading so it
reloads the fourteen core tool definitions.
