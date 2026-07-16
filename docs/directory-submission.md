# Anthropic Directory Submission Pack

This document is the handoff packet for submitting Tabula.md MCP to the
Anthropic directory and for distributing the local MCPB through an organization
allowlist. Tabula.md has two distribution surfaces: the stateful remote MCP
App, which is the broad directory path, and the local Claude Desktop extension.

## Product summary

**Tabula.md MCP** connects Claude to shared Tabula.md Markdown workspaces.
People work in Tabula.md while Claude reads and changes the same files through
MCP. The local MCPB keeps working drafts on the user’s device. Complete `#room`
and `#json` URLs are bearer secrets; Tabula’s relay and snapshot services
receive encrypted data only.

## Remote MCP App submission

Use the **MCP directory submission form** for the public, stateful endpoint:

- Server URL: `https://mcp.tabula.md/mcp`
- Transport: Streamable HTTP with a stateful Durable Object session
- Authentication: none; this public endpoint is intentionally unauthenticated
  and does not require test credentials or OAuth setup
- Test flow: connect, call `tabula_create_workspace` with one inline Markdown
  file, then call `tabula_read_workspace` using the returned workspace id. The
  reviewer should see one document, proving that the MCP session retained the
  workspace state.
- Allowed external-link URI: `https://tabula.md`
- Read/write surface: separate read tools and explicit create/share/change
  tools; every model-facing tool declares a human-readable `title`,
  `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.

The remote endpoint has no account or user-data test fixture. A reviewer can
exercise the no-auth workspace flow above without access to any private Tabula
room. Do not provide a real `#room` or `#json` bearer URL as test credentials.

## Desktop extension submission

Use the **Desktop extension submission form** for the local MCPB. It is the
distribution route for people who want the MCP process and plaintext working
drafts to remain on their own machine.

## Submission values

- Product name: `Tabula.md MCP`
- MCPB artifact: `dist/tabula-mcp-0.1.6.mcpb`
- Privacy policy: `https://mcp.tabula.md/privacy`
- Support:
  `https://github.com/tabula-md/tabula-mcp/issues`
- Source: `https://github.com/tabula-md/tabula-mcp`
- Category: Productivity / Writing / Collaboration
- Local extension behavior: local MCP server, local plaintext checkpoints,
  encrypted room and snapshot handoff

The artifact is intentionally not self-signed. A self-signed certificate does
not establish publisher trust. If an enterprise requires an independently
trusted MCPB signature, sign the final release with that organization’s
certificate after packaging and verify it with `mcpb verify`.

## App screenshots and paired prompts

Submit the PNGs below as MCP App screenshots. They are direct 1440 × 1024
captures of the bundled Tabula Document MCP App; crop only the app response
when the submission UI asks for it.

| Screenshot | Paired user prompt | What the reviewer sees |
| --- | --- | --- |
| `assets/directory/local-draft-card.png` | “Create a Markdown brief titled Launch Brief and open it in Tabula.md.” | Private-draft handoff with **Open a copy** and **Start session**. |
| `assets/directory/live-session-card.png` | “Start a Tabula.md session for Launch Brief.” | Newly started live session with **Open session** and Claude’s collaborator state. |
| `assets/directory/connected-session-card.png` | “Join this Tabula.md session and summarize its Markdown without changing it.” | Existing live-session handoff with a clear continuation into Tabula.md. |

Regenerate all three captures from the current Session Card with
`npm run capture:directory-assets`. The readiness check verifies their names,
format, and 1440 × 1024 dimensions.

## Directory and organization rollout

1. Publish the matching `@tabula-md/mcp@0.1.6` npm release before distributing
   the Claude Code plugin; its plugin configuration is intentionally pinned to
   that exact version.
2. Build and validate the artifact with `npm run release:pack`.
3. Submit the remote `https://mcp.tabula.md/mcp` MCP App through the MCP
   directory submission flow, including the three paired screenshots.
4. Submit the local `dist/tabula-mcp-0.1.6.mcpb` through the Desktop Extension
   submission flow, including the same privacy-policy URL.
5. For a customer-specific Team or Enterprise rollout, the customer’s owner
   uploads the same MCPB in **Organization settings → Connectors → Desktop →
   Add custom extension**. This allowlist is organization-specific; it is not a
   public listing.
6. Every update keeps the extension name `tabula-mcp` and increases the MCPB
   version. The package, plugin, manifest, and artifact must use the same
   version.
