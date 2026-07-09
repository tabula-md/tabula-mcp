import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Text } from "../src/crypto.js";
import {
  WorkspaceRegistry,
  collectMarkdownFiles,
  createWorkspaceFromFiles,
  readStoredWorkspace,
  readStoredWorkspaceDocument,
} from "../src/workspaces.js";

describe("Tabula workspace registry", () => {
  it("creates canonical workspace room state from inline Markdown files", async () => {
    const workspace = await createWorkspaceFromFiles({
      title: "Docs",
      files: [
        { path: "README.md", markdown: "# Readme\n" },
        { path: "guides/Intro.mdx", title: "Intro", markdown: "# Intro\n" },
      ],
    });
    const readme = workspace.documents.find((document) => document.path === "README.md");

    expect(workspace.workspace).toMatchObject({
      roomId: workspace.workspaceId,
      mode: "workspace",
      version: 1,
      rootId: "workspace-root",
      activeDocumentId: readme?.documentId,
    });
    expect(workspace.workspace.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "workspace-root", type: "folder", parentId: null, title: "Docs" }),
        expect.objectContaining({ type: "folder", parentId: "workspace-root", title: "guides" }),
        expect.objectContaining({ type: "document", title: "README.md", sha256: await sha256Text("# Readme\n") }),
        expect.objectContaining({ type: "document", title: "Intro", sha256: await sha256Text("# Intro\n") }),
      ]),
    );

    expect(readStoredWorkspace(workspace)).toMatchObject({
      workspaceId: workspace.workspaceId,
      cachedDocumentCount: 2,
      hydrationStatus: "ready",
      stateReceived: true,
    });
    expect(readStoredWorkspaceDocument(workspace, readme?.documentId ?? "")).toMatchObject({
      markdown: "# Readme\n",
      sha256: await sha256Text("# Readme\n"),
    });
  });

  it("imports Markdown files from a local folder and skips default excluded directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tabula-mcp-workspace-"));
    try {
      await mkdir(path.join(root, "docs"), { recursive: true });
      await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(root, "README.md"), "# Root\n");
      await writeFile(path.join(root, "docs", "Guide.mdx"), "# Guide\n");
      await writeFile(path.join(root, "docs", "ignore.txt"), "not markdown");
      await writeFile(path.join(root, "node_modules", "pkg", "Ignored.md"), "# Ignored\n");

      const files = await collectMarkdownFiles({ rootPath: root });
      expect(files.map((file) => file.path)).toEqual(["README.md", "docs/Guide.mdx"]);

      const registry = new WorkspaceRegistry();
      const workspace = await registry.importMarkdown({ rootPath: root, title: "Imported Docs" });
      expect(workspace.source).toBe("imported");
      expect(workspace.sourceRootPath).toBe(root);
      expect(readStoredWorkspace(workspace)).toMatchObject({
        source: "imported",
        sourceRootPath: root,
        cachedDocumentCount: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
