import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/release.yml", "utf8");
const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");

for (const required of [
  '      - "v*"',
  "contents: write",
  "id-token: write",
  "actions/checkout@v6",
  "actions/setup-node@v6",
  "node-version: 24",
  "package-manager-cache: false",
  "npm install --global npm@latest",
  "scripts/export-release-manifest.mjs",
  "scripts/check-release-secrets.mjs",
  'node scripts/check-release-contract.mjs --tag "$GITHUB_REF_NAME"',
  "npm run release:verify",
  "steps.manifest.outputs.tabula_md_ref",
  "steps.manifest.outputs.tabula_room_ref",
  "steps.manifest.outputs.tabula_json_ref",
  "scripts/check-interoperability-checkouts.mjs",
  "build:release-manifest",
  "npm publish --access public --ignore-scripts",
  "gh release create",
  "dist/tabula-mcp.mcpb",
  "dist/release-manifest.json",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "npm run deploy:cloudflare",
  "scripts/verify-published-release.mjs",
]) {
  assert.ok(workflow.includes(required), `Release workflow is missing: ${required}`);
}

assert.ok(!workflow.includes("NPM_TOKEN"), "Trusted publishing must not depend on a long-lived npm token.");

for (const required of [
  "scripts/export-release-manifest.mjs",
  "steps.manifest.outputs.tabula_md_ref",
  "steps.manifest.outputs.tabula_room_ref",
  "steps.manifest.outputs.tabula_json_ref",
  "scripts/check-interoperability-checkouts.mjs",
]) {
  assert.ok(ciWorkflow.includes(required), `CI workflow is missing pinned interoperability input: ${required}`);
}

console.log("Release workflow contract passed");
