export const tabulaMcpPrivacyPolicyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tabula.md MCP Privacy Policy</title>
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
      <h1>Tabula.md MCP Privacy Policy</h1>
      <p class="effective">Effective date: July 16, 2026</p>
      <p>Tabula.md MCP is an open-source MCP server and MCP App for Markdown documents and encrypted Tabula.md collaboration rooms. This policy explains what the software stores and where it goes in local and hosted modes.</p>

      <h2>Data collection, use, and storage</h2>
      <p>Tabula MCP processes the Markdown, document titles, workspace structure, room connection state, and URLs you provide. In local npm, Claude Code, and Claude Desktop MCPB modes, saved document checkpoints are plaintext files on your device. The MCP App may also keep an unsaved plaintext draft in its local browser or desktop-app storage for recovery. Tabula.md does not receive that local working state.</p>
      <p>You can disable saved local checkpoints with <code>TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS=1</code>, choose a different local directory with <code>TABULA_MCP_DOCUMENT_STORE_DIR</code>, or remove the local data yourself.</p>

      <h2>Hosted MCP endpoint</h2>
      <p>When you use <code>https://mcp.tabula.md/mcp</code> or another remote deployment, that MCP service is a trusted processor for the Markdown and room content supplied to it. Hosted document checkpoints are plaintext working state and can be stored in the configured Redis or KV-compatible checkpoint store. The official deployment sets a maximum 30-day checkpoint lifetime; self-hosted operators can choose a different retention period.</p>

      <h2>Encrypted rooms and snapshot links</h2>
      <p>A Tabula room or snapshot URL contains its decryption key in the URL fragment. Treat the complete URL as a bearer secret. Tabula MCP uses the room key locally. The Tabula Room relay receives encrypted collaboration envelopes, not room keys, plaintext Markdown, or decrypted presence data. The Tabula JSON service receives encrypted snapshot bytes and an identifier; the snapshot key remains in the URL fragment. Optional Firebase room recovery receives encrypted Yjs checkpoint blobs and opaque generation metadata.</p>

      <h2>Third-party processing and retention</h2>
      <p>Depending on the workflow, data can be processed by your MCP client and device; the hosted MCP provider and its checkpoint store; the Tabula Room relay; the Tabula JSON snapshot service; and Firebase Storage and Firestore when encrypted room recovery is enabled. Tabula.md does not sell document content or use it for advertising. Local checkpoints remain until removed. Hosted working checkpoints use the deployment retention setting. Encrypted room and snapshot services follow their configured retention policies.</p>

      <h2>Logging, support, and contact</h2>
      <p>The official hosted endpoint emits operational logs for reliability and abuse prevention and is configured not to intentionally log plaintext Markdown or URL fragments. Network providers can process ordinary service metadata under their own policies. Do not include room links, snapshot links, document content, or other secrets in public support channels. For privacy questions or deletion requests relating to the official hosted service, use <a href="https://github.com/tabula-md/tabula-mcp/issues">the Tabula.md MCP issue tracker</a>.</p>

    </main>
  </body>
</html>`;
