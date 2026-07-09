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
4. `tabula_read_workspace_document`
5. `tabula_propose_workspace_changes`

The default workflow is proposal-first. `tabula_propose_workspace_changes`
emits an encrypted `workspace.proposal.created` room event and does not directly
mutate the workspace.

Codex can also create the collaboration surface first:

1. `tabula_create_workspace` or `tabula_import_markdown_workspace`
2. `tabula_share_workspace` for an encrypted `#json` handoff, or
   `tabula_create_workspace_room` for a new live `#room` link
3. `tabula_propose_workspace_changes` for follow-up edits after collaborators
   join the room

## Approval Behavior

`tabula_connect_room` opens a live room connection and receives a URL whose
`#room` fragment contains the room key. Codex CLI may therefore require approval
before calling it, especially in non-interactive runs. That is intentional: room
URLs are bearer secrets and the MCP process becomes a trusted plaintext room
participant after connecting.

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
4. submit `tabula_propose_workspace_changes`

The simulated peer received and decrypted a `workspace.proposal.created` event
from an actor with:

```json
{
  "kind": "agent",
  "name": "Codex CLI Agent",
  "client": "tabula-mcp"
}
```
