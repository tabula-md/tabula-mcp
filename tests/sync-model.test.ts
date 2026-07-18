import { describe, expect, it } from "vitest";
import { planFolderSync, type SyncFile } from "../packages/sync/src/model.js";

const file = (path: string, revision: string, content = revision): SyncFile => ({ path, revision, content });

describe("local folder sync planning", () => {
  it("copies new files in both directions on first sync", () => {
    const plan = planFolderSync({
      localFiles: [file("local.md", "local")],
      remoteFiles: [file("remote.md", "remote")],
      state: {},
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteWrites).toEqual([{ path: "local.md", content: "local" }]);
    expect(plan.localWrites).toEqual([file("remote.md", "remote")]);
  });

  it("blocks the whole cycle when both sides changed", () => {
    const plan = planFolderSync({
      localFiles: [file("notes.md", "local-next")],
      remoteFiles: [file("notes.md", "remote-next")],
      state: { "notes.md": { localRevision: "base", remoteRevision: "base" } },
    });
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ path: "notes.md", code: "both_changed" }),
    ]);
    expect(plan.remoteWrites).toEqual([]);
    expect(plan.localWrites).toEqual([]);
  });

  it("requires explicit deletion confirmation", () => {
    const input = {
      localFiles: [file("deleted-remotely.md", "base")],
      remoteFiles: [] as SyncFile[],
      state: { "deleted-remotely.md": { localRevision: "base", remoteRevision: "base" } },
    };
    expect(planFolderSync(input).conflicts[0]?.code).toBe("delete_requires_confirmation");
    expect(planFolderSync({ ...input, deleteMissing: true }).localDeletes).toEqual(["deleted-remotely.md"]);
  });

  it("recognizes a unique local rename and moves the Room file", () => {
    const plan = planFolderSync({
      localFiles: [file("renamed.md", "same")],
      remoteFiles: [file("old.md", "same")],
      state: { "old.md": { localRevision: "same", remoteRevision: "same" } },
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteMoves).toEqual([
      { source: "old.md", destination: "renamed.md", expectedRevision: "same" },
    ]);
    expect(plan.remoteWrites).toEqual([]);
    expect(plan.remoteDeletes).toEqual([]);
  });

  it("recognizes a unique Room rename and moves the local file", () => {
    const plan = planFolderSync({
      localFiles: [file("old.md", "same")],
      remoteFiles: [file("renamed.md", "same")],
      state: { "old.md": { localRevision: "same", remoteRevision: "same" } },
    });
    expect(plan.localMoves).toEqual([{ source: "old.md", destination: "renamed.md" }]);
  });
});
