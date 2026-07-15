import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));

const packageJson = await readJson("package.json");
const marketplace = await readJson(".claude-plugin/marketplace.json");
const plugin = await readJson("plugins/tabula-mcp/.claude-plugin/plugin.json");
const mcpConfig = await readJson("plugins/tabula-mcp/.mcp.json");

assert.equal(marketplace.name, "tabula-md", "Marketplace name must stay stable for installed users.");
assert.equal(marketplace.owner?.name, "Tabula.md", "Marketplace owner name must be present.");

const marketplacePlugin = marketplace.plugins?.find((candidate) => candidate.name === "tabula-mcp");
assert.ok(marketplacePlugin, "Marketplace must include the tabula-mcp plugin.");
assert.equal(marketplacePlugin.source, "./plugins/tabula-mcp", "tabula-mcp source must stay inside this marketplace.");

assert.equal(plugin.name, "tabula-mcp", "Plugin name must match the marketplace entry.");
assert.equal(plugin.version, packageJson.version, "Plugin version must match the published MCP package version.");
assert.equal(plugin.author?.name, "Tabula.md", "Plugin author name must be present.");

const tabulaServer = mcpConfig.mcpServers?.tabula;
assert.equal(tabulaServer?.command, "npx", "Claude Code plugin must launch the published package through npx.");
assert.deepEqual(tabulaServer?.args, ["-y", `@tabula-md/mcp@${packageJson.version}`]);

console.log("Claude Code marketplace configuration check passed");
