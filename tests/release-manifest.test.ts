import { describe, expect, it } from "vitest";
import { resolveReleaseTag } from "../scripts/lib/release-manifest.mjs";

describe("release manifest tag resolution", () => {
  it("ignores pull request merge refs", () => {
    expect(resolveReleaseTag({ version: "0.5.0", environmentRefName: "104/merge" })).toBe("v0.5.0");
  });

  it("accepts an actual release tag", () => {
    expect(resolveReleaseTag({ version: "0.5.0", environmentRefName: "v0.5.0" })).toBe("v0.5.0");
  });

  it("prefers an explicit tag", () => {
    expect(resolveReleaseTag({
      version: "0.5.0",
      suppliedTag: "v0.5.0",
      environmentRefName: "104/merge",
    })).toBe("v0.5.0");
  });
});
