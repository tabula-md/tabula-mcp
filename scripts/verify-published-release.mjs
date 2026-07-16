import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const expectedAssets = new Set([
  `tabula-mcp-${version}.mcpb`,
  `tabula-mcp-${version}.mcpb.sha256`,
  "tabula-mcp.mcpb",
  "tabula-mcp.mcpb.sha256",
]);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let publishedPackage;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  const response = await fetch(`https://registry.npmjs.org/%40tabula-md%2Fmcp/${version}`);
  if (response.ok) {
    publishedPackage = await response.json();
    break;
  }
  if (attempt < 12) {
    await sleep(5_000);
  }
}

assert(publishedPackage, `@tabula-md/mcp@${version} did not appear on npm within 60 seconds.`);
assert.equal(publishedPackage.version, version);
assert.equal(publishedPackage.description, packageJson.description);
assert.equal(publishedPackage.repository?.url, packageJson.repository.url);

const releaseResponse = await fetch(`https://api.github.com/repos/tabula-md/tabula-mcp/releases/tags/${tag}`, {
  headers: {
    accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    "x-github-api-version": "2026-03-10",
  },
});
assert.equal(releaseResponse.status, 200, `GitHub Release ${tag} was not available.`);
const release = await releaseResponse.json();
const actualAssets = new Set(release.assets?.map((asset) => asset.name));

for (const asset of expectedAssets) {
  assert.ok(actualAssets.has(asset), `GitHub Release ${tag} is missing ${asset}.`);
}

console.log(`Published npm package and GitHub Release verified for ${tag}`);
