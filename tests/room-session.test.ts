import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/registry.js";
import { startWorkspaceRoom } from "../src/room-session.js";
import { createWorkspaceFromFiles } from "../src/workspaces.js";

describe("startWorkspaceRoom", () => {
  it("rejects a temporary session when its caller requires durable recovery", async () => {
    const workspace = await createWorkspaceFromFiles({
      title: "Launch brief",
      files: [{ path: "Launch brief.md", markdown: "# Launch brief\n" }],
    });

    await expect(startWorkspaceRoom({
      registry: new SessionRegistry(),
      workspace,
      env: {},
      allowTemporary: false,
    })).rejects.toThrow("Hosted Tabula MCP can start a live session only when encrypted room persistence is configured");
  });
});
