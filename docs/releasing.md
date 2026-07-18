# Releasing Tabula MCP

One tag publishes one coherent release across npm, the Claude Desktop MCPB,
the Claude Code plugin metadata, the GitHub Release, and `mcp.tabula.md`.
`release-manifest.json` is the checked-in source of truth for versions,
artifact names, the Worker endpoint, and exact companion repository commits
used by the interoperability test.

## One-time repository setup

Configure these GitHub Actions repository secrets:

- `CLOUDFLARE_API_TOKEN`: a scoped Workers deployment token for the production
  account;
- `CLOUDFLARE_ACCOUNT_ID`: the account that owns `mcp.tabula.md`.

npm publication uses GitHub trusted publishing and does not use a long-lived
`NPM_TOKEN`.

## Prepare a release

1. Update `package.json`, package lock data, MCPB/plugin metadata,
   `src/version.ts`, the App client version, and `CHANGELOG.md`.
2. Update `release-manifest.json` to the same MCP version, the exact
   `@tabula-md/tabula` dependency, and companion commits that passed the full
   browser/Room/Copy test.
3. Run `npm run release:verify:full` against those companion revisions.
4. Merge the release PR, then tag that exact main commit:

   ```sh
   git tag -a vX.Y.Z <main-commit> -m "Release Tabula MCP X.Y.Z"
   git push origin vX.Y.Z
   ```

The release workflow validates credentials and every version before it
publishes anything. It then runs the release gate and pinned interoperability
test, publishes npm, creates the GitHub Release with MCPB checksums and the
resolved manifest, deploys the Cloudflare Worker, and verifies all published
surfaces including production health.

Do not move or recreate a published tag. If a release fails after publication,
fix forward with a new version.
