# Tabula MCP Privacy Policy

Effective date: July 19, 2026

Tabula MCP is an open-source MCP server and MCP App for handing Markdown files
to encrypted Tabula collaboration sessions and fixed encrypted copies. This
policy explains what the software processes in local and hosted modes.

## What Tabula MCP processes

Tabula MCP processes the Markdown files, workspace structure, comments, room
connection state, and URLs that you explicitly give it. A complete Tabula
`#room` or `#json` URL contains a decryption key in its fragment. Treat the URL
as a bearer secret and share it only with intended people or agents.

## Host-native Markdown and local MCP

Creating or editing a draft in Claude, Codex, ChatGPT, or a local filesystem
does not copy that draft into a Tabula private-document database. Markdown is
sent to Tabula MCP only when an agent is asked to start or join a live session,
or to export or import a fixed encrypted copy.

The default npm, Claude Code, Codex, and Claude Desktop MCPB modes run on your
computer. While connected to a live session, the local MCP process holds the
room key and decrypted working state in memory so it can read and apply
changes. Closing or leaving the session clears that process state.

## Encrypted rooms and encrypted copies

The Room relay receives encrypted collaboration envelopes, not room keys or
plaintext Markdown. Optional Firebase room recovery receives encrypted Yjs
checkpoint blobs and opaque generation metadata. The room key remains in the
client-only URL fragment.

For `#json` copies, Tabula MCP encrypts the workspace before uploading it. The
Tabula JSON service receives encrypted bytes and an identifier; the decryption
key remains in the URL fragment. Retention for encrypted relays, recovery, and
copy storage follows the deployed service policies.

## Hosted MCP endpoint

When you use `https://mcp.tabula.md/mcp` or another remote Tabula MCP
deployment, that MCP service becomes a trusted plaintext processor for the
Markdown, comments, room keys, and room state you give it while the MCP session
is active. The official endpoint keeps active working state in its stateful
session runtime; it does not maintain a separate plaintext private-draft or
document-checkpoint database. Use local MCP when plaintext must remain on your
device.

## Service providers and logging

Depending on the workflow, data can be processed by your MCP client and device;
the hosted MCP provider while a session is active; the Tabula Room relay for
encrypted envelopes; the Tabula JSON service for encrypted copies; and Firebase
Storage and Firestore when encrypted room recovery is enabled. Tabula does not
sell document content or use it for advertising.

The official hosted endpoint emits operational logs for reliability and abuse
protection. It is configured not to intentionally log plaintext Markdown, URL
fragments, room keys, or complete Room/Copy URLs. Network providers can still
process ordinary metadata such as IP address, request time, and user-agent under
their own policies.

## Choices and contact

You can use local MCP, choose a trusted self-hosted endpoint, leave a live
session, or avoid hosted room recovery. Do not put Room links, Copy links,
document contents, or other secrets in public support channels. For
non-sensitive privacy questions, open an issue at
https://github.com/tabula-md/tabula-mcp/issues. Use GitHub private vulnerability
reporting for security reports.
