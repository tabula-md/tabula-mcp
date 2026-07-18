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

Claude should call `join_room`, list relevant paths, and use `read_file` for
one file or line range. It then calls `edit_file` for exact replacements or
`write_file` for a complete single-file write, using the latest revision.
`read_multiple_files` and `write_files` are the batch alternatives. It can
pass Markdown read from the local filesystem directly to Start Session, Export
Copy, or Write Files.

Claude can create directories and move, rename, or delete Session paths with
the dedicated filesystem-shaped tools. Non-empty directory deletion requires
`recursive: true`.

Every Room file call uses the `sessionId` returned by `join_room` or
`start_session`. Claude can stay connected to several Rooms without an active
Room fallback. Ask it to call `leave_session` when it should disconnect from
one Session; leaving does not delete Room files.

For a received `#json` link, Claude calls `import_copy` and then uses its
host file tools to materialize the returned relative Markdown paths. It must
ask before overwriting existing files. Import Copy is not a live Session.

There is no legacy tool adapter. Restart Claude Code after upgrading so it
reloads the fifteen core tool definitions.
