import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relativePath) => readFile(path.join(rootDir, relativePath), "utf8");
const readJson = async (relativePath) => JSON.parse(await readText(relativePath));
const tagIndex = process.argv.indexOf("--tag");
const suppliedTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;

if (tagIndex >= 0) {
  assert(suppliedTag, "--tag requires a release tag value.");
}

const packageJson = await readJson("package.json");
const manifest = await readJson("mcpb/manifest.json");
const plugin = await readJson("plugins/tabula-mcp/.claude-plugin/plugin.json");
const mcpConfig = await readJson("plugins/tabula-mcp/.mcp.json");
const sourceVersion = await readText("src/version.ts");
const appSource = await readText("src/app/document-app.js");
const changelog = await readText("CHANGELOG.md");
const version = packageJson.version;
const expectedTag = `v${version}`;

assert.match(version, /^\d+\.\d+\.\d+$/, "Package version must be semver without a prefix.");
assert.equal(manifest.version, version, "MCPB manifest version must match package.json.");
assert.equal(plugin.version, version, "Claude Code plugin version must match package.json.");
assert.deepEqual(
  mcpConfig.mcpServers?.tabula?.args,
  ["-y", `@tabula-md/mcp@${version}`],
  "Claude Code must pin the package version being released.",
);
assert.match(sourceVersion, new RegExp(`TABULA_MCP_VERSION = ["']${version.replaceAll(".", "\\.")}["']`));
assert.match(appSource, new RegExp(`name: ["']Tabula Handoff["'], version: ["']${version.replaceAll(".", "\\.")}["']`));
assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"), "Changelog must contain the release version.");
assert.equal(packageJson.publishConfig?.access, "public", "npm package must remain public.");
assert.equal(packageJson.publishConfig?.provenance, true, "npm provenance must remain enabled.");
assert.equal(
  packageJson.repository?.url,
  "git+https://github.com/tabula-md/tabula-mcp.git",
  "Trusted publishing requires the canonical GitHub repository URL.",
);

if (suppliedTag) {
  assert.equal(suppliedTag, expectedTag, `Release tag must be ${expectedTag}.`);
}

console.log(`Release contract passed for ${expectedTag}`);
