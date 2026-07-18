import { describe, expect, it } from "vitest";
import { SYNC_CLI_HELP } from "../packages/sync/src/cli.js";

describe("private Tabula Sync CLI", () => {
  it("documents its secret-safe folder sync lifecycle", () => {
    expect(SYNC_CLI_HELP).toContain("TABULA_ROOM_URL");
    expect(SYNC_CLI_HELP).toContain("Conflicts stop the entire cycle");
    expect(SYNC_CLI_HELP).not.toContain("#room=");
  });
});
