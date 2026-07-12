# Codex CLI

Tabula.md MCP can be used from Codex CLI as a local stdio MCP server. Build the
server first:

```sh
npm install
npm run build
```

## One-Off Configuration

For a one-off Codex CLI run without editing the global Codex config, pass the MCP
server as config overrides:

```sh
codex exec \
  -C /absolute/path/to/tabula-mcp \
  -c 'mcp_servers.tabula.command="node"' \
  -c 'mcp_servers.tabula.args=["/absolute/path/to/tabula-mcp/dist/index.js"]' \
  'Use the tabula MCP server tools. Call tabula_read_me with topic="rooms".'
```

For a persistent local setup, add the server with:

```sh
codex mcp add tabula -- node /absolute/path/to/tabula-mcp/dist/index.js
```

Then verify it is configured:

```sh
codex mcp list --json
```

## Room Workflow

Codex can join an encrypted Tabula room as an agent actor:

1. `tabula_connect_room`
2. `tabula_wait_for_changes`
3. `tabula_read_workspace`
4. `tabula_read_workspace_context` for bounded planning context. Use
   `documentIds`, `pathGlobs`, `query`, and `changedSince` to avoid loading
   unrelated documents, or use
   `tabula_read_workspace_document` when exact full text is needed
5. `tabula_apply_workspace_changes`

`tabula_read_workspace` defaults to summary metadata. Pass `detail: "tree"`
only when folder/node structure is needed.

If the client surface supports MCP resources, the read tools also return
`tabula://...` `resourceUri` handles for read-only workspace metadata and
Markdown. Codex workflows should still work through tools alone.

The workflow is direct collaboration. `tabula_apply_workspace_changes` emits
encrypted document-scoped `text.updated` Yjs updates and `workspace.updated`
tree state, matching the Tabula.md room contract.

Codex can also create the collaboration surface first:

1. `tabula_create_workspace` or `tabula_import_markdown_workspace`
2. `tabula_share_workspace` for an encrypted `#json` handoff, or
   `tabula_create_workspace_room` for a new live `#room` link
3. Check the returned `checkpointStatus`; Firebase-configured sessions should
   report `saved`, while local relay-only sessions report `disabled`
4. `tabula_apply_workspace_changes` for follow-up edits after collaborators
   join the room

`tabula_import_markdown_workspace` can always use `source.files`. `source.type:
local-path` is limited to MCP client roots when the client supports roots, or to
directories explicitly listed in `TABULA_MCP_ALLOWED_IMPORT_ROOTS`.

## Approval Behavior

`tabula_connect_room` opens a live room connection and receives a URL whose
`#room` fragment contains the room key. Codex CLI may therefore require approval
before calling it, especially in non-interactive runs. That is intentional: room
URLs are bearer secrets and the MCP process becomes a trusted plaintext room
participant after connecting.
When Firebase room checkpoints are configured, `tabula_connect_room` first tries
to load encrypted room recovery state and reports that in `checkpointStatus`.

For unattended local test automation only, Codex CLI can be run with:

```sh
codex exec --dangerously-bypass-approvals-and-sandbox ...
```

Do not use that flag as the default user workflow. Interactive Codex CLI users
should review and approve the room connection.

## Local E2E Check Used For This Repo

The local Codex CLI smoke used for this branch ran a temporary `tabula-room`
relay, joined a simulated Tabula peer, and asked a real `codex exec` agent to:

1. connect to the room with `tabula_connect_room`
2. wait for encrypted workspace state
3. read workspace metadata and one workspace document
4. submit `tabula_apply_workspace_changes`

The simulated peer received and decrypted `text.updated` and `workspace.updated`
events from an actor with:

```json
{
  "kind": "agent",
  "name": "Codex CLI Agent",
  "client": "tabula-mcp"
}
```
