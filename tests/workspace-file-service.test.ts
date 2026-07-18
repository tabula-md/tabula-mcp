import { sha256Text } from "../src/crypto.js";
import type { SessionRegistry } from "../src/registry.js";
import type { WorkspaceChange, WorkspaceRoomState } from "../src/workspace-contract.js";
import {
  createSessionDirectory,
  deleteSessionPath,
  editSessionFile,
  listSessionFiles,
  maxSessionReadCharacters,
  maxSessionReadFiles,
  moveSessionFile,
  readSessionFile,
  readSessionFiles,
  searchSessionFiles,
  writeSessionFile,
  writeSessionFiles,
} from "../src/workspace-file-service.js";
import { buildWorkspacePathIndex } from "../src/workspace-paths.js";
import { describe, expect, it } from "vitest";

const sessionId = "00000000-0000-4000-8000-000000000001";

const createHarness = async () => {
  const now = "2026-07-17T00:00:00.000Z";
  const docs = {
    readme: "# Workspace\n\nAuthentication overview.\n",
    security: "# Security\n\nAuthentication is handled here.\n",
  } as Record<string, string>;
  const workspace: WorkspaceRoomState = {
    roomId: "room",
    mode: "workspace",
    version: 1,
    rootId: "root",
    activeDocumentId: "readme",
    nodes: [
      { id: "root", type: "folder", parentId: null, title: "Workspace", order: 0, createdAt: now, updatedAt: now },
      { id: "docs", type: "folder", parentId: "root", title: "docs", order: 0, createdAt: now, updatedAt: now },
      {
        id: "readme", type: "document", parentId: "root", title: "README.md", order: 0,
        createdAt: now, updatedAt: now, sha256: await sha256Text(docs.readme ?? ""), textLength: docs.readme?.length ?? 0,
      },
      {
        id: "security", type: "document", parentId: "docs", title: "security.md", order: 0,
        createdAt: now, updatedAt: now, sha256: await sha256Text(docs.security ?? ""), textLength: docs.security?.length ?? 0,
      },
    ],
  };
  const checkpoint = { flushes: 0 };

  const refresh = async () => {
    workspace.nodes = await Promise.all(workspace.nodes.map(async (node) => node.type === "folder" ? node : ({
      ...node,
      sha256: await sha256Text(docs[node.id] ?? ""),
      textLength: (docs[node.id] ?? "").length,
    })));
  };

  const session = {
    writeAccess: true,
    async getStatus() {
      return { stateReceived: true };
    },
    async readWorkspaceSnapshot() {
      await refresh();
      return { sessionId, workspace, documents: { ...docs }, commentsByFileId: {}, activeDocumentId: workspace.activeDocumentId };
    },
    async applyWorkspaceChanges({ changes }: { changes: WorkspaceChange[] }) {
      const changedDocumentIds: string[] = [];
      for (const change of changes) {
        if (change.type === "folder.create") {
          workspace.nodes.push({
            id: change.folderId, type: "folder", parentId: change.parentId ?? "root", title: change.title,
            order: workspace.nodes.length, createdAt: now, updatedAt: now,
          });
        } else if (change.type === "document.patch") {
          let text = docs[change.documentId] ?? "";
          for (const patch of [...change.patches].sort((a, b) => b.from - a.from)) {
            text = `${text.slice(0, patch.from)}${patch.insert}${text.slice(patch.to)}`;
          }
          docs[change.documentId] = text;
          changedDocumentIds.push(change.documentId);
        } else if (change.type === "document.create") {
          const id = `created-${workspace.nodes.length}`;
          docs[id] = change.markdown;
          workspace.nodes.push({
            id, type: "document", parentId: change.parentId ?? "root", title: change.title, order: workspace.nodes.length,
            createdAt: now, updatedAt: now, sha256: await sha256Text(change.markdown), textLength: change.markdown.length,
          });
          changedDocumentIds.push(id);
        } else if (change.type === "node.move") {
          workspace.nodes = workspace.nodes.map((node) => node.id === change.nodeId
            ? { ...node, parentId: change.parentId ?? workspace.rootId, title: change.title }
            : node);
        } else if (change.type === "node.delete") {
          const deletedIds = new Set([change.nodeId]);
          let added = true;
          while (added) {
            added = false;
            for (const node of workspace.nodes) {
              if (node.parentId && deletedIds.has(node.parentId) && !deletedIds.has(node.id)) {
                deletedIds.add(node.id);
                added = true;
              }
            }
          }
          workspace.nodes = workspace.nodes.filter((node) => !deletedIds.has(node.id));
          for (const id of deletedIds) delete docs[id];
        }
      }
      await refresh();
      return { changedDocumentIds };
    },
    async flushCheckpoint() {
      checkpoint.flushes += 1;
    },
  };
  const registry = { get: () => session } as unknown as SessionRegistry;
  return { checkpoint, registry, docs, session, workspace };
};

