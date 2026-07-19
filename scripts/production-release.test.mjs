import assert from "node:assert/strict";
import test from "node:test";
import { validateTabulaMdProduction, waitForTabulaMdProduction } from "./lib/production-release.mjs";

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";
const releaseManifest = {
  packages: { core: { version: "0.8.0" } },
  interoperability: {
    tabulaMd: {
      origin: "https://tabula.md",
      repository: "tabula-md/tabula-md",
      ref: pinnedCommit,
    },
  },
};
const matchingBuild = {
  schemaVersion: 1,
  service: "tabula-md",
  commit: pinnedCommit,
  appVersion: "0.1.0",
  coreVersion: "0.8.0",
};

test("accepts the exact pinned Tabula.md production build", () => {
  assert.equal(validateTabulaMdProduction(matchingBuild, releaseManifest), matchingBuild);
});

test("rejects a production build from a different source commit", () => {
  assert.throws(
    () => validateTabulaMdProduction({ ...matchingBuild, commit: "f".repeat(40) }, releaseManifest),
    /does not match pinned/,
  );
});

test("rejects a production build using a different shared core", () => {
  assert.throws(
    () => validateTabulaMdProduction({ ...matchingBuild, coreVersion: "0.7.0" }, releaseManifest),
    /do not use the same/,
  );
});

test("waits for Tabula.md production to converge to the pinned build", async () => {
  const builds = [{ ...matchingBuild, commit: "f".repeat(40) }, matchingBuild];
  const result = await waitForTabulaMdProduction({
    releaseManifest,
    attempts: 2,
    intervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => Response.json(builds.shift()),
  });
  assert.deepEqual(result, matchingBuild);
});
