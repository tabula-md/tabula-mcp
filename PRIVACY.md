# Tabula MCP Privacy Policy

Effective date: July 16, 2026

Tabula MCP is an open-source MCP server and MCP App for working with
Markdown documents and encrypted Tabula collaboration rooms. This policy
explains what the software stores and where it goes in its local and hosted
modes.

## What Tabula MCP processes

Tabula MCP processes Markdown document content, document titles, workspace
structure, room connection state, and the URLs you provide to it. A Tabula room
URL or Tabula JSON snapshot URL contains a secret in its URL fragment. Treat
the complete URL as a bearer secret and share it only with intended people or
agents.

## Local stdio and Claude Desktop MCPB

The default npm, Claude Code, and Claude Desktop MCPB modes run on your
computer. By default, saved MCP document checkpoints are plaintext files in the
local application-state directory:

- macOS: `~/Library/Application Support/Tabula MCP/documents`
- Windows: `%LOCALAPPDATA%\\Tabula MCP\\documents`
- Linux: `$XDG_STATE_HOME/tabula-mcp/documents` or
  `~/.local/state/tabula-mcp/documents`

The MCP App may also retain an unsaved plaintext draft in the host browser or
desktop-app local storage so it can recover after a refresh. You can disable
saved local checkpoints with `TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS=1` or set
`TABULA_MCP_DOCUMENT_STORE_DIR` to a location you control. Local checkpoints
remain until you remove them or your operating system or storage policy removes
them; Tabula does not receive them in this mode. Existing installations that
already use a `Tabula.md MCP/documents` directory continue using it so local
checkpoints are not lost during the product-name migration.

## Encrypted rooms and encrypted snapshot links

When you connect a Tabula room, Tabula MCP decrypts room Markdown locally so
your MCP client can read or change it. The room key stays in the URL fragment
and is not sent to the Tabula Room server. The Room server receives encrypted
collaboration envelopes, not plaintext Markdown, room keys, or decrypted
presence data.

When you share a document or workspace as a `#json` link, Tabula MCP encrypts
the snapshot locally. The Tabula JSON service receives the encrypted bytes and
snapshot identifier; the decryption key stays in the URL fragment. Optional
Firebase room-recovery storage receives encrypted Yjs checkpoint blobs and
opaque generation metadata, not plaintext Markdown or room keys. Retention for
those encrypted services is controlled by their respective deployed service
policies.

## Hosted MCP endpoint

If you choose the hosted `https://mcp.tabula.md/mcp` endpoint or another remote
Tabula MCP deployment, the remote MCP service becomes a trusted processor for
the Markdown and room content sent to it. Hosted MCP document checkpoints are
plaintext working state and may be stored in the configured Redis or
KV-compatible checkpoint store. The official deployment configures a 30-day
maximum checkpoint lifetime; a self-hosted operator can choose a different
retention period. Do not use a hosted endpoint for content you are not willing
to place within that endpoint and its configured checkpoint-store trust
boundary.

## Service providers and sharing

Tabula does not sell personal data or use document content for advertising.
Depending on the workflow and deployment selected, data can be processed by:

- your MCP client and local device;
- the hosted MCP provider and its configured checkpoint store for remote MCP
  working state;
- the Tabula Room relay for encrypted room envelopes;
- the Tabula JSON snapshot service for encrypted snapshot bytes; and
- Firebase Storage and Firestore only when encrypted room recovery is enabled.

We may receive the information you deliberately put in a GitHub issue or other
support request. Do not include room links, snapshot links, document contents,
or other secrets in public support channels.

## Logging and security

The official hosted endpoint emits operational request logs for reliability and
abuse protection. Logging is configured not to intentionally record plaintext
Markdown or URL fragments. Network providers can still process ordinary service
metadata such as IP address, request time, and user-agent information under
their own policies. No system can make a bearer URL safe after it has been
shared; revoke access by creating a new room or snapshot instead of publishing
the complete URL.

## Choices and contact

You can use the local stdio/MCPB mode, disable local checkpoint persistence,
choose a self-hosted endpoint, remove locally stored checkpoints, or avoid
hosted room recovery. For non-sensitive privacy questions, open an issue at
https://github.com/tabula-md/tabula-mcp/issues. Use GitHub private vulnerability
reporting for security reports. Do not include secrets in either channel.
