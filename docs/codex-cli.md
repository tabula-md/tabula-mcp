# Codex CLI

Add Tabula as a local stdio MCP server:

```sh
codex mcp add tabula -- npx -y @tabula-md/mcp@latest
```

Join and edit a session:

```text
tabula_join_room
→ tabula_list_files
→ tabula_read_files
→ tabula_write_file / tabula_write_files
```

`tabula_write_file` receives complete Markdown. The server validates the revision and computes the Yjs patch. Codex should never construct text offsets or low-level workspace changes.

Codex can read local Markdown files with its filesystem tools, then pass them to `tabula_export_copy` for a fixed encrypted `#json` copy, `tabula_start_session` for a new live workspace, or `tabula_write_files` for an existing Session.

When Codex receives a `#json` link, it calls `tabula_import_copy`, then uses its
own filesystem tools to create the returned relative paths under the folder the
user selected. Import Copy does not join a Session and never writes local files
by itself.

Keep all `#room` and `#json` URLs private unless the user explicitly asks to share them.
