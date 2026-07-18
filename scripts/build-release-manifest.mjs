import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadReleaseManifest, resolveReleaseTag } from "./lib/release-manifest.mjs";

const execFileAsync = promisify(execFile);
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const gitCommit = async () => (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
const manifest = await loadReleaseManifest();
const releaseTag = resolveReleaseTag({
  version: manifest.releaseVersion,
  suppliedTag: valueAfter("--tag"),
  environmentRefName: process.env.GITHUB_REF_NAME,
});
const sourceCommit = valueAfter("--commit") ?? process.env.GITHUB_SHA ?? await gitCommit();

assert.equal(releaseTag, `v${manifest.releaseVersion}`, `Release manifest tag must be v${manifest.releaseVersion}.`);
assert.match(sourceCommit, /^[0-9a-f]{40}$/, "Release source commit must be a full commit SHA.");

await mkdir("dist", { recursive: true });
await writeFile("dist/release-manifest.json", `${JSON.stringify({
  ...manifest,
  releaseTag,
  sourceCommit,
}, null, 2)}\n`, "utf8");
console.log(`Release manifest built for ${releaseTag} at ${sourceCommit}`);
