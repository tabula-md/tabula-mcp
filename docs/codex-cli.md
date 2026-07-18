# Codex CLI

Add Tabula as a local stdio MCP server:

```sh
codex mcp add tabula -- npx -y @tabula-md/mcp@latest
```

Join and edit a session:

```text
join_room
→ list_files
→ read_file
→ edit_file / write_file
```

`read_file` supports a bounded line range, head-like reads, and `tailLines`.
`edit_file` applies exact text replacements and safely
rebases a stale edit only when its text anchor still matches. It returns a
bounded diff. `write_file` creates or completely replaces one file.
The plural Read/Write tools remain available for small reads and atomic
multi-file writes. All writes validate revisions, and the server computes the
Yjs patches. Codex should never construct text offsets or low-level workspace
changes.

`create_directory`, `move_file`, and `delete_path` expose
the remaining familiar filesystem operations. Move File also renames files and
directories when the destination changes only the name.

`list_comments`, `add_comment`, `reply_to_comment`, `resolve_comment`, and
`delete_comment` expose the same comment threads shown in Tabula. Line comments
use inclusive `startLine` and `endLine` values; omit both for a file comment.

All Room operations use the explicit `sessionId` returned by `join_room` or
`start_session`, so several Rooms can remain connected without an active-Room
fallback. `leave_session` disconnects one agent connection without deleting
the Room or its files.

Codex can read local Markdown files with its filesystem tools, then pass them to
`export_copy` for a fixed encrypted `#json` copy, `start_session` for a new live
workspace, or `write_file` / `write_files` for an existing session.

When Codex receives a `#json` link, it calls `import_copy`, then uses its
own filesystem tools to create the returned relative paths under the folder the
user selected. Import Copy does not join a Session and never writes local files
by itself.

Keep all `#room` and `#json` URLs private unless the user explicitly asks to share them.
