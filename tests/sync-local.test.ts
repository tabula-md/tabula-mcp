import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readFolderSyncState,
  readLocalMarkdownFiles,
  writeFolderSyncState,
  writeLocalSyncFile,
} from "../packages/sync/src/local.js";

describe("local folder sync storage", () => {
  it("reads Markdown only and never follows symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tabula-sync-"));
    const outside = await mkdtemp(path.join(tmpdir(), "tabula-sync-outside-"));
    try {
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "readme.md"), "# Safe\n");
      await writeFile(path.join(root, "ignored.txt"), "ignored");
      await writeFile(path.join(outside, "secret.md"), "secret");
      await symlink(path.join(outside, "secret.md"), path.join(root, "linked.md"));
      const files = await readLocalMarkdownFiles(root);
      expect(files.map((file) => file.path)).toEqual(["docs/readme.md"]);
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it("stores only a Room fingerprint and writes files inside the selected root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tabula-sync-state-"));
    try {
      await writeLocalSyncFile(root, { path: "nested/notes.md", content: "notes" });
      await writeFolderSyncState(root, {
        version: 1,
        roomFingerprint: "fingerprint-not-a-room-key",
        files: { "nested/notes.md": { localRevision: "a", remoteRevision: "a" } },
        updatedAt: "2026-07-19T00:00:00.000Z",
      });
      expect(await readFile(path.join(root, "nested", "notes.md"), "utf8")).toBe("notes");
      await expect(readFolderSyncState(root)).resolves.toMatchObject({ roomFingerprint: "fingerprint-not-a-room-key" });
      expect(await readFile(path.join(root, ".tabula-sync.json"), "utf8")).not.toContain("#room=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlinked parent directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tabula-sync-link-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "tabula-sync-link-outside-"));
    try {
      await symlink(outside, path.join(root, "linked"));
      await expect(writeLocalSyncFile(root, { path: "linked/escape.md", content: "no" })).rejects.toThrow(/symlink/);
      await expect(readFile(path.join(outside, "escape.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });
});
