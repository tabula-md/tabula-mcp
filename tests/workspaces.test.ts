import { describe, expect, it } from "vitest";
import { sha256Text } from "../src/crypto.js";
import { createWorkspaceFromFiles } from "../src/workspaces.js";

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
  });
});
