# Codex CLI

Configure Tabula as a stdio MCP server:

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

Join and edit a session:

```text
tabula_join_room
→ tabula_list_files
→ tabula_read_file
→ tabula_write_file
```

`tabula_write_file` receives complete Markdown. The server validates the revision and computes the Yjs patch. Codex should never construct text offsets or low-level workspace changes.

Use `tabula_export_copy` to produce a fixed encrypted `#json` copy. Use `tabula_start_session` when collaborators should continue editing together.

Keep all `#room` and `#json` URLs private unless the user explicitly asks to share them.
