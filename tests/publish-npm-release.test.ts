import { describe, expect, it } from "vitest";
import { publishNpmRelease, verifyExistingPublication } from "../scripts/publish-npm-release.mjs";

const sourceCommit = "28913436f9261e3ae82cf1894dea50e60e845464";

describe("resumable npm release publishing", () => {
  it("accepts an existing version from the same release commit", () => {
    expect(() => verifyExistingPublication({
      publishedPackage: { version: "0.6.0", gitHead: sourceCommit },
      version: "0.6.0",
      sourceCommit,
    })).not.toThrow();
  });

  it("rejects an existing version from another commit", () => {
    expect(() => verifyExistingPublication({
      publishedPackage: { version: "0.6.0", gitHead: "0".repeat(40) },
      version: "0.6.0",
      sourceCommit,
    })).toThrow(/already exists on npm/);
  });

  it("skips publishing an existing version from the release commit", async () => {
    const previousSha = process.env.GITHUB_SHA;
    process.env.GITHUB_SHA = sourceCommit;
    let publishCount = 0;
    try {
      const result = await publishNpmRelease({
        fetchImpl: async () => new Response(JSON.stringify({
          version: "0.6.0",
          gitHead: sourceCommit,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        publish: () => { publishCount += 1; },
      });
      expect(result.published).toBe(false);
      expect(publishCount).toBe(0);
    } finally {
      if (previousSha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = previousSha;
    }
  });

  it("publishes only when the exact version is absent", async () => {
    const previousSha = process.env.GITHUB_SHA;
    process.env.GITHUB_SHA = sourceCommit;
    let publishCount = 0;
    try {
      const result = await publishNpmRelease({
        fetchImpl: async () => new Response(null, { status: 404 }),
        publish: () => { publishCount += 1; },
      });
      expect(result.published).toBe(true);
      expect(publishCount).toBe(1);
    } finally {
      if (previousSha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = previousSha;
    }
  });
});
