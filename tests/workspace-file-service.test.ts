import { sha256Text } from "../src/crypto.js";
import type { SessionRegistry } from "../src/registry.js";
import type { WorkspaceChange, WorkspaceRoomState } from "../src/workspace-contract.js";
import {
  listSessionFiles,
  readSessionFile,
  searchSessionFiles,
  writeSessionFile,
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
        if (change.type === "document.patch") {
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
        }
      }
      await refresh();
      return { changedDocumentIds };
    },
  };
  const registry = { get: () => session } as unknown as SessionRegistry;
  return { registry, docs, session, workspace };
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

  it("reads and searches Markdown without exposing document ids", async () => {
    const { registry } = await createHarness();
    const read = await readSessionFile({ registry, sessionId, path: "docs/security.md" });
    expect(read).toMatchObject({ path: "docs/security.md", content: expect.stringContaining("Authentication"), textLength: 44 });
    expect(read).not.toHaveProperty("documentId");

    const searched = await searchSessionFiles({ registry, sessionId, query: "authentication", maxResults: 1 });
    expect(searched).toMatchObject({ truncated: true, matches: [expect.objectContaining({ line: 3 })] });
  });

  it("replaces an existing file with one server-computed patch", async () => {
    const { registry, docs } = await createHarness();
    const current = await readSessionFile({ registry, sessionId, path: "README.md" });
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
  });

  it("returns no-op, stale, and missing-parent outcomes deterministically", async () => {
    const { registry } = await createHarness();
    const current = await readSessionFile({ registry, sessionId, path: "README.md" });
    await expect(writeSessionFile({
      registry, sessionId, path: "README.md", content: current.content, expectedRevision: current.revision,
    })).resolves.toMatchObject({ changed: false });
    await expect(writeSessionFile({
      registry, sessionId, path: "README.md", content: "stale", expectedRevision: "0".repeat(64),
    })).rejects.toMatchObject({ code: "stale_revision" });
    await expect(writeSessionFile({
      registry, sessionId, path: "missing/new.md", content: "new",
    })).rejects.toMatchObject({ code: "parent_folder_not_found" });
    await expect(writeSessionFile({
      registry, sessionId, path: "/absolute.md", content: "new",
    })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(writeSessionFile({
      registry, sessionId, path: "C:\\absolute.md", content: "new",
    })).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("creates a file at the root or in an existing folder", async () => {
    const { registry } = await createHarness();
    await expect(writeSessionFile({ registry, sessionId, path: "notes.md", content: "# Notes\n" }))
      .resolves.toMatchObject({ created: true, changed: true });
    await expect(writeSessionFile({ registry, sessionId, path: "docs/plan.md", content: "# Plan\n" }))
      .resolves.toMatchObject({ created: true, changed: true });
    const listed = await listSessionFiles({ registry, sessionId });
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "notes.md" }),
      expect.objectContaining({ path: "docs/plan.md" }),
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
    const current = await readSessionFile({ registry, sessionId, path: "README.md" });
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
});
