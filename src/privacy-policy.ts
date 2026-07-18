export const tabulaMcpPrivacyPolicyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tabula MCP Privacy Policy</title>
    <style>
      body { color: #172033; font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
      main { margin: 0 auto; max-width: 760px; padding: 48px 24px 80px; }
      h1, h2 { line-height: 1.25; }
      h1 { margin-bottom: 4px; }
      .effective { color: #5d6b82; margin-top: 0; }
      a { color: #1455a4; }
      code { background: #f1f4f8; border-radius: 4px; padding: 1px 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Tabula MCP Privacy Policy</h1>
      <p class="effective">Effective date: July 19, 2026</p>
      <p>Tabula MCP hands Markdown files to encrypted Tabula collaboration sessions and fixed encrypted copies. It processes only the files, workspace structure, comments, room state, and URLs that you explicitly give it.</p>

      <h2>Host-native Markdown and local MCP</h2>
      <p>Drafts created in Claude, Codex, ChatGPT, or a local filesystem are not copied into a Tabula private-document database. Markdown reaches Tabula MCP only when an agent starts or joins a live session, or exports or imports an encrypted copy.</p>
      <p>The local npm, Claude Code, Codex, and Claude Desktop MCPB modes hold room keys and decrypted live-session state in the local MCP process memory. Leaving or closing a session clears that process state.</p>

      <h2>Hosted MCP endpoint</h2>
      <p>When you use <code>https://mcp.tabula.md/mcp</code> or another remote deployment, that service is a trusted plaintext processor for the Markdown, comments, room keys, and room state supplied while the MCP session is active. The official endpoint does not maintain a separate plaintext private-draft or document-checkpoint database. Use local MCP when plaintext must remain on your device.</p>

      <h2>Encrypted rooms and copies</h2>
      <p>A complete Tabula Room or Copy URL contains its decryption key in the URL fragment and must be treated as a bearer secret. Room relays receive encrypted collaboration envelopes. Optional Firebase recovery receives encrypted Yjs checkpoint blobs and opaque generation metadata. The Tabula JSON service receives encrypted Copy bytes and an identifier. These services do not receive the decryption key from the MCP server as part of the upload path.</p>

      <h2>Providers, logging, and contact</h2>
      <p>Depending on the workflow, data can be processed by your MCP client and device; the hosted MCP provider during an active session; the encrypted Room relay; the encrypted Copy service; and Firebase when encrypted room recovery is enabled. Tabula does not sell document content or use it for advertising.</p>
      <p>The official hosted endpoint emits operational logs and is configured not to intentionally log plaintext Markdown, URL fragments, room keys, or complete Room/Copy URLs. Do not include these secrets in public support channels. For non-sensitive privacy questions, use <a href="https://github.com/tabula-md/tabula-mcp/issues">the Tabula MCP issue tracker</a>.</p>
    </main>
  </body>
</html>`;
