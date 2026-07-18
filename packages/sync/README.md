# Tabula Sync (internal preview)

This package is private and must not be published, documented as a supported
feature, or bundled into `@tabula-md/mcp` or the MCPB release.

It is an experimental human-invoked CLI for synchronizing one local Markdown
folder with one encrypted Tabula Room. Run it only from this repository:

```sh
read -s TABULA_ROOM_URL
export TABULA_ROOM_URL
npm --prefix packages/sync run dev -- status ./research
npm --prefix packages/sync run dev -- sync ./research
npm --prefix packages/sync run dev -- watch ./research
```

The CLI writes revision fingerprints—not the Room URL or key—to
`.tabula-sync.json`. A cycle stops before writing if both sides changed.
Deletions propagate only with `--delete`; unique content-preserving renames are
recognized as moves.

There is deliberately no npm publishing workflow or public executable for this
package.
