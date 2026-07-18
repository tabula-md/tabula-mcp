import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const releaseManifest = JSON.parse(await readFile("dist/release-manifest.json", "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const expectedAssets = new Set([
  `tabula-mcp-${version}.mcpb`,
  `tabula-mcp-${version}.mcpb.sha256`,
  "tabula-mcp.mcpb",
  "tabula-mcp.mcpb.sha256",
  "release-manifest.json",
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

const manifestAsset = release.assets.find((asset) => asset.name === "release-manifest.json");
const manifestResponse = await fetch(manifestAsset.browser_download_url, {
  headers: process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
});
assert.equal(manifestResponse.status, 200, "Published release manifest could not be downloaded.");
const publishedManifest = await manifestResponse.json();
assert.equal(publishedManifest.releaseVersion, version);
assert.equal(publishedManifest.releaseTag, tag);
assert.equal(publishedManifest.sourceCommit, releaseManifest.sourceCommit);

const healthUrl = new URL(releaseManifest.worker.healthPath, releaseManifest.worker.origin);
let productionHealth;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  const response = await fetch(healthUrl);
  if (response.ok) {
    const health = await response.json();
    if (health.ok === true && health.version === version) {
      productionHealth = health;
      break;
    }
  }
  if (attempt < 12) await sleep(5_000);
}
assert(productionHealth, `Production health did not report Tabula MCP ${version} within 60 seconds.`);
assert.equal(productionHealth.service, releaseManifest.worker.name);

const readyUrl = new URL(releaseManifest.worker.readyPath, releaseManifest.worker.origin);
let productionReady;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  const response = await fetch(readyUrl);
  if (response.ok) {
    const ready = await response.json();
    if (ready.ok === true && ready.version === version) {
      productionReady = ready;
      break;
    }
  }
  if (attempt < 12) await sleep(5_000);
}
assert(productionReady, `Production readiness did not report Tabula MCP ${version} within 60 seconds.`);

const mcpUrl = new URL(releaseManifest.worker.mcpPath, releaseManifest.worker.origin);
const client = new Client({ name: "tabula-release-verifier", version });
try {
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "list_files"), "Production MCP tools/list did not expose list_files.");
  assert(tools.tools.some((tool) => tool.name === "export_copy"), "Production MCP tools/list did not expose export_copy.");
} finally {
  await client.close();
}

console.log(`Published npm package, GitHub Release, production readiness, and MCP handshake verified for ${tag}`);
