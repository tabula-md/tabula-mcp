import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const verifyExistingPublication = ({ publishedPackage, version, sourceCommit }) => {
  assert.equal(publishedPackage.version, version, `npm returned an unexpected version for @tabula-md/mcp@${version}.`);
  assert.equal(
    publishedPackage.gitHead,
    sourceCommit,
    `@tabula-md/mcp@${version} already exists on npm from ${publishedPackage.gitHead ?? "an unknown commit"}, not ${sourceCommit}.`,
  );
};

export const publishNpmRelease = async ({
  fetchImpl = fetch,
  publish = () => {
    execFileSync("npm", ["publish", "--access", "public", "--ignore-scripts"], { stdio: "inherit" });
  },
} = {}) => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const version = packageJson.version;
  const sourceCommit = process.env.GITHUB_SHA;
  assert.match(sourceCommit ?? "", /^[0-9a-f]{40}$/, "GITHUB_SHA must identify the release commit.");

  const response = await fetchImpl(`https://registry.npmjs.org/%40tabula-md%2Fmcp/${version}`);
  if (response.ok) {
    verifyExistingPublication({ publishedPackage: await response.json(), version, sourceCommit });
    console.log(`@tabula-md/mcp@${version} is already published from ${sourceCommit}; skipping npm publish.`);
    return { published: false, version, sourceCommit };
  }

  assert.equal(response.status, 404, `npm registry lookup failed with HTTP ${response.status}.`);
  publish();
  return { published: true, version, sourceCommit };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await publishNpmRelease();
}
