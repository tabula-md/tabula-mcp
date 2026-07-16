import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));

const packageJson = await readJson("package.json");
const manifest = await readJson("mcpb/manifest.json");
const plugin = await readJson("plugins/tabula-mcp/.claude-plugin/plugin.json");
const mcpConfig = await readJson("plugins/tabula-mcp/.mcp.json");
const privacyPolicy = await readFile(path.join(rootDir, "PRIVACY.md"), "utf8");
const readme = await readFile(path.join(rootDir, "README.md"), "utf8");
const submissionGuide = await readFile(path.join(rootDir, "docs/directory-submission.md"), "utf8");

assert.equal(manifest.version, packageJson.version, "MCPB version must match the npm package version.");
assert.equal(plugin.version, packageJson.version, "Claude Code plugin version must match the npm package version.");
assert.deepEqual(mcpConfig.mcpServers?.tabula?.args, ["-y", `@tabula-md/mcp@${packageJson.version}`]);
assert.ok(packageJson.repository?.url?.includes("github.com/tabula-md/tabula-mcp"), "npm repository metadata must identify this source repository.");
assert.ok(packageJson.homepage?.startsWith("https://"), "npm homepage must use HTTPS.");
assert.ok(packageJson.bugs?.url?.startsWith("https://"), "npm support URL must use HTTPS.");
assert.ok(Array.isArray(manifest.privacy_policies) && manifest.privacy_policies.length > 0, "MCPB needs a privacy policy URL.");
for (const policyUrl of manifest.privacy_policies) {
  assert.ok(/^https:\/\//.test(policyUrl), `Privacy policy must use HTTPS: ${policyUrl}`);
}
assert.deepEqual(manifest.privacy_policies, ["https://mcp.tabula.md/privacy"], "MCPB must use the official hosted privacy policy URL.");
assert.match(privacyPolicy, /^# Tabula\.md MCP Privacy Policy$/m, "Privacy policy needs a product heading.");
assert.match(privacyPolicy, /retention/i, "Privacy policy must explain retention.");
assert.match(privacyPolicy, /contact/i, "Privacy policy must provide a contact path.");
assert.match(readme, /^## Privacy Policy$/m, "README must link users to the privacy policy.");
assert.match(submissionGuide, /Paired user prompt/, "Directory submission guide must pair screenshots with prompts.");
assert.match(submissionGuide, /https:\/\/mcp\.tabula\.md\/mcp/, "Directory submission guide must name the production MCP endpoint.");
assert.match(submissionGuide, /Desktop extension submission/, "Directory submission guide must cover the MCPB submission route.");

for (const screenshot of [
  "assets/directory/document-preview.png",
  "assets/directory/document-editor.png",
  "assets/directory/room-context.png",
]) {
  await access(path.join(rootDir, screenshot));
}

console.log("Directory submission readiness check passed");
