import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/release.yml", "utf8");

for (const required of [
  '      - "v*"',
  "contents: write",
  "id-token: write",
  "actions/checkout@v6",
  "actions/setup-node@v6",
  "node-version: 24",
  "package-manager-cache: false",
  "npm install --global npm@latest",
  'node scripts/check-release-contract.mjs --tag "$GITHUB_REF_NAME"',
  "npm run release:verify",
  "npm publish --access public --ignore-scripts",
  "gh release create",
  "dist/tabula-mcp.mcpb",
  "scripts/verify-published-release.mjs",
]) {
  assert.ok(workflow.includes(required), `Release workflow is missing: ${required}`);
}

assert.ok(!workflow.includes("NPM_TOKEN"), "Trusted publishing must not depend on a long-lived npm token.");

console.log("Release workflow contract passed");