describe("workspace file service", () => {
  it("projects the collaboration tree as stable file paths", async () => {
    const { registry } = await createHarness();
    const listed = await listSessionFiles({ registry, sessionId });
    expect(listed.files).toEqual([
      { path: "docs", type: "folder" },
      expect.objectContaining({ path: "docs/security.md", type: "file" }),
      expect.objectContaining({ path: "README.md", type: "file" }),
    ]);
    const scoped = await listSessionFiles({ registry, sessionId, path: "docs", recursive: false });
    expect(scoped.files).toEqual([expect.objectContaining({ path: "docs/security.md", type: "file" })]);
  });

  it("paginates stable file listings and rejects stale or mismatched cursors", async () => {
    const { registry, workspace } = await createHarness();
    const first = await listSessionFiles({ registry, sessionId, limit: 2 });
    expect(first).toMatchObject({ truncated: true, files: [{ path: "docs" }, { path: "docs/security.md" }] });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await listSessionFiles({ registry, sessionId, limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ truncated: false, files: [{ path: "README.md" }] });
    expect(second).not.toHaveProperty("nextCursor");
    await expect(listSessionFiles({
      registry,
      sessionId,
      path: "docs",
      limit: 2,
      cursor: first.nextCursor,
    })).rejects.toMatchObject({ code: "stale_cursor" });

    workspace.version += 1;
    await expect(listSessionFiles({ registry, sessionId, limit: 2, cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "stale_cursor" });
  });

  it("reads and searches Markdown without exposing document ids", async () => {
    const { registry } = await createHarness();
    const read = await readSessionFiles({ registry, sessionId, paths: ["docs/security.md", "README.md"] });
    expect(read).toMatchObject({
      files: [
        { path: "docs/security.md", content: expect.stringContaining("Authentication"), textLength: 44 },
        { path: "README.md", content: expect.stringContaining("Workspace"), textLength: 38 },
      ],
      totalCharacters: 82,
    });
    expect(read).not.toHaveProperty("documentId");
    expect(read.files.every((file) => !("documentId" in file))).toBe(true);

    const searched = await searchSessionFiles({ registry, sessionId, query: "authentication", maxResults: 1 });
    expect(searched).toMatchObject({
      truncated: true,
      matches: [expect.objectContaining({ kind: "content", line: 3, match: expect.stringContaining("Authentication") })],
    });
  });

  it("reads the head, middle, or tail of one file while preserving its revision", async () => {
    const { docs, registry } = await createHarness();
    docs.readme = "one\ntwo\nthree\nfour\nfive";

    await expect(readSessionFile({ registry, sessionId, path: "README.md", lineCount: 2 }))
      .resolves.toMatchObject({ content: "one\ntwo\n", startLine: 1, endLine: 2, totalLines: 5, truncated: true });
    const middle = await readSessionFile({ registry, sessionId, path: "README.md", startLine: 3, lineCount: 2 });
    expect(middle).toMatchObject({ content: "three\nfour\n", startLine: 3, endLine: 4, truncated: true });
    expect(middle.revision).toMatch(/^[a-f0-9]{64}$/);
    await expect(readSessionFile({ registry, sessionId, path: "README.md", tailLines: 2 }))
      .resolves.toMatchObject({ content: "four\nfive", startLine: 4, endLine: 5, truncated: true });
    await expect(readSessionFile({ registry, sessionId, path: "README.md", startLine: 2, tailLines: 2 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(readSessionFile({ registry, sessionId, path: "README.md", startLine: 6 }))
      .rejects.toMatchObject({ code: "invalid_range", details: { totalLines: 5 } });
  });

  it("returns bounded search context without repeating every line for a path match", async () => {
    const { registry } = await createHarness();
    const contentMatch = await searchSessionFiles({
      registry,
      sessionId,
      query: "authentication",
      contextLines: 1,
    });
    expect(contentMatch.matches[0]).toMatchObject({
      kind: "content",
      line: 3,
      before: [""],
      after: [""],
    });
    const pathMatch = await searchSessionFiles({ registry, sessionId, query: "security" });
    expect(pathMatch.matches.filter((match) => match.kind === "path")).toEqual([
      expect.objectContaining({ path: "docs/security.md", match: "docs/security.md" }),
    ]);
    await expect(searchSessionFiles({ registry, sessionId, query: "anything", path: "missing" }))
      .rejects.toMatchObject({ code: "file_not_found", details: { path: "missing" } });
  });

  it("rejects duplicate, oversized, and over-broad batch reads without truncating content", async () => {
    const { docs, registry } = await createHarness();
    await expect(readSessionFiles({ registry, sessionId, paths: ["README.md", "README.md"] }))
      .rejects.toMatchObject({ code: "invalid_path", retry: expect.stringContaining("duplicate") });
    await expect(readSessionFiles({
      registry,
      sessionId,
      paths: Array.from({ length: maxSessionReadFiles + 1 }, (_, index) => `file-${index}.md`),
    })).rejects.toMatchObject({
      code: "read_too_large",
      details: { maxFiles: maxSessionReadFiles },
    });

    docs.readme = "x".repeat(maxSessionReadCharacters + 1);
    await expect(readSessionFiles({ registry, sessionId, paths: ["README.md"] }))
      .rejects.toMatchObject({
        code: "read_too_large",
        details: { maxCharacters: maxSessionReadCharacters },
      });
  });

  it("replaces an existing file with one server-computed patch", async () => {
    const { checkpoint, registry, docs } = await createHarness();
    const current = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    const content = `${current.content}\nDone.\n`;
    const written = await writeSessionFile({
      registry,
      sessionId,
      path: "README.md",
      content,
      expectedRevision: current.revision,
    });
    expect(written).toMatchObject({ created: false, changed: true, textLength: content.length });
    expect(docs.readme).toBe(content);
    expect(checkpoint.flushes).toBe(1);
  });

  it("edits one exact unique occurrence and rejects missing or ambiguous text", async () => {
    const { checkpoint, registry, docs } = await createHarness();
    const current = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    const edited = await editSessionFile({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: current.revision,
      edits: [{ oldText: "Authentication overview.", newText: "Authentication details." }],
    });
    expect(edited).toMatchObject({
      changed: true,
      editsApplied: 1,
      rebased: false,
      diff: expect.stringContaining("-Authentication overview."),
      diffTruncated: false,
    });
    expect(docs.readme).toContain("Authentication details.");
    expect(checkpoint.flushes).toBe(1);

    await expect(editSessionFile({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: edited.revision,
      edits: [{ oldText: "not present", newText: "replacement" }],
    })).rejects.toMatchObject({ code: "edit_not_found" });

    docs.readme = "same\nsame\n";
    const ambiguous = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    await expect(editSessionFile({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: ambiguous.revision,
      edits: [{ oldText: "same", newText: "different" }],
    })).rejects.toMatchObject({
      code: "edit_ambiguous",
      details: { matchCount: 2, matchingLines: [1, 2] },
    });
    expect(docs.readme).toBe("same\nsame\n");
  });

  it("safely rebases exact edits and supports an explicit replace-all", async () => {
    const { docs, registry } = await createHarness();
    const current = await readSessionFile({ registry, sessionId, path: "README.md" });
    docs.readme = `${docs.readme}A collaborator added this line.\n`;

    const rebased = await editSessionFile({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: current.revision,
      edits: [{ oldText: "Authentication overview.", newText: "Authentication details." }],
    });
    expect(rebased).toMatchObject({ changed: true, rebased: true, editsApplied: 1 });
    expect(docs.readme).toContain("Authentication details.");
    expect(docs.readme).toContain("A collaborator added this line.");

    docs.readme = "same\nsame\n";
    const repeated = await readSessionFile({ registry, sessionId, path: "README.md" });
    const replaced = await editSessionFile({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: repeated.revision,
      edits: [{ oldText: "same", newText: "different", replaceAll: true }],
    });
    expect(replaced).toMatchObject({ changed: true, editsApplied: 2, rebased: false });
    expect(docs.readme).toBe("different\ndifferent\n");
  });

  it("rejects a stale exact edit when its anchor is no longer safe", async () => {
    const { docs, registry } = await createHarness();
    const current = await readSessionFile({ registry, sessionId, path: "README.md" });
    docs.readme = "# Workspace\n\nA collaborator replaced the paragraph.\n";
    await expect(editSessionFile({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: current.revision,
      edits: [{ oldText: "Authentication overview.", newText: "Authentication details." }],
    })).rejects.toMatchObject({ code: "stale_revision", details: { expectedRevision: current.revision } });
  });

  it("creates nested directories idempotently and rejects a file collision", async () => {
    const { checkpoint, registry } = await createHarness();
    await expect(createSessionDirectory({ registry, sessionId, path: "research/2026" }))
      .resolves.toMatchObject({ sessionId, path: "research/2026", created: true, applied: true, persisted: true });
    await expect(createSessionDirectory({ registry, sessionId, path: "research/2026" }))
      .resolves.toMatchObject({ sessionId, path: "research/2026", created: false, applied: true, persisted: true });
    await expect(createSessionDirectory({ registry, sessionId, path: "README.md" }))
      .rejects.toMatchObject({ code: "path_exists" });
    expect(checkpoint.flushes).toBe(1);
  });

  it("moves or renames files and folders using filesystem paths", async () => {
    const { checkpoint, registry } = await createHarness();
    const readme = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    await createSessionDirectory({ registry, sessionId, path: "archive" });
    await expect(moveSessionFile({
      registry,
      sessionId,
      source: "README.md",
      destination: "archive/overview.md",
      expectedRevision: readme.revision,
    })).resolves.toMatchObject({
      source: "README.md",
      destination: "archive/overview.md",
      type: "file",
      changed: true,
    });
    await expect(moveSessionFile({
      registry,
      sessionId,
      source: "docs",
      destination: "reference",
    })).resolves.toMatchObject({ type: "folder", changed: true });
    const listed = await listSessionFiles({ registry, sessionId });
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "archive/overview.md" }),
      expect.objectContaining({ path: "reference/security.md" }),
    ]));
    expect(checkpoint.flushes).toBe(3);
  });

  it("guards deletion with file revisions and explicit recursive intent", async () => {
    const { checkpoint, registry } = await createHarness();
    const readme = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    await expect(deleteSessionPath({ registry, sessionId, path: "README.md" }))
      .rejects.toMatchObject({ code: "stale_revision" });
    await expect(deleteSessionPath({
      registry,
      sessionId,
      path: "README.md",
      expectedRevision: readme.revision,
    })).resolves.toMatchObject({ path: "README.md", type: "file", deleted: true });
    await expect(deleteSessionPath({ registry, sessionId, path: "docs" }))
      .rejects.toMatchObject({ code: "directory_not_empty" });
    await expect(deleteSessionPath({ registry, sessionId, path: "docs", recursive: true }))
      .resolves.toMatchObject({ path: "docs", type: "folder", deleted: true });
    expect((await listSessionFiles({ registry, sessionId })).files).toEqual([]);
    expect(checkpoint.flushes).toBe(2);
  });

  it("returns no-op and stale outcomes and creates missing parent folders", async () => {
    const { checkpoint, registry } = await createHarness();
    const current = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    await expect(writeSessionFile({
      registry, sessionId, path: "README.md", content: current.content, expectedRevision: current.revision,
    })).resolves.toMatchObject({ changed: false });
    await expect(writeSessionFile({
      registry, sessionId, path: "README.md", content: current.content, expectedRevision: "0".repeat(64),
    })).resolves.toMatchObject({ changed: false, checkpointPending: false });
    await expect(writeSessionFile({
      registry, sessionId, path: "README.md", content: current.content,
    })).resolves.toMatchObject({ changed: false, checkpointPending: false });
    expect(checkpoint.flushes).toBe(0);
    await expect(writeSessionFile({
      registry, sessionId, path: "README.md", content: "stale", expectedRevision: "0".repeat(64),
    })).rejects.toMatchObject({ code: "stale_revision" });
    await expect(writeSessionFile({
      registry, sessionId, path: "missing/new.md", content: "new",
    })).resolves.toMatchObject({ created: true, path: "missing/new.md" });
    await expect(writeSessionFile({
      registry, sessionId, path: "/absolute.md", content: "new",
    })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(writeSessionFile({
      registry, sessionId, path: "C:\\absolute.md", content: "new",
    })).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("creates a file at the root or in an existing folder", async () => {
    const { checkpoint, registry } = await createHarness();
    await expect(writeSessionFile({ registry, sessionId, path: "notes.md", content: "# Notes\n" }))
      .resolves.toMatchObject({ created: true, changed: true });
    await expect(writeSessionFile({ registry, sessionId, path: "docs/plan.md", content: "# Plan\n" }))
      .resolves.toMatchObject({ created: true, changed: true });
    expect(checkpoint.flushes).toBe(2);
    const listed = await listSessionFiles({ registry, sessionId });
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "notes.md" }),
      expect.objectContaining({ path: "docs/plan.md" }),
    ]));
  });

  it("writes multiple files and missing folders in one workspace transaction", async () => {
    const { checkpoint, registry, docs, session } = await createHarness();
    const current = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    let transactionCount = 0;
    const apply = session.applyWorkspaceChanges.bind(session);
    session.applyWorkspaceChanges = async (input) => {
      transactionCount += 1;
      return apply(input);
    };

    const written = await writeSessionFiles({
      registry,
      sessionId,
      files: [
        { path: "README.md", content: `${current.content}\nUpdated in batch.\n`, expectedRevision: current.revision },
        { path: "research/notes.md", content: "# Notes\n" },
        { path: "research/nested/findings.md", content: "# Findings\n" },
      ],
    });

    expect(written).toMatchObject({ createdCount: 2, changedCount: 3 });
    expect(written.files).toHaveLength(3);
    expect(transactionCount).toBe(1);
    expect(checkpoint.flushes).toBe(1);
    expect(docs.readme).toContain("Updated in batch.");
    const listed = await listSessionFiles({ registry, sessionId });
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "research", type: "folder" }),
      expect.objectContaining({ path: "research/nested", type: "folder" }),
      expect.objectContaining({ path: "research/notes.md", type: "file" }),
      expect.objectContaining({ path: "research/nested/findings.md", type: "file" }),
    ]));
  });

  it("rejects a stale multi-file write before applying any file", async () => {
    const { checkpoint, registry, session } = await createHarness();
    let transactionCount = 0;
    const apply = session.applyWorkspaceChanges.bind(session);
    session.applyWorkspaceChanges = async (input) => {
      transactionCount += 1;
      return apply(input);
    };

    await expect(writeSessionFiles({
      registry,
      sessionId,
      files: [
        { path: "new.md", content: "# New\n" },
        { path: "README.md", content: "stale", expectedRevision: "0".repeat(64) },
      ],
    })).rejects.toMatchObject({ code: "stale_revision" });

    expect(transactionCount).toBe(0);
    expect(checkpoint.flushes).toBe(0);
    const listed = await listSessionFiles({ registry, sessionId });
    expect(listed.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "new.md" }),
    ]));
  });

  it.each([".", ".."])('rejects a collaboration node named "%s"', async (title) => {
    const { workspace } = await createHarness();
    workspace.nodes.push({
      id: `invalid-${title.length}`,
      type: "document",
      parentId: workspace.rootId,
      title,
      order: workspace.nodes.length,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      sha256: await sha256Text(""),
      textLength: 0,
    });
    expect(() => buildWorkspacePathIndex(workspace)).toThrowError(expect.objectContaining({ code: "invalid_path" }));
  });

  it("normalizes live collaboration failures as write_failed", async () => {
    const { registry, session } = await createHarness();
    const current = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    session.applyWorkspaceChanges = async () => {
      throw new Error("transport closed");
    };

    await expect(writeSessionFile({
      registry,
      sessionId,
      path: "README.md",
      content: `${current.content}\nChanged\n`,
      expectedRevision: current.revision,
    })).rejects.toMatchObject({
      code: "write_failed",
      details: { path: "README.md" },
      retry: "Read the latest file state and retry once.",
    });
  });

  it("reports a pending checkpoint without pretending the live write failed", async () => {
    const { registry, session } = await createHarness();
    const current = (await readSessionFiles({ registry, sessionId, paths: ["README.md"] })).files[0]!;
    session.flushCheckpoint = async () => {
      throw new Error("checkpoint unavailable");
    };

    await expect(writeSessionFile({
      registry,
      sessionId,
      path: "README.md",
      content: `${current.content}\nChanged\n`,
      expectedRevision: current.revision,
    })).resolves.toMatchObject({
      path: "README.md",
      changed: true,
      checkpointPending: true,
    });
    expect((await readSessionFile({ registry, sessionId, path: "README.md" })).content).toContain("Changed");
  });
});
