# Local folder sync

`tabula-sync` is a companion CLI for users who want a live Tabula Room to
behave like a shared Markdown folder. It is intentionally separate from MCP
tools: MCP hosts already control their own local filesystem, while a persistent
folder watcher has a different lifecycle and deletion risk.

## Connect without leaking the Room URL

Room URLs are bearer secrets. Do not put one directly in a shell command where
it may enter history or process listings. Provide it through the environment:

```sh
read -s TABULA_ROOM_URL
export TABULA_ROOM_URL
tabula-sync status ./research
```

Or store it in a mode-0600 file and use `--room-file`:

```sh
chmod 600 ~/.config/tabula/research-room
tabula-sync status ./research --room-file ~/.config/tabula/research-room
```

Tabula Sync never prints the URL and never writes it to the local folder.

## Commands

```sh
tabula-sync status [folder]
tabula-sync sync [folder]
tabula-sync watch [folder] [--interval 2]
```

- `status` computes a complete plan without changing either side.
- `sync` applies one safe two-way cycle.
- `watch` keeps one Room connection open and repeats safe cycles.
- `--delete` allows an unchanged file deleted on one side to be deleted on the
  other. Without it, deletion is reported as a conflict.
- `--dry-run` makes `sync` behave like `status`.

Only `.md` and `.mdx` regular files are synchronized. Symlinks are never
followed. `.git`, `.hg`, `.svn`, and `node_modules` directories are ignored.

## Conflict and rename behavior

The first successful cycle writes `.tabula-sync.json` with local content
hashes, Room revisions, a one-way Room fingerprint, and an update time. It does
not contain the Room id, URL, key, Markdown, or comments.

On later cycles:

- a change on only one side is copied to the other;
- simultaneous changes to the same file stop the entire cycle before writes;
- an initial same-path mismatch stops because there is no safe common base;
- a unique content-preserving rename is applied as a move on the other side;
- changed-vs-deleted files stop for explicit resolution;
- unchanged deletions propagate only with `--delete`.

The CLI performs Room mutations before local mutations, then reads both sides
again and records state only if every path and revision converged. If a process
or network failure interrupts a cycle, the old state remains and the next run
re-evaluates current files instead of claiming success.

Comments stay in the Room. They are not flattened into Markdown or sidecar
files by folder sync; agents use the Tabula MCP comment tools to read and act on
them.
